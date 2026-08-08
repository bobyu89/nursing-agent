/**
 * engine.js — 確定性決策引擎
 *
 * 設計原則：確定性歸程式、語言歸模型。
 * 本檔所有計算（工時、班距、連續天數、資格比對、評分）皆為確定性運算，
 * 完全不經過語言模型。算錯工時在醫療場域是合規事故，不能交給模型。
 *
 * 語言模型只負責 src/llm.js 內的四件事：解析通報訊息、追問缺漏、
 * 把本檔算出的結果寫成人話、生成主管摘要與通知草稿。
 *
 * 引擎以 createEngine(db) 建立，所有人員／班表／規則資料由外部注入，
 * 引擎本身不讀取任何全域資料——同一份程式碼可以在瀏覽器、測試頁
 * （tests.html）與未來的 Lambda 端點上運行，不需改寫。
 *
 * 週工時一律以「缺班日所在的自然週（週一至週日）」計算，
 * 不綁定示範資料的那一週。
 */

/* ── 日期／時間工具（純函式）───────────────────────────── */

const WEEKDAY_TW = ['日', '一', '二', '三', '四', '五', '六'];

function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

function weekdayOf(dateStr) {
  return WEEKDAY_TW[parseDate(dateStr).getDay()];
}

function shortDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 該日期所在的自然週（週一起算）之 7 個日期 */
function weekDatesOf(dateStr) {
  const dow = (parseDate(dateStr).getDay() + 6) % 7; // 週一 = 0
  const monday = addDays(dateStr, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

const HOUR_MS = 3600 * 1000;

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

/* ── 引擎工廠 ───────────────────────────────────────────── */

/**
 * @param {object} db 引擎所需的全部資料，皆以參照傳入：
 *   staff      人員主檔（可變：applyReplacement 會累計替補次數）
 *   shifts     班表（可變：applyReplacement 會寫入替補班次）
 *   shiftTypes 班別定義
 *   roleLevels 職務層級
 *   certs      資格代碼 → 名稱
 *   units      單位代碼 → 名稱
 *   registry   規則庫（可變：規則庫設定頁的調整即時生效）
 */
function createEngine(db) {

  /* ── 規則庫存取 ── */

  function getHardRule(code) {
    return db.registry.hard.find((r) => r.code === code);
  }

  function getHardParam(code, fallback) {
    const rule = getHardRule(code);
    return rule && rule.param ? rule.param.value : fallback;
  }

  function getSoftParam(code, fallback) {
    const rule = db.registry.soft.find((r) => r.code === code);
    return rule && rule.param ? rule.param.value : fallback;
  }

  function getSoftWeight(code) {
    const rule = db.registry.soft.find((r) => r.code === code);
    return rule ? rule.weight : 0;
  }

  function totalSoftWeight() {
    return db.registry.soft.reduce((sum, r) => sum + r.weight, 0);
  }

  /**
   * 把「日期 + 班別」換算成實際的起訖時間。
   * 大夜班跨日：23:00 出勤，隔日 07:00 下班。
   */
  function shiftInterval(dateStr, shiftCode) {
    const type = db.shiftTypes[shiftCode];
    const [sh, sm] = type.start.split(':').map(Number);
    const [eh, em] = type.end.split(':').map(Number);
    const start = parseDate(dateStr);
    start.setHours(sh, sm, 0, 0);
    const end = parseDate(dateStr);
    end.setHours(eh, em, 0, 0);
    if (type.overnight) end.setDate(end.getDate() + 1);
    return { start, end };
  }

  /* ── 人員狀態查詢 ── */

  function shiftsOf(staffId) {
    return db.shifts.filter((s) => s.staffId === staffId);
  }

  function isOnLeave(staff, dateStr) {
    return staff.leaves.some((lv) => dateStr >= lv.from && dateStr <= lv.to);
  }

  function leaveOn(staff, dateStr) {
    return staff.leaves.find((lv) => dateStr >= lv.from && dateStr <= lv.to);
  }

  /** refDate 所在自然週的已排定工時（小時） */
  function weeklyHours(staffId, refDate) {
    const week = weekDatesOf(refDate);
    return shiftsOf(staffId)
      .filter((s) => week.includes(s.date))
      .reduce((sum, s) => sum + db.shiftTypes[s.shift].hours, 0);
  }

  /** refDate 所在自然週的各班別次數，用於 S3 班別型態相符 */
  function shiftMix(staffId, refDate) {
    const week = weekDatesOf(refDate);
    const mix = { D: 0, E: 0, N: 0, total: 0 };
    shiftsOf(staffId)
      .filter((s) => week.includes(s.date))
      .forEach((s) => { mix[s.shift] = (mix[s.shift] || 0) + 1; mix.total += 1; });
    return mix;
  }

  /**
   * 替補後的連續上班天數。
   * 由缺班日往前、往後各展開，計算包含缺班日在內的連續區段長度。
   */
  function consecutiveDaysWithGap(staffId, gapDate) {
    const worked = new Set(shiftsOf(staffId).map((s) => s.date));
    let count = 1;
    let cursor = addDays(gapDate, -1);
    while (worked.has(cursor)) { count += 1; cursor = addDays(cursor, -1); }
    cursor = addDays(gapDate, 1);
    while (worked.has(cursor)) { count += 1; cursor = addDays(cursor, 1); }
    return count;
  }

  /**
   * 替補後與既有班次的最短班間休息時數。
   * 回傳 { hours, against } —— against 為造成最短間隔的那一筆班次。
   * 若與既有班次時間重疊，hours 為負值。
   * excludeDates：略過這些日期的班次（同日重複排班已由 H2 負責，避免同一件事被報兩次）
   */
  function minRestAfterGap(staffId, gapDate, gapShift, excludeDates = []) {
    const gap = shiftInterval(gapDate, gapShift);
    let best = null;
    shiftsOf(staffId).filter((s) => !excludeDates.includes(s.date)).forEach((s) => {
      const iv = shiftInterval(s.date, s.shift);
      let hours;
      if (iv.end <= gap.start) hours = (gap.start - iv.end) / HOUR_MS;
      else if (gap.end <= iv.start) hours = (iv.start - gap.end) / HOUR_MS;
      else hours = -1; // 時間重疊
      if (best === null || hours < best.hours) best = { hours, against: s };
    });
    return best || { hours: Infinity, against: null };
  }

  /* ── 硬性約束檢查 ── */

  function checkHardConstraints(staff, gap) {
    const violations = [];

    // H1 職務與資格
    if (getHardRule('H1').enabled) {
      const need = db.roleLevels[gap.requiredRole];
      const have = db.roleLevels[staff.role];
      if (have < need) {
        violations.push({ code: 'H1', detail: `職務層級不符：${staff.role} 未達「${gap.requiredRole}」以上` });
      }
      gap.requiredCerts.forEach((c) => {
        const expiry = staff.certs[c];
        if (!expiry) {
          violations.push({ code: 'H1', detail: `未具備必要資格：${db.certs[c]}` });
        } else if (expiry < gap.date) {
          violations.push({ code: 'H1', detail: `${db.certs[c]} 證照已於 ${expiry} 到期` });
        }
      });
    }

    // H2 當日已排其他班別
    if (getHardRule('H2').enabled) {
      const same = shiftsOf(staff.id).find((s) => s.date === gap.date);
      if (same) {
        violations.push({
          code: 'H2',
          detail: `當日已排 ${db.shiftTypes[same.shift].name}（${db.shiftTypes[same.shift].start}–${db.shiftTypes[same.shift].end}）`,
        });
      }
    }

    // H3 請假中
    if (getHardRule('H3').enabled && isOnLeave(staff, gap.date)) {
      const lv = leaveOn(staff, gap.date);
      violations.push({ code: 'H3', detail: `${lv.type}中（${lv.from} – ${lv.to}）` });
    }

    // H4 班間休息（同日重複排班交給 H2，這裡只看不同日期的鄰近班次）
    if (getHardRule('H4').enabled) {
      const minRest = getHardParam('H4', 11);
      const skip = getHardRule('H2').enabled ? [gap.date] : [];
      const rest = minRestAfterGap(staff.id, gap.date, gap.shift, skip);
      if (rest.against && rest.hours < minRest) {
        const s = rest.against;
        const label = `${shortDate(s.date)} ${db.shiftTypes[s.shift].name}`;
        violations.push({
          code: 'H4',
          detail: rest.hours < 0
            ? `與 ${label} 時間重疊`
            : `與 ${label} 僅間隔 ${rest.hours} 小時，未達 ${minRest} 小時`,
        });
      }
    }

    // H5 連續上班天數
    if (getHardRule('H5').enabled) {
      const maxDays = getHardParam('H5', 6);
      const days = consecutiveDaysWithGap(staff.id, gap.date);
      if (days > maxDays) {
        violations.push({ code: 'H5', detail: `替補後將連續上班 ${days} 天，超過上限 ${maxDays} 天` });
      }
    }

    // H6 週工時絕對上限（以缺班日所在自然週計）
    if (getHardRule('H6').enabled) {
      const cap = getHardParam('H6', 60);
      const projected = weeklyHours(staff.id, gap.date) + db.shiftTypes[gap.shift].hours;
      if (projected > cap) {
        violations.push({ code: 'H6', detail: `替補後當週工時 ${projected} 小時，超過絕對上限 ${cap} 小時` });
      }
    }

    return violations;
  }

  /* ── 軟性加權評分 ── */

  function scoreCandidate(staff, gap) {
    const breakdown = [];

    // S1 班別分配公平性
    const saturation = getSoftParam('S1', 5);
    const s1Ratio = clamp01(1 - staff.standbyCount30d / saturation);
    breakdown.push({
      code: 'S1', name: '班別分配公平性', weight: getSoftWeight('S1'),
      ratio: s1Ratio, points: round1(s1Ratio * getSoftWeight('S1')),
      evidence: `近 30 天已被叫班 ${staff.standbyCount30d} 次（飽和門檻 ${saturation} 次）`,
    });

    // S2 工時餘裕（以缺班日所在自然週計）
    const softCap = getSoftParam('S2', 48);
    const base = weeklyHours(staff.id, gap.date);
    const projected = base + db.shiftTypes[gap.shift].hours;
    const s2Ratio = clamp01((softCap - projected) / 16);
    breakdown.push({
      code: 'S2', name: '工時餘裕', weight: getSoftWeight('S2'),
      ratio: s2Ratio, points: round1(s2Ratio * getSoftWeight('S2')),
      evidence: `缺班當週已排 ${base} 小時，替補後 ${projected} 小時（軟性上限 ${softCap} 小時）`,
    });

    // S3 班別型態相符（以缺班日所在自然週計）
    const mix = shiftMix(staff.id, gap.date);
    const s3Ratio = mix.total === 0 ? 0.5 : (mix[gap.shift] || 0) / mix.total;
    breakdown.push({
      code: 'S3', name: '班別型態相符', weight: getSoftWeight('S3'),
      ratio: s3Ratio, points: round1(s3Ratio * getSoftWeight('S3')),
      evidence: mix.total === 0
        ? '缺班當週無既有班別，以中間值計'
        : `缺班當週 ${mix.total} 個班中有 ${mix[gap.shift] || 0} 個${db.shiftTypes[gap.shift].name}`,
    });

    // S4 可支援意願
    let s4Ratio, s4Evidence;
    if (staff.willingShifts === null) {
      s4Ratio = 0.5; s4Evidence = '未表態願意支援之班別，以中間值計';
    } else if (staff.willingShifts.includes(gap.shift)) {
      s4Ratio = 1; s4Evidence = `已自填願意支援${db.shiftTypes[gap.shift].name}`;
    } else {
      s4Ratio = 0;
      s4Evidence = `自填願意支援 ${staff.willingShifts.map((c) => db.shiftTypes[c].name).join('、')}，不含${db.shiftTypes[gap.shift].name}`;
    }
    breakdown.push({
      code: 'S4', name: '可支援意願', weight: getSoftWeight('S4'),
      ratio: s4Ratio, points: round1(s4Ratio * getSoftWeight('S4')), evidence: s4Evidence,
    });

    // S5 單位熟悉度
    let s5Ratio, s5Evidence;
    if (staff.unit === gap.unit) {
      s5Ratio = 1; s5Evidence = `本單位人員（${db.units[gap.unit]}）`;
    } else if (staff.familiarUnits.includes(gap.unit)) {
      s5Ratio = 0.6; s5Evidence = `隸屬 ${db.units[staff.unit]}，曾支援過 ${db.units[gap.unit]}`;
    } else {
      s5Ratio = 0; s5Evidence = `隸屬 ${db.units[staff.unit]}，無 ${db.units[gap.unit]} 支援紀錄`;
    }
    breakdown.push({
      code: 'S5', name: '單位熟悉度', weight: getSoftWeight('S5'),
      ratio: s5Ratio, points: round1(s5Ratio * getSoftWeight('S5')), evidence: s5Evidence,
    });

    const total = round1(breakdown.reduce((sum, b) => sum + b.points, 0));
    return { breakdown, total, maxTotal: totalSoftWeight(), base, projected };
  }

  /* ── 風險標記 ── */

  function collectFlags(staff, gap, score) {
    const flags = [];
    const softCap = getSoftParam('S2', 48);

    if (score.projected > softCap) {
      flags.push({
        code: 'F1', level: 'high', needsApproval: true,
        text: `替補後當週工時 ${score.projected} 小時，超過軟性上限 ${softCap} 小時，需單位主管額外核准`,
      });
    }
    const days = consecutiveDaysWithGap(staff.id, gap.date);
    if (days >= 5) {
      flags.push({ code: 'F2', level: 'medium', needsApproval: false, text: `替補後將連續上班 ${days} 天` });
    }
    if (staff.unit !== gap.unit) {
      flags.push({
        code: 'F3', level: 'medium', needsApproval: false,
        text: `跨單位支援（${db.units[staff.unit]} → ${db.units[gap.unit]}），需加強交班`,
      });
    }
    if (staff.standbyCount30d >= 3) {
      flags.push({
        code: 'F4', level: 'low', needsApproval: false,
        text: `近 30 天已被叫班 ${staff.standbyCount30d} 次，持續指派將影響班別分配公平性`,
      });
    }
    return flags;
  }

  /* ── 主流程 ── */

  /**
   * 對單一缺班事件評估所有人員。
   * @returns {{candidates: Array, excluded: Array, gap: object}}
   */
  function evaluateGap(gap) {
    const candidates = [];
    const excluded = [];

    db.staff.forEach((staff) => {
      // 原班人員一律不列入候選，但仍完整跑一次硬性檢查，讓排除原因據實呈現
      const isOriginal = staff.id === gap.originalStaffId;
      const violations = checkHardConstraints(staff, gap);
      if (isOriginal) {
        violations.unshift({ code: '—', detail: '本次缺班之原班人員', neutral: true });
        excluded.push({ staff, violations, isOriginal: true });
        return;
      }
      if (violations.length > 0) {
        excluded.push({ staff, violations, isOriginal: false });
      } else {
        const score = scoreCandidate(staff, gap);
        const flags = collectFlags(staff, gap, score);
        candidates.push({
          staff, score, flags,
          consecutiveDays: consecutiveDaysWithGap(staff.id, gap.date),
          restHours: minRestAfterGap(staff.id, gap.date, gap.shift).hours,
          needsApproval: flags.some((f) => f.needsApproval),
        });
      }
    });

    candidates.sort((a, b) => b.score.total - a.score.total);
    candidates.forEach((c, i) => { c.rank = i + 1; });

    return { candidates, excluded, gap };
  }

  /**
   * 升級路徑分析：候選人不足時，逐條試算「放寬哪一條硬性約束會多出誰」。
   * Agent 只做試算與提示，絕不自行放寬——是否放寬由授權主管決定。
   */
  function relaxationAnalysis(gap) {
    const baseIds = new Set(evaluateGap(gap).candidates.map((c) => c.staff.id));
    const options = [];
    db.registry.hard.forEach((rule) => {
      if (!rule.enabled) return;
      rule.enabled = false;
      const unlocked = evaluateGap(gap).candidates
        .map((c) => c.staff.id)
        .filter((id) => !baseIds.has(id));
      rule.enabled = true;
      if (unlocked.length > 0) {
        options.push({
          code: rule.code, name: rule.name, basis: rule.basis,
          relax: rule.relax || { allowed: true, note: '' },
          unlocked,
        });
      }
    });
    // 可放寬的排前面，法定/病安下限排後面並標示不建議
    options.sort((a, b) => Number(b.relax.allowed) - Number(a.relax.allowed));
    return options;
  }

  /**
   * 主管確認後寫回：把替補班次寫入班表，並累計該人員的替補次數。
   * 這使得同一場 demo 連續處理多筆缺班時，公平性訊號會真實累積。
   */
  function applyReplacement(gap, staffId) {
    db.shifts.push({ staffId, date: gap.date, shift: gap.shift, unit: gap.unit, isReplacement: true });
    const s = db.staff.find((x) => x.id === staffId);
    if (s) s.standbyCount30d += 1;
  }

  /**
   * 缺班班別的單位人力狀態：目前在班人數、替補後人數、最低配置。
   * min 為 null 代表該單位未設定最低配置（不做判定）。
   */
  function unitCoverage(gap) {
    const current = db.shifts.filter(
      (s) => s.date === gap.date && s.unit === gap.unit && s.shift === gap.shift).length;
    const byUnit = db.staffingMin ? db.staffingMin[gap.unit] : null;
    const min = byUnit && typeof byUnit[gap.shift] === 'number' ? byUnit[gap.shift] : null;
    return { current, afterReplacement: current + 1, min };
  }

  /** 替補後的班表變化（僅影響缺班當日該單位） */
  function scheduleDelta(gap, staffId) {
    const dayShifts = db.shifts.filter((s) => s.date === gap.date && s.unit === gap.unit);
    return {
      date: gap.date,
      unit: gap.unit,
      before: dayShifts.map((s) => ({ staffId: s.staffId, shift: s.shift })),
      added: { staffId, shift: gap.shift },
      removedStaffId: gap.originalStaffId,
    };
  }

  return {
    evaluateGap, relaxationAnalysis, applyReplacement, scheduleDelta,
    checkHardConstraints, scoreCandidate, collectFlags,
    weeklyHours, shiftMix, isOnLeave, consecutiveDaysWithGap,
    minRestAfterGap, shiftInterval, unitCoverage,
  };
}

/* 讓測試頁（tests.html）以外的環境（如 Node）也能載入 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createEngine, parseDate, formatDate, addDays, weekdayOf,
    shortDate, weekDatesOf, WEEKDAY_TW,
  };
}
