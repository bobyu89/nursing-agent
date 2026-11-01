/**
 * coverage.js — 能力覆蓋檢核（人數夠，不等於能力夠）
 *
 * 通用排班只數人頭；本模組逐格檢查「在班的人能不能承擔這一格的照護」：
 * 資格是否在效期內、臨床進階是否達標、同一人是否被排進重疊時段、
 * 兩格之間的休息是否達到單位設定檔的下限。
 *
 * 「某人某天算不算具備某能力」不在本檔判定，一律呼叫能力判定核心 competence.js 的
 * badgeOf（全域函式：宿主須先載入 competence.js，再載入本檔），只有 valid／expiring 計入。
 * 效期無法判讀（如 '2026/1/5'、Excel 日期序號）視同未具備＝fail closed，不再以字串比較放行。
 *
 * 介面：
 *   assessCoverage(profile, slots, assignments, staff) → { profile, slots, summary }
 *     slots        careDemand 的輸出
 *     assignments  [{ slotId, staffId }]
 *     staff        [{ id, certs: { 代碼: 效期 }, ladder }]（與 data.js 的 STAFF 同形）
 *   diffCoverage(before, after) → { broke, fixed }
 *     比較變更前後（替補、借調、換班）——補好一格卻弄壞另一格，在這裡現形。
 *   rosterAssignments(profile, slots, rows) → { assignments, unmapped: [{ row, reason }] }
 *     班表列 [{ staffId, date, shift, unit, post? }]（與 SHIFTS、D1 班表同形）對應到格；
 *     其他單位與範圍外日期的列略過，對不上設定檔的列逐列附原因列出，不默默丟棄。
 *   rosterCoverage(profile, slots, rows, staff) → { ...assessCoverage 的結果, unmapped, tally }
 *     slots 由呼叫端以 careDemand 產生後傳入——本檔不呼叫 careDemand，只依賴 badgeOf。
 *   coverageTally(profile, result, staff) → { profile, slots, staffed, empty, conflict, atLeast, allMust, unrated }
 *     只計有排人的班（空班的人數缺口歸生成器與今日戰情，不算帶班缺口）；
 *     unrated 點名臨床進階未登錄或無法辨識的在班者——不計為帶班，也不默默少算。
 *
 * 每一筆問題附代碼與中文說明，主管與稽核看得懂、程式也能統計：
 *   C-HEAD    人數不足（附需求來源：known／baseline／forecast／assumed）
 *   C-ALL     在班者缺少該格必備能力
 *   C-ATLEAST 具備某能力的人數不足
 *   C-DOUBLE  同一人被排進重疊時段
 *   C-REST    兩格之間休息不足單位下限
 *   C-STAFF   排入名單外的人員代號
 * fragile 列出「剛好只有一人撐住」的能力——那個人倒下，這格就破。
 */

