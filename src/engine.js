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

/**
 * 嚴格日曆驗證：格式正確且真實存在的日期才通過。
 * 「2026-02-31」「2026-13-01」格式看似正確，但 JS Date 會自動進位成別的日期，
 * 引擎的字串比對（H2、週工時）與日期運算會因此各算各的——必須在入口擋下。
 */
function isValidDateStr(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 該日期所在的自然週（週一起算）之 7 個日期 */
function weekDatesOf(dateStr) {
  const dow = (parseDate(dateStr).getDay() + 6) % 7; // 週一 = 0
  const monday = addDays(dateStr, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * 四週彈性工時的「固定週期」劃分（勞基法第 30 條之 1）。
 * 週期不是滾動窗口：自錨點（雇主公告的週期起始日）起每 periodDays 天一期，
 * 勞檢即以固定週期核對。Math.round 吸收跨日光節約時區的毫秒誤差；
 * 負索引（錨點之前的日期）由 Math.floor 正確歸入前面的週期。
 */
function cycleStartOf(dateStr, periodDays, anchor) {
  const diff = Math.round((parseDate(dateStr) - parseDate(anchor)) / DAY_MS);
  return addDays(anchor, Math.floor(diff / periodDays) * periodDays);
}

/** 該日期所屬固定週期的全部日期 */
function cycleDatesOf(dateStr, periodDays, anchor) {
  const start = cycleStartOf(dateStr, periodDays, anchor);
  return Array.from({ length: periodDays }, (_, i) => addDays(start, i));
}

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
   * 四週彈性工時週期錨點：由資料層注入（院方行事曆公告的週期起始日）。
   * 未注入時退回 1970-01-05（週一的中性紀元），任何日期都能穩定歸期，
   * 但正式導入時必須注入真實錨點，否則週期劃分與院方公告不一致。
   */
  function flexAnchor() {
    return db.flexCycleAnchor || '1970-01-05';
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

  /** 個人限制（H10）：日期落在限制期間且班別在受限清單內時回傳該筆限制 */
  function restrictionOn(staff, dateStr, shiftCode) {
    return (staff.restrictions || []).find((r) =>
      dateStr >= r.from && dateStr <= r.to && r.shifts.includes(shiftCode));
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

    // H10 個人限制班別（母性保護等法定禁止與醫囑限制，登錄於人員主檔）
    const h10 = getHardRule('H10');
    if (h10 && h10.enabled) {
      const restr = restrictionOn(staff, gap.date, gap.shift);
      if (restr) {
        violations.push({ code: 'H10',
          detail: `個人限制：${restr.reason}（${restr.from} – ${restr.to} 不得排${restr.shifts.map((c) => db.shiftTypes[c].name).join('、')}）` });
      }
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

    /* ── 四週彈性工時（勞基法第 30 條之 1；固定週期制，錨點由資料層注入）──
     * H7 雙週例假／H8 四週工時總量／H9 四週休息日總量。
     * 「已排班日集合 + 缺班日」的天數計算刻意用 Set：同一日多筆班次
     * （H2 停用時可能出現）只算一天，工時則照實累計。 */

    // H7 每二週內至少 N 日例假
    const h7 = getHardRule('H7');
    if (h7 && h7.enabled) {
      const minRest = getHardParam('H7', 2);
      const period = cycleDatesOf(gap.date, 14, flexAnchor());
      const worked = new Set(shiftsOf(staff.id).filter((s) => period.includes(s.date)).map((s) => s.date));
      worked.add(gap.date);
      const off = 14 - worked.size;
      if (off < minRest) {
        violations.push({
          code: 'H7',
          detail: `替補後二週週期（${shortDate(period[0])}–${shortDate(period[13])}）僅餘 ${off} 日例假，未達法定 ${minRest} 日`,
        });
      }
    }

    // H8 每四週正常工時總量上限
    const h8 = getHardRule('H8');
    if (h8 && h8.enabled) {
      const cap = getHardParam('H8', 160);
      const period = cycleDatesOf(gap.date, 28, flexAnchor());
      const hours = shiftsOf(staff.id)
        .filter((s) => period.includes(s.date))
        .reduce((sum, s) => sum + db.shiftTypes[s.shift].hours, 0) + db.shiftTypes[gap.shift].hours;
      if (hours > cap) {
        violations.push({
          code: 'H8',
          detail: `替補後四週週期（${shortDate(period[0])}–${shortDate(period[27])}）工時 ${hours} 小時，超過正常工時總量 ${cap} 小時`,
        });
      }
    }

    // H9 每四週內例假＋休息日至少 N 日
    const h9 = getHardRule('H9');
    if (h9 && h9.enabled) {
      const minOff = getHardParam('H9', 8);
      const period = cycleDatesOf(gap.date, 28, flexAnchor());
      const worked = new Set(shiftsOf(staff.id).filter((s) => period.includes(s.date)).map((s) => s.date));
      worked.add(gap.date);
      const off = 28 - worked.size;
      if (off < minOff) {
        violations.push({
          code: 'H9',
          detail: `替補後四週週期（${shortDate(period[0])}–${shortDate(period[27])}）僅餘 ${off} 日例假與休息日，未達法定 ${minOff} 日`,
        });
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
   * 主動預警：對「已排定的班表」做靜態掃描，不等有人請假才發現風險。
   * 門檻全部取自規則庫（與 H4/H5/H6/S1/S2 同一份參數）。
   * 回傳依嚴重度排序：high（已違規）→ medium（已達門檻）→ low（接近門檻）。
   */
  function rosterWarnings() {
    const warnings = [];
    const maxDays = getHardParam('H5', 6);
    const minRest = getHardParam('H4', 11);
    const softCap = getSoftParam('S2', 48);
    const hardCap = getHardParam('H6', 60);
    const saturation = getSoftParam('S1', 5);
    const biweekRest = getHardParam('H7', 2);
    const fourWeekCap = getHardParam('H8', 160);
    const fourWeekOff = getHardParam('H9', 8);

    db.staff.forEach((staff) => {
      const ss = shiftsOf(staff.id).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
      if (ss.length === 0) return;

      // 連續上班區段（已排定的最長連續天數）
      let run = 1, maxRun = 1, runEnd = ss[0].date;
      for (let i = 1; i < ss.length; i++) {
        run = ss[i].date === addDays(ss[i - 1].date, 1) ? run + 1 : 1;
        if (run > maxRun) { maxRun = run; runEnd = ss[i].date; }
      }
      if (maxRun > maxDays) {
        warnings.push({ level: 'high', code: 'H5', staffId: staff.id,
          text: `已排定連續上班 ${maxRun} 天（至 ${shortDate(runEnd)}），超過上限 ${maxDays} 天` });
      } else if (maxRun === maxDays) {
        warnings.push({ level: 'medium', code: 'H5', staffId: staff.id,
          text: `已排定連續上班 ${maxRun} 天（至 ${shortDate(runEnd)}），達上限——再排一天即違規` });
      }

      // 相鄰班次的班間休息
      for (let i = 1; i < ss.length; i++) {
        const prevEnd = shiftInterval(ss[i - 1].date, ss[i - 1].shift).end;
        const curStart = shiftInterval(ss[i].date, ss[i].shift).start;
        const hours = (curStart - prevEnd) / HOUR_MS;
        if (hours < minRest) {
          warnings.push({ level: 'high', code: 'H4', staffId: staff.id,
            text: `${shortDate(ss[i - 1].date)} ${db.shiftTypes[ss[i - 1].shift].name}接 ${shortDate(ss[i].date)} ${db.shiftTypes[ss[i].shift].name}，間隔僅 ${hours} 小時（法定 ${minRest}）` });
        }
      }

      // H10 個人限制：已排定的班次落在限制期間（如妊娠期間排了大夜）——不是風險，是現在就違法
      ss.forEach((s) => {
        const restr = restrictionOn(staff, s.date, s.shift);
        if (restr) {
          warnings.push({ level: 'high', code: 'H10', staffId: staff.id,
            text: `${shortDate(s.date)} 排定${db.shiftTypes[s.shift].name}，落在個人限制期間（${restr.reason}）` });
        }
      });

      // 各自然週的已排工時
      const weeks = {};
      ss.forEach((s) => {
        const wk = weekDatesOf(s.date)[0];
        weeks[wk] = (weeks[wk] || 0) + db.shiftTypes[s.shift].hours;
      });
      Object.keys(weeks).forEach((wk) => {
        if (weeks[wk] > hardCap) {
          warnings.push({ level: 'high', code: 'H6', staffId: staff.id,
            text: `${shortDate(wk)} 起當週已排 ${weeks[wk]} 小時，超過絕對上限 ${hardCap} 小時` });
        } else if (weeks[wk] >= softCap) {
          warnings.push({ level: 'medium', code: 'F1', staffId: staff.id,
            text: `${shortDate(wk)} 起當週已排 ${weeks[wk]} 小時，已達軟性上限 ${softCap} 小時，不宜再指派` });
        }
      });

      // 四週彈性工時固定週期：二週例假（H7）、四週工時與休息日總量（H8／H9）
      const p14 = {};
      const p28 = {};
      ss.forEach((s) => {
        const k14 = cycleStartOf(s.date, 14, flexAnchor());
        (p14[k14] = p14[k14] || new Set()).add(s.date);
        const k28 = cycleStartOf(s.date, 28, flexAnchor());
        const rec = (p28[k28] = p28[k28] || { days: new Set(), hours: 0 });
        rec.days.add(s.date);
        rec.hours += db.shiftTypes[s.shift].hours;
      });
      Object.entries(p14).forEach(([start, days]) => {
        const off = 14 - days.size;
        if (off < biweekRest) {
          warnings.push({ level: 'high', code: 'H7', staffId: staff.id,
            text: `${shortDate(start)} 起二週週期已排 ${days.size} 天，僅餘 ${off} 日例假（法定至少 ${biweekRest} 日）` });
        }
      });
      Object.entries(p28).forEach(([start, rec]) => {
        if (rec.hours > fourWeekCap) {
          warnings.push({ level: 'high', code: 'H8', staffId: staff.id,
            text: `${shortDate(start)} 起四週週期已排 ${rec.hours} 小時，超過正常工時總量 ${fourWeekCap} 小時` });
        } else if (rec.hours + 8 > fourWeekCap) {
          warnings.push({ level: 'medium', code: 'H8', staffId: staff.id,
            text: `${shortDate(start)} 起四週週期已排 ${rec.hours} 小時，再排一班即超過正常工時總量 ${fourWeekCap} 小時` });
        }
        const off = 28 - rec.days.size;
        if (off < fourWeekOff) {
          warnings.push({ level: 'high', code: 'H9', staffId: staff.id,
            text: `${shortDate(start)} 起四週週期已排 ${rec.days.size} 天，僅餘 ${off} 日例假與休息日（法定至少 ${fourWeekOff} 日）` });
        }
      });

      // 公平性飽和
      if (staff.standbyCount30d >= saturation) {
        warnings.push({ level: 'medium', code: 'S1', staffId: staff.id,
          text: `近 30 天已被叫班 ${staff.standbyCount30d} 次，已達飽和門檻 ${saturation} 次，應停止指派` });
      } else if (staff.standbyCount30d === saturation - 1) {
        warnings.push({ level: 'low', code: 'S1', staffId: staff.id,
          text: `近 30 天已被叫班 ${staff.standbyCount30d} 次，再一次即達飽和門檻 ${saturation} 次` });
      }
    });

    const rank = { high: 0, medium: 1, low: 2 };
    warnings.sort((a, b) => rank[a.level] - rank[b.level]);
    return warnings;
  }

  /**
   * 單位配置缺口掃描：指定日期範圍內，每單位每班別在班人數低於最低配置的時段。
   * 完全沒有排班資料的單位回傳 noData（示範資料為部分名單時避免誤報一整週）。
   */
  function coverageGaps(dates) {
    const gaps = [];
    Object.keys(db.staffingMin || {}).forEach((unit) => {
      const unitShifts = db.shifts.filter((s) => s.unit === unit);
      if (unitShifts.length === 0) {
        gaps.push({ unit, noData: true });
        return;
      }
      dates.forEach((date) => {
        Object.keys(db.shiftTypes).forEach((code) => {
          const min = db.staffingMin[unit][code];
          if (!min) return;
          const count = unitShifts.filter((s) => s.date === date && s.shift === code).length;
          if (count < min) gaps.push({ unit, date, shift: code, count, min });
        });
      });
    });
    return gaps;
  }

  /**
   * 能力與帶班平衡分析（能力儀表板）。
   *
   * 兩種徽章、兩個問題：
   * - 資格徽章（證照）回答「有沒有人會做」——含效期狀態
   *   （valid／expiring＝expiringDays 內到期／expired），過期即不計入戰力。
   * - 進階徽章（N1–N4／AHN 臨床進階制度）回答「有沒有人扛得住」——
   *   帶班平衡的檢查點：每一班至少一位 seniorLevel（預設 N3）以上。
   *
   * 單點依賴：某資格的有效持有人 ≤ 1 即單點故障——那個人倒下，
   * 這項能力就從單位消失（畫面 7 的劇本就是這樣發生的）。
   *
   * @param {object} spec { dates, unit, seniorLevel = 3, expiringDays = 90 }
   */
  /**
   * 留任雷達：負荷與公平的部門帳。
   *
   * 明確聲明：這不是離職預測模型（那需要歷史結果資料與驗證，
   * demo 做不到也不假裝做到）。這裡做的是確定性的「負荷會計」：
   * 夜班誰最多、假日誰在扛、誰連上最久、誰一直被叫來代班——
   * 全部從班表算出來、逐條給依據；解讀與關懷面談由主管進行。
   *
   * 旗標門檻與規則庫連動（S1 代班飽和、S2 週工時軟上限、H5 連續上限），
   * 夜班／假日旗標另要求「單位內最高」——扛得多不多，要跟同單位比。
   *
   * @param {string[]} dates 統計視窗（連續日期；夜/假/工時/跨單位以視窗計，
   *   最長連續上班取全班表，避免跨視窗邊界的連續區段被低估）
   * @returns {{ dates, thresholds, staff: Array, units: Array }}
   */
  function workloadLedger(dates) {
    const sat = getSoftParam('S1', 5);
    const softCap = getSoftParam('S2', 48);
    const maxDays = getHardParam('H5', 6);
    const weeks = Math.max(dates.length / 7, 1 / 7);
    const nightBar = Math.ceil(3 * weeks);      // 每週 3 班夜為高夜班負荷的視窗換算
    const weekendBar = Math.ceil(2 * weeks);    // 每週 2 班假日為高假日負荷的視窗換算
    const isWeekend = (d) => ['六', '日'].includes(weekdayOf(d));

    const rows = db.staff.map((staff) => {
      const inWin = shiftsOf(staff.id).filter((s) => dates.includes(s.date));
      const uniqueDates = [...new Set(shiftsOf(staff.id).map((s) => s.date))].sort();
      let run = uniqueDates.length ? 1 : 0;
      let maxRun = run;
      for (let i = 1; i < uniqueDates.length; i++) {
        run = uniqueDates[i] === addDays(uniqueDates[i - 1], 1) ? run + 1 : 1;
        if (run > maxRun) maxRun = run;
      }
      return {
        staff,
        nights: inWin.filter((s) => s.shift === 'N').length,
        weekends: inWin.filter((s) => isWeekend(s.date)).length,
        others: 0,   // 補齊於下方（視窗內非夜非假日班數，供圖表組成用）
        hours: inWin.reduce((sum, s) => sum + db.shiftTypes[s.shift].hours, 0),
        crossUnit: inWin.filter((s) => s.unit !== staff.unit).length,
        shiftCount: inWin.length,
        maxRun,
        standby: staff.standbyCount30d,
        flags: [],
      };
    });
    rows.forEach((r) => {
      const inWin = shiftsOf(r.staff.id).filter((s) => dates.includes(s.date));
      // 圖表組成三段互斥（夜班／假日非夜／其他），加總＝視窗班數；
      // weekends 指標本身仍計全部假日班（含假日夜班），供旗標判定
      r.wkNonNight = inWin.filter((s) => isWeekend(s.date) && s.shift !== 'N').length;
      r.others = inWin.filter((s) => s.shift !== 'N' && !isWeekend(s.date)).length;
    });

    // 單位內最高才亮夜班／假日旗——負荷是相對於同單位夥伴的
    const unitMax = {};
    rows.forEach((r) => {
      const u = r.staff.unit;
      unitMax[u] = unitMax[u] || { nights: 0, weekends: 0 };
      unitMax[u].nights = Math.max(unitMax[u].nights, r.nights);
      unitMax[u].weekends = Math.max(unitMax[u].weekends, r.weekends);
    });
    rows.forEach((r) => {
      const um = unitMax[r.staff.unit];
      if (r.nights >= nightBar && r.nights === um.nights) {
        r.flags.push({ code: '夜班', text: `視窗內夜班 ${r.nights} 班，單位最高（門檻 ${nightBar}）` });
      }
      if (r.weekends >= weekendBar && r.weekends === um.weekends) {
        r.flags.push({ code: '假日', text: `視窗內假日班 ${r.weekends} 班，單位最高（門檻 ${weekendBar}）` });
      }
      if (r.maxRun >= maxDays) {
        r.flags.push({ code: '連續', text: `最長連續上班 ${r.maxRun} 天，已達 H5 上限 ${maxDays} 天` });
      } else if (r.maxRun === maxDays - 1) {
        r.flags.push({ code: '連續', text: `最長連續上班 ${r.maxRun} 天，距 H5 上限僅一天` });
      }
      if (r.standby >= sat) {
        r.flags.push({ code: '代班', text: `近 30 天代班 ${r.standby} 次，已達公平性飽和（S1＝${sat}）` });
      }
      if (r.hours >= softCap * (dates.length / 7)) {
        r.flags.push({ code: '工時', text: `視窗內工時 ${r.hours} 小時，達週 ${softCap} 小時軟上限之視窗換算` });
      }
    });
    rows.sort((a, b) => b.flags.length - a.flags.length || b.hours - a.hours
      || (a.staff.id < b.staff.id ? -1 : 1));

    const units = Object.keys(db.units).map((u) => {
      const us = rows.filter((r) => r.staff.unit === u);
      if (!us.length) return { unit: u, staffCount: 0 };
      const nightVals = us.map((r) => r.nights);
      return {
        unit: u,
        staffCount: us.length,
        flagged: us.filter((r) => r.flags.length > 0).length,
        nightMax: Math.max(...nightVals),
        nightMin: Math.min(...nightVals),
        avgHours: round1(us.reduce((sum, r) => sum + r.hours, 0) / us.length),
      };
    });

    return { dates, thresholds: { sat, softCap, maxDays, nightBar, weekendBar }, staff: rows, units };
  }

  function capabilityAnalysis({ dates, unit, seniorLevel = 3, expiringDays = 90 }) {
    const ladder = db.ladderLevels || {};
    const lvOf = (s) => (s.ladder && ladder[s.ladder] ? ladder[s.ladder].level : 0);
    const refDate = dates[0];
    const horizon = addDays(refDate, expiringDays);
    const pool = db.staff.filter((s) => !unit || s.unit === unit);
    const inUnit = (x) => !unit || x.unit === unit;

    /* 徽章牆：進階層級＋各證照效期狀態 */
    const badges = pool.map((s) => ({
      id: s.id, role: s.role,
      ladder: s.ladder || null,
      ladderName: s.ladder && ladder[s.ladder] ? ladder[s.ladder].name : '未評級',
      level: lvOf(s),
      certs: Object.entries(s.certs).map(([code, expiry]) => ({
        code, expiry,
        status: expiry < refDate ? 'expired' : (expiry <= horizon ? 'expiring' : 'valid'),
      })),
    })).sort((a, b) => b.level - a.level || (a.id < b.id ? -1 : 1));

    /* 資格單點依賴：有效持有人數（過期不計入戰力） */
    const certSinglePoints = Object.keys(db.certs).map((code) => {
      const holders = pool.filter((s) => s.certs[code] && s.certs[code] >= refDate).map((s) => s.id);
      return { code, holders, count: holders.length };
    }).sort((a, b) => a.count - b.count);

    /* 帶班平衡：每日×班別的在班進階組成與是否有資深（seniorLevel↑）帶班 */
    const shiftMix = [];
    dates.forEach((date) => {
      Object.keys(db.shiftTypes).forEach((code) => {
        const onDuty = db.shifts
          .filter((x) => x.date === date && x.shift === code && inUnit(x))
          .map((x) => db.staff.find((s) => s.id === x.staffId))
          .filter(Boolean);
        shiftMix.push({
          date, shift: code,
          empty: onDuty.length === 0,
          onDuty: onDuty.map((s) => ({ id: s.id, ladder: s.ladder || null, level: lvOf(s) }))
            .sort((a, b) => b.level - a.level),
          hasSenior: onDuty.some((s) => lvOf(s) >= seniorLevel),
        });
      });
    });

    /* 資格×班別覆蓋：該班別有排班的天數中，幾天班上有人具「當日有效」資格 */
    const certCoverage = Object.keys(db.shiftTypes).map((code) => {
      const staffedDays = dates.filter((date) =>
        db.shifts.some((x) => x.date === date && x.shift === code && inUnit(x)));
      return {
        shift: code,
        staffedDays: staffedDays.length,
        certs: Object.keys(db.certs).map((cert) => ({
          cert,
          coveredDays: staffedDays.filter((date) => db.shifts.some((x) => {
            if (x.date !== date || x.shift !== code || !inUnit(x)) return false;
            const st = db.staff.find((s) => s.id === x.staffId);
            return st && st.certs[cert] && st.certs[cert] >= date;
          })).length,
        })),
      };
    });

    /* 到期雷達：已過期＋expiringDays 內到期，依到期日排序 */
    const expiring = [];
    pool.forEach((s) => {
      Object.entries(s.certs).forEach(([code, expiry]) => {
        if (expiry < refDate) expiring.push({ id: s.id, code, expiry, status: 'expired' });
        else if (expiry <= horizon) expiring.push({ id: s.id, code, expiry, status: 'expiring' });
      });
    });
    expiring.sort((a, b) => (a.expiry < b.expiry ? -1 : 1));

    return { badges, certSinglePoints, shiftMix, certCoverage, expiring, seniorLevel, expiringDays };
  }

  /**
   * 人力缺口分析（管理總覽）——把缺工從模糊感受變成可量化的管理資訊。
   *
   * 缺口方程式：營運所需人力 − 目前可合法且合理排入的人力 ＝ 實際人力缺口
   *
   * 對每個「單位 × 日期 × 班別」計算需求 vs 已排定 → 缺口格；
   * 缺口再經兩道「合法填補模擬」（同一份 checkHardConstraints）：
   *   第一道：同單位人員；第二道：加入熟悉此單位的跨單位人員。
   * 每一筆可行填補都同時記錄其代價（F1 加班超時／F2 連續天數／F4 公平性
   * 等風險標記）；填不進去的缺口誠實保留，並彙整各規則擋下幾人。
   *
   * 結構性判定：同一單位同一班別在區間內出現缺口 ≥ structuralDays 天
   * （預設 3），標記為結構性缺口——反覆靠替補補洞不是解方，
   * 應回到源頭（班表生成／招募／培訓）處理。
   *
   * 完全沒有排班資料的單位回報 noData，不假裝算得出缺口。
   *
   * @param {object} spec { dates, demand: {unit: {D,E,N}}, structuralDays? }
   */
  function workforceGapAnalysis({ dates, demand, structuralDays = 3 }) {
    const units = Object.keys(demand);
    const cells = [];          // 需求 > 0 的全部格子（含已滿足者，供矩陣呈現）
    const noData = [];

    units.forEach((unit) => {
      const unitShifts = db.shifts.filter((s) => s.unit === unit);
      if (unitShifts.length === 0) { noData.push(unit); return; }
      dates.forEach((date) => {
        Object.keys(db.shiftTypes).forEach((code) => {
          const need = demand[unit][code] || 0;
          if (!need) return;
          const scheduled = unitShifts.filter((s) => s.date === date && s.shift === code).length;
          cells.push({ unit, date, shift: code, need, scheduled, gap: Math.max(0, need - scheduled) });
        });
      });
    });

    const gapCells = cells.filter((c) => c.gap > 0);

    // 合法填補模擬：逐格嘗試把缺口補滿；已填補的班次寫入工作副本，
    // 讓後續格子的 H2／H4／H5／H6 判定看得到（同一人不會被重複計算）。
    const simFill = (allowCross) => {
      const workShifts = db.shifts.map((s) => Object.assign({}, s));
      const sim = createEngine({
        staff: db.staff, shifts: workShifts,
        shiftTypes: db.shiftTypes, roleLevels: db.roleLevels,
        certs: db.certs, units: db.units,
        registry: db.registry, staffingMin: db.staffingMin,
        flexCycleAnchor: db.flexCycleAnchor,
      });
      const fills = [];
      const unfilled = [];
      gapCells.forEach((cell) => {
        for (let seat = 0; seat < cell.gap; seat++) {
          const pseudoGap = {
            date: cell.date, shift: cell.shift, unit: cell.unit,
            requiredRole: '護理師', requiredCerts: [], originalStaffId: null,
          };
          const pool = db.staff.filter((st) => allowCross
            ? (st.unit === cell.unit || (st.familiarUnits || []).includes(cell.unit))
            : st.unit === cell.unit);
          const checked = pool.map((st) => ({ st, violations: sim.checkHardConstraints(st, pseudoGap) }));
          const ok = checked.filter((c) => c.violations.length === 0)
            .sort((a, b) => (a.st.id < b.st.id ? -1 : 1));
          if (ok.length === 0) {
            const byCode = {};
            checked.forEach((c) => {
              [...new Set(c.violations.map((v) => v.code))].forEach((code) => {
                byCode[code] = (byCode[code] || 0) + 1;
              });
            });
            unfilled.push({
              unit: cell.unit, date: cell.date, shift: cell.shift,
              blockers: Object.entries(byCode).map(([code, count]) => ({ code, count })),
            });
            continue;
          }
          const pick = ok[0].st;
          const flags = sim.collectFlags(pick, pseudoGap, sim.scoreCandidate(pick, pseudoGap));
          workShifts.push({ staffId: pick.id, date: cell.date, shift: cell.shift, unit: cell.unit, simulated: true });
          fills.push({
            unit: cell.unit, date: cell.date, shift: cell.shift,
            staffId: pick.id, cross: pick.unit !== cell.unit,
            flags: flags.map((f) => f.code),
          });
        }
      });
      return { fills, unfilled };
    };

    const inUnit = simFill(false);
    const withCross = simFill(true);

    // 結構性缺口：同一單位同一班別缺口出現的天數
    const structural = [];
    const byUnitShift = {};
    gapCells.forEach((c) => {
      const key = `${c.unit}|${c.shift}`;
      (byUnitShift[key] = byUnitShift[key] || []).push(c.date);
    });
    Object.entries(byUnitShift).forEach(([key, ds]) => {
      const [unit, shift] = key.split('|');
      if (ds.length >= structuralDays) structural.push({ unit, shift, days: ds.length, dates: ds });
    });

    const seatCount = (list) => list.reduce ? list.reduce((n, c) => n + (c.gap || 1), 0) : 0;
    const hoursOf = (list) => list.reduce((h, c) => h + db.shiftTypes[c.shift].hours * (c.gap || 1), 0);

    return {
      dates, cells, noData, structural,
      totals: {
        needSeats: cells.reduce((n, c) => n + c.need, 0),
        scheduledSeats: cells.reduce((n, c) => n + Math.min(c.scheduled, c.need), 0),
        gapSeats: seatCount(gapCells),
        gapHours: hoursOf(gapCells),
      },
      absorb: {
        inUnit: inUnit.fills.length,
        inUnitFlagged: inUnit.fills.filter((f) => f.flags.length > 0).length,
        withCross: withCross.fills.length,
        crossOnly: withCross.fills.filter((f) => f.cross).length,
        fills: withCross.fills,
        residual: withCross.unfilled,
        residualSeats: withCross.unfilled.length,
        residualHours: withCross.unfilled.reduce((h, u) => h + db.shiftTypes[u.shift].hours, 0),
      },
    };
  }

  /**
   * 第 0 層（源頭治理）：班表生成。
   * 給定日期範圍與各班別人力需求，為單一單位生成班表草稿——
   * 讓班表「排出來的那一刻」就合規，讓下游的缺班替補越來越少被觸發。
   *
   * 硬性約束完全重用 checkHardConstraints：與缺班替補是同一份 H1–H6
   * 程式碼、同一份規則庫參數——規則調整後重新生成即生效。
   * 既有班表作為邊界條件注入：上週日的大夜殘影（H4）、跨週的連續
   * 上班天數（H5）都會約束本週的生成。
   *
   * 排序目標（生成專屬的公平性，全部確定性）：
   *   (1) 本次生成班數最少者優先（總量均衡）
   *   (2) 該班別被排次數最少者優先（夜班等輪值均衡）
   *   (3) 意願相符 > 未表態 > 不符（S4 的生成版）
   *   (4) 代號字典序（結果可重現）
   *
   * 誠實原則：排不出來的格子不硬塞、不放寬——逐格彙整「各規則擋下
   * 幾人」，交主管決策。生成結果為建議草稿，不寫入正式班表。
   *
   * @param {object} spec { unit, dates: [YYYY-MM-DD...],
   *   requirements: [{ shift, count, requiredRole, requiredCerts }] }
   */
  function generateSchedule({ unit, dates, requirements }) {
    // 工作副本：生成逐格寫入副本供後續格子的 H2/H4/H5/H6 判定，不動真實資料
    const workStaff = db.staff.filter((s) => s.unit === unit);
    const workShifts = db.shifts.map((s) => Object.assign({}, s));
    const sim = createEngine({
      staff: workStaff, shifts: workShifts,
      shiftTypes: db.shiftTypes, roleLevels: db.roleLevels,
      certs: db.certs, units: db.units,
      registry: db.registry, staffingMin: db.staffingMin,
      flexCycleAnchor: db.flexCycleAnchor,
    });

    const totalCount = {};
    const typeCount = {};
    workStaff.forEach((s) => {
      totalCount[s.id] = 0;
      typeCount[s.id] = {};
      Object.keys(db.shiftTypes).forEach((c) => { typeCount[s.id][c] = 0; });
    });

    const assignments = [];
    const uncovered = [];
    const everEligible = new Set();   // 整週至少有一格合格者——公平性分佈只對他們有意義
    const wish = (staff, shiftCode) =>
      staff.willingShifts === null ? 1 : (staff.willingShifts.includes(shiftCode) ? 0 : 2);

    dates.forEach((date) => {
      requirements.forEach((req) => {
        for (let slot = 0; slot < req.count; slot++) {
          const pseudoGap = {
            date, shift: req.shift, unit,
            requiredRole: req.requiredRole,
            requiredCerts: req.requiredCerts || [],
            originalStaffId: null,
          };
          const checked = workStaff.map((st) => ({
            st, violations: sim.checkHardConstraints(st, pseudoGap),
          }));
          const ok = checked.filter((c) => c.violations.length === 0);
          ok.forEach((c) => everEligible.add(c.st.id));

          if (ok.length === 0) {
            // 每條規則各擋下幾人（同一人違反多條時每條各計一次）
            const byCode = {};
            checked.forEach((c) => {
              [...new Set(c.violations.map((v) => v.code))].forEach((code) => {
                byCode[code] = (byCode[code] || 0) + 1;
              });
            });
            uncovered.push({
              date, shift: req.shift, unit,
              blockers: Object.entries(byCode).map(([code, count]) => ({ code, count })),
            });
            continue;
          }

          ok.sort((a, b) =>
            totalCount[a.st.id] - totalCount[b.st.id] ||
            typeCount[a.st.id][req.shift] - typeCount[b.st.id][req.shift] ||
            wish(a.st, req.shift) - wish(b.st, req.shift) ||
            (a.st.id < b.st.id ? -1 : 1));
          const pick = ok[0].st;
          workShifts.push({ staffId: pick.id, date, shift: req.shift, unit, generated: true });
          totalCount[pick.id] += 1;
          typeCount[pick.id][req.shift] += 1;
          assignments.push({ staffId: pick.id, date, shift: req.shift, unit });
        }
      });
    });

    // 第二道獨立驗證：把生成班表疊上現有班表，用主動預警掃描器（M2）
    // 重掃一次，與生成前比對——逐格檢查與整表掃描是兩套獨立的檢查路徑，
    // 互相印證。新增的「已違規（high）」必須為 0；達門檻（medium）與
    // 接近門檻（low）如實列出，交主管參考。
    const key = (w) => `${w.level}|${w.code}|${w.staffId}|${w.text}`;
    const beforeKeys = new Set(rosterWarnings().map(key));
    const newWarnings = sim.rosterWarnings().filter((w) => !beforeKeys.has(key(w)));

    const perStaff = workStaff.map((s) => ({
      staffId: s.id, role: s.role,
      total: totalCount[s.id],
      byType: typeCount[s.id],
      hours: Object.entries(typeCount[s.id])
        .reduce((sum, [c, n]) => sum + n * db.shiftTypes[c].hours, 0),
    }));
    // 公平性分佈只計「整週至少有一格合格」者——證照過期等整週不合格的人
    // 本來就排不進來，把他的 0 班算進「最少」會誤導公平性判讀
    const totals = perStaff.filter((p) => everEligible.has(p.staffId)).map((p) => p.total);
    const slotCount = dates.length * requirements.reduce((sum, r) => sum + r.count, 0);

    return {
      unit, dates, requirements, assignments, uncovered, perStaff,
      filled: assignments.length, slotCount,
      spread: totals.length
        ? { max: Math.max(...totals), min: Math.min(...totals) }
        : { max: 0, min: 0 },
      verification: {
        newHigh: newWarnings.filter((w) => w.level === 'high'),
        newMedium: newWarnings.filter((w) => w.level === 'medium'),
        newLow: newWarnings.filter((w) => w.level === 'low'),
      },
    };
  }

  /** 供模擬用：複製人員與班表的獨立引擎，指派寫回不影響真實資料 */
  function cloneForSimulation() {
    return createEngine({
      staff: structuredClone(db.staff),
      shifts: db.shifts.map((s) => Object.assign({}, s)),
      shiftTypes: db.shiftTypes, roleLevels: db.roleLevels,
      certs: db.certs, units: db.units,
      registry: db.registry, staffingMin: db.staffingMin,
      flexCycleAnchor: db.flexCycleAnchor,
    });
  }

  /**
   * 逐筆貪心指派（對照組）：依缺班順序，每一筆都拿「當下」最高分的
   * 候選人並立即寫回模擬班表。快，但稀缺人力可能被前面的缺班用掉。
   */
  function assignGreedy(gaps) {
    const sim = cloneForSimulation();
    return gaps.map((gap) => {
      const ev = sim.evaluateGap(gap);
      if (ev.candidates.length === 0) return { gap, staffId: null, score: null };
      const top = ev.candidates[0];
      sim.applyReplacement(gap, top.staff.id);
      return { gap, staffId: top.staff.id, score: top.score.total };
    });
  }

  /**
   * 全局指派：把所有缺班一起看，枚舉全部可行組合（每筆可指派或留空），
   * 首要目標「填補筆數最多」、次要目標「總分最高」。
   * 組合可行性經完整模擬驗證：同一人接多筆時，前一筆寫回後
   * 會影響後一筆的 H2／H4／H5／H6 判定。
   * 人數與缺班筆數都小（11 人 × 少數缺班），暴力枚舉即為確定性最佳解。
   */
  function assignJointly(gaps) {
    const pools = gaps.map((gap) => evaluateGap(gap).candidates.map((c) => c.staff.id));

    const simulate = (assignment) => {
      const sim = cloneForSimulation();
      const details = [];
      let total = 0;
      for (let i = 0; i < gaps.length; i++) {
        const id = assignment[i];
        if (id === null) { details.push(null); continue; }
        const cand = sim.evaluateGap(gaps[i]).candidates.find((c) => c.staff.id === id);
        if (!cand) return null; // 在累積指派後已不可行（例如同一人同日兩班）
        total += cand.score.total;
        details.push({ staffId: id, score: cand.score.total, flags: cand.flags });
        sim.applyReplacement(gaps[i], id);
      }
      return { total, details };
    };

    let best = null;
    const walk = (idx, current) => {
      if (idx === gaps.length) {
        const sim = simulate(current);
        if (!sim) return;
        const filled = current.filter((x) => x !== null).length;
        if (!best || filled > best.filled || (filled === best.filled && sim.total > best.total)) {
          best = { assignment: current.slice(), filled, total: sim.total, details: sim.details };
        }
        return;
      }
      for (const id of pools[idx].concat([null])) {
        current.push(id);
        walk(idx + 1, current);
        current.pop();
      }
    };
    walk(0, []);

    return best || { assignment: gaps.map(() => null), filled: 0, total: 0, details: gaps.map(() => null) };
  }

  /**
   * 換班互換預檢：模擬甲、乙兩班互換後，雙方「各自」重跑全部硬性約束。
   * 換班是排班日常的大宗；簽核的主管賭的正是這些邊界——引擎必須把
   * 互換後的兩個新狀態都算過一遍，一條都不能漏。
   *
   * a、b：{ staffId, date, shift }，必須指向現行班表中的班次。
   * reqs：{ requiredCerts, requiredRole }，套用於兩個承接方向——
   * 班次本身不帶資格需求，由主管依當班治療確認（與缺班流程同一原則）。
   *
   * 模擬方式：兩筆原班先自班表移除，再以「承接對方的班」作為假想缺班
   * 各跑一次 checkHardConstraints。H1–H9 全為個人約束，甲的檢查不受
   * 乙的新班影響，反之亦然，故一份模擬班表可同時檢查雙向。
   *
   * @returns {{ ok:boolean, error?:string, aTake?:object, bTake?:object, notices?:string[] }}
   *   aTake ＝ 甲承接乙的班 { staff, slot, violations }；bTake 反向。
   */
  function analyzeSwap(a, b, reqs = {}) {
    const findRow = (q) => db.shifts.find(
      (s) => s.staffId === q.staffId && s.date === q.date && s.shift === q.shift);
    const rowA = findRow(a);
    const rowB = findRow(b);
    if (!rowA || !rowB) return { ok: false, error: '指定的班次不在現行班表中，請重新選擇' };
    if (a.staffId === b.staffId) return { ok: false, error: '互換需要兩位不同人員的兩個班次' };
    const staffA = db.staff.find((s) => s.id === a.staffId);
    const staffB = db.staff.find((s) => s.id === b.staffId);
    if (!staffA || !staffB) return { ok: false, error: '人員代號不存在' };

    const requiredCerts = reqs.requiredCerts || ['ACLS'];
    const requiredRole = reqs.requiredRole || '護理師';

    const sim = createEngine({
      staff: db.staff,
      shifts: db.shifts.filter((s) => s !== rowA && s !== rowB),
      shiftTypes: db.shiftTypes, roleLevels: db.roleLevels,
      certs: db.certs, units: db.units,
      registry: db.registry, staffingMin: db.staffingMin,
      flexCycleAnchor: db.flexCycleAnchor,
    });
    const slotOf = (row) => ({
      date: row.date, shift: row.shift, unit: row.unit,
      requiredCerts, requiredRole, originalStaffId: null,
    });
    const aTake = { staff: staffA, slot: slotOf(rowB), violations: sim.checkHardConstraints(staffA, slotOf(rowB)) };
    const bTake = { staff: staffB, slot: slotOf(rowA), violations: sim.checkHardConstraints(staffB, slotOf(rowA)) };

    const notices = [];
    if (rowB.unit !== staffA.unit) {
      notices.push(`${staffA.id} 承接後為跨單位支援（${db.units[rowB.unit] || rowB.unit}），交接與單位熟悉度請主管留意（F3）`);
    }
    if (rowA.unit !== staffB.unit) {
      notices.push(`${staffB.id} 承接後為跨單位支援（${db.units[rowA.unit] || rowA.unit}），交接與單位熟悉度請主管留意（F3）`);
    }
    // 承接週工時為資訊性提示；超標與否已由 H6／H8 硬性把關
    [[staffA, rowB], [staffB, rowA]].forEach(([st, take]) => {
      const hours = sim.weeklyHours(st.id, take.date) + db.shiftTypes[take.shift].hours;
      notices.push(`${st.id} 承接週（${shortDate(weekDatesOf(take.date)[0])} 起）工時將為 ${hours} 小時`);
    });

    return { ok: aTake.violations.length === 0 && bTake.violations.length === 0, aTake, bTake, notices };
  }

  /**
   * 核准互換寫回：兩筆班次交換承接人，日期、班別、單位皆不動。
   * 僅在 analyzeSwap 通過後由主管觸發——引擎不自行核准任何互換。
   */
  function applySwap(a, b) {
    const findRow = (q) => db.shifts.find(
      (s) => s.staffId === q.staffId && s.date === q.date && s.shift === q.shift);
    const rowA = findRow(a);
    const rowB = findRow(b);
    if (!rowA || !rowB || rowA === rowB) return false;
    const tmp = rowA.staffId;
    rowA.staffId = rowB.staffId;
    rowB.staffId = tmp;
    rowA.isSwap = true;
    rowB.isSwap = true;
    return true;
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
    analyzeSwap, applySwap,
    checkHardConstraints, scoreCandidate, collectFlags,
    weeklyHours, shiftMix, isOnLeave, consecutiveDaysWithGap,
    minRestAfterGap, shiftInterval, unitCoverage,
    assignGreedy, assignJointly, rosterWarnings, coverageGaps,
    generateSchedule, workforceGapAnalysis, capabilityAnalysis, workloadLedger,
  };
}

/**
 * 任務重新分配（第三層：韌性模式）——連替補都無解時，缺的不再是
 * 「一個人」，而是「一班的任務」。把缺班者的任務拆解，重分配給在班人力。
 *
 * 純函式、資料全部由參數注入（與 createEngine 同一哲學）：
 *   tasks        缺班者任務清單 [{id, name, requiredCerts, workload, critical}]
 *   onDuty       在班人員 [{id, role, certs: [代碼]}]
 *   maxExtraLoad 每人最多可多承接的工作量點數
 *
 * 演算法與 assignJointly 同宗：枚舉全部可行組合（每項任務指派給一位
 * 合格且尚有量能者，或留空），字典序最佳化——
 *   (1) 未覆蓋的「關鍵任務」數最少 → (2) 未覆蓋任務總數最少
 *   → (3) 最大個人負荷最小（平衡）→ 同分取先枚舉者（結果確定性）。
 *
 * 誠實原則：無人可承接的任務不會被隱藏或自動刪除——逐筆標示未覆蓋
 * 原因（no_qualified：無人具資格／over_capacity：量能不足），交主管決策。
 */
function reallocateTasks({ tasks, onDuty, maxExtraLoad }) {
  const qualified = (staff, task) =>
    (task.requiredCerts || []).every((c) => (staff.certs || []).includes(c));

  // 每項任務的可承接者（資格為硬性條件，量能於枚舉時檢查）
  const pools = tasks.map((task) => onDuty.filter((s) => qualified(s, task)).map((s) => s.id));

  let best = null;
  const loads = Object.fromEntries(onDuty.map((s) => [s.id, 0]));

  const evaluate = (assignment) => {
    const uncoveredCritical = tasks.filter((t, i) => assignment[i] === null && t.critical).length;
    const uncoveredTotal = assignment.filter((a) => a === null).length;
    const maxLoad = Math.max(0, ...Object.values(loads));
    return { uncoveredCritical, uncoveredTotal, maxLoad };
  };

  const better = (a, b) =>
    a.uncoveredCritical !== b.uncoveredCritical ? a.uncoveredCritical < b.uncoveredCritical
      : a.uncoveredTotal !== b.uncoveredTotal ? a.uncoveredTotal < b.uncoveredTotal
        : a.maxLoad < b.maxLoad;

  const walk = (idx, assignment) => {
    if (idx === tasks.length) {
      const score = evaluate(assignment);
      if (!best || better(score, best.score)) {
        best = { assignment: assignment.slice(), score };
      }
      return;
    }
    for (const staffId of pools[idx].concat([null])) {
      if (staffId !== null) {
        if (loads[staffId] + tasks[idx].workload > maxExtraLoad) continue;
        loads[staffId] += tasks[idx].workload;
      }
      assignment.push(staffId);
      walk(idx + 1, assignment);
      assignment.pop();
      if (staffId !== null) loads[staffId] -= tasks[idx].workload;
    }
  };
  walk(0, []);

  // 整理輸出：各在班人員的承接清單與負荷、未覆蓋任務與原因
  const plan = onDuty.map((s) => ({ staff: s, tasks: [], extraLoad: 0 }));
  const uncovered = [];
  best.assignment.forEach((staffId, i) => {
    const task = tasks[i];
    if (staffId === null) {
      uncovered.push({ task, reason: pools[i].length === 0 ? 'no_qualified' : 'over_capacity' });
    } else {
      const entry = plan.find((p) => p.staff.id === staffId);
      entry.tasks.push(task);
      entry.extraLoad += task.workload;
    }
  });

  return {
    plan, uncovered,
    coveredCount: tasks.length - uncovered.length,
    totalCount: tasks.length,
    uncoveredCritical: uncovered.filter((u) => u.task.critical).length,
    maxExtraLoad,
  };
}

/* 讓測試頁（tests.html）以外的環境（如 Node）也能載入 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createEngine, parseDate, formatDate, addDays, weekdayOf,
    shortDate, weekDatesOf, WEEKDAY_TW, isValidDateStr, reallocateTasks,
    cycleStartOf, cycleDatesOf,
  };
}