function assessCoverage(profile, slots, assignments, staff) {
  const byId = new Map((staff || []).map((s) => [s.id, s]));
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const assigned = new Map(slots.map((s) => [s.id, []]));
  const personal = new Map();   // staffId → 該人被排入的格
  const issues = new Map(slots.map((s) => [s.id, []]));
  const add = (slotId, issue) => issues.get(slotId).push(issue);

  (assignments || []).forEach(({ slotId, staffId }) => {
    const slot = slotById.get(slotId);
    if (!slot) return;   // 不在本次檢核範圍的格
    if (!byId.has(staffId)) {
      add(slotId, { code: 'C-STAFF', staffId, text: `${staffId} 不在人員名單，無法確認能力` });
      return;
    }
    assigned.get(slotId).push(staffId);
    if (!personal.has(staffId)) personal.set(staffId, []);
    personal.get(staffId).push(slot);
  });

  // 個人面：重疊時段與休息不足（同一對格只記一次，記在較晚的那一格）
  const minRest = profile.constraints.minRestHours;
  personal.forEach((list, staffId) => {
    const sorted = list.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.start < prev.end) {
        add(cur.id, { code: 'C-DOUBLE', staffId, text: `${staffId} 同時被排在「${prev.label}」與「${cur.label}」` });
      } else {
        const rest = hoursBetween(prev.end, cur.start);
        if (rest < minRest) {
          add(cur.id, { code: 'C-REST', staffId, text: `${staffId} 自「${prev.label}」下班至本格僅休息 ${rest} 小時，低於單位下限 ${minRest} 小時` });
        }
      }
    }
  });

  const results = slots.map((slot) => {
    const ids = assigned.get(slot.id);
    const out = issues.get(slot.id);
    const fragile = [];
    const date = slot.date;

    if (ids.length < slot.headcount.min) {
      out.push({
        code: 'C-HEAD', short: slot.headcount.min - ids.length, source: slot.headcount.source,
        text: `需 ${slot.headcount.min} 人、在班 ${ids.length} 人（${slot.headcount.basis}）`,
      });
    }
    slot.allMust.forEach((code) => {
      ids.forEach((id) => {
        const h = badgeOf(profile, byId.get(id), code, date);
        if (!h.counts) {
          out.push({ code: 'C-ALL', competence: code, staffId: id, text: `${id} ${h.text}，本格每位皆須具備${competenceLabel(profile, code)}` });
        }
      });
    });
    slot.atLeast.forEach(({ competence, min }) => {
      const holders = ids.filter((id) => badgeOf(profile, byId.get(id), competence, date).counts);
      if (holders.length < min) {
        out.push({
          code: 'C-ATLEAST', competence, short: min - holders.length,
          text: `${competenceLabel(profile, competence)}需 ${min} 位、在班具備者 ${holders.length} 位`,
        });
      } else if (holders.length === 1) {
        fragile.push({ competence, staffId: holders[0] });
      }
    });
    // allMust 能力若全格只有一人在班，同樣是單點
    if (ids.length === 1) {
      slot.allMust.forEach((code) => {
        if (badgeOf(profile, byId.get(ids[0]), code, date).counts) fragile.push({ competence: code, staffId: ids[0] });
      });
    }

    const conflict = out.some((x) => x.code === 'C-DOUBLE' || x.code === 'C-REST' || x.code === 'C-STAFF');
    return {
      slotId: slot.id, date, label: slot.label,
      need: slot.headcount.min, source: slot.headcount.source, assigned: ids.slice(),
      status: conflict ? 'conflict' : out.length ? 'short' : 'met',
      issues: out, fragile,
    };
  });

  const summary = { met: 0, short: 0, conflict: 0, shortBySource: {}, fragile: 0 };
  results.forEach((r) => {
    summary[r.status] += 1;
    summary.fragile += r.fragile.length;
    if (r.status === 'short') summary.shortBySource[r.source] = (summary.shortBySource[r.source] || 0) + 1;
  });
  return { profile: profile.fingerprint, slots: results, summary };
}

function diffCoverage(before, after) {
  const prev = new Map(before.slots.map((s) => [s.slotId, s.status]));
  const broke = [];
  const fixed = [];
  after.slots.forEach((s) => {
    const was = prev.get(s.slotId);
    if (was === undefined) return;
    if (was === 'met' && s.status !== 'met') broke.push(s.slotId);
    if (was !== 'met' && s.status === 'met') fixed.push(s.slotId);
  });
  return { broke, fixed };
}

/**
 * 班表列對應到格。崗位：單位只有一個崗位時預設為它；多崗位單位的列須以 row.post 指明。
 * 對不上的列附原因：設定檔無此班別／多崗位單位須指明崗位／設定檔無此崗位／
 * 該日此格無照護需求（如透析室當日未開此場次）。
 */
function rosterAssignments(profile, slots, rows) {
  const d = profile.demand || {};
  const shiftIds = new Set((d.shifts || d.sessions || []).map((s) => s.id));
  const posts = (d.posts || d.areas || []).map((p) => p.id);
  const slotIds = new Set(slots.map((s) => s.id));
  const dates = new Set(slots.map((s) => s.date));
  const assignments = [];
  const unmapped = [];
  (rows || []).forEach((row) => {
    if (!row || row.unit !== profile.unit || !dates.has(row.date)) return;   // 不在本次檢核範圍
    const miss = (reason) => { unmapped.push({ row, reason }); };
    if (!shiftIds.has(row.shift)) return miss('設定檔無此班別');
    const post = row.post || (posts.length === 1 ? posts[0] : null);
    if (!post) return miss('多崗位單位須指明崗位');
    if (!posts.includes(post)) return miss('設定檔無此崗位');
    const slotId = `${row.date}|${row.shift}|${post}`;
    if (!slotIds.has(slotId)) return miss('該日此格無照護需求');
    assignments.push({ slotId, staffId: row.staffId });
  });
  return { assignments, unmapped };
}

/** 班表列 → 格 → 覆蓋檢核，附對不上的列與計數 */
function rosterCoverage(profile, slots, rows, staff) {
  const { assignments, unmapped } = rosterAssignments(profile, slots, rows);
  const result = assessCoverage(profile, slots, assignments, staff);
  return { ...result, unmapped, tally: coverageTally(profile, result, staff) };
}

/**
 * 覆蓋結果的計數，只看有排人的班（名單外代號也算有人排入），依格的順序：
 *   atLeast  { 能力代碼: [slotId] }               在班具備者不足的班
 *   allMust  { 能力代碼: [{ slotId, staffId }] }  不具該必備能力的在班者
 *   unrated  [staffId]  臨床進階未登錄或無法辨識的在班者（設定檔以臨床進階判定的能力才看）
 * 設定檔需求中出現的能力代碼一律有鍵，沒有缺口時為空陣列。
 */
function coverageTally(profile, result, staff) {
  const byId = new Map((staff || []).map((s) => [s.id, s]));
  const d = profile.demand || {};
  const atLeast = {};
  const allMust = {};
  (d.posts || d.areas || []).forEach((n) => {
    n.atLeast.forEach(({ competence }) => { atLeast[competence] = []; });
    n.allMust.forEach((code) => { allMust[code] = []; });
  });
  const ladderCodes = [...new Set([...Object.keys(atLeast), ...Object.keys(allMust)])]
    .filter((code) => (profile.competences[code] || {}).ladderAtLeast);
  const staffed = result.slots.filter((s) => s.assigned.length > 0 || s.issues.some((i) => i.code === 'C-STAFF'));
  const unrated = [];
  staffed.forEach((s) => {
    s.issues.forEach((i) => {
      if (i.code === 'C-ATLEAST') (atLeast[i.competence] = atLeast[i.competence] || []).push(s.slotId);
      if (i.code === 'C-ALL') (allMust[i.competence] = allMust[i.competence] || []).push({ slotId: s.slotId, staffId: i.staffId });
    });
    s.assigned.forEach((id) => {
      if (unrated.includes(id)) return;
      const off = ladderCodes.some((code) => {
        const st = badgeOf(profile, byId.get(id), code, s.date).status;
        return st === 'unrated' || st === 'invalid';
      });
      if (off) unrated.push(id);
    });
  });
  return {
    profile: profile.fingerprint,
    slots: result.slots.length,
    staffed: staffed.length,
    empty: result.slots.length - staffed.length,
    conflict: staffed.filter((s) => s.status === 'conflict').length,
    atLeast, allMust, unrated,
  };
}

function competenceLabel(profile, code) {
  return (profile.competences[code] || {}).label || code;
}

function hoursBetween(a, b) {
  const ms = Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`);
  return Math.round(ms / 360000) / 10;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { assessCoverage, diffCoverage, rosterAssignments, rosterCoverage, coverageTally };
}
