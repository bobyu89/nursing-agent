/**
 * coverage.js — 能力覆蓋檢核（人數夠，不等於能力夠）
 *
 * 通用排班只數人頭；本模組逐格檢查「在班的人能不能承擔這一格的照護」：
 * 資格是否在效期內、臨床進階是否達標、同一人是否被排進重疊時段、
 * 兩格之間的休息是否達到單位設定檔的下限。
 *
 * 介面兩個函式：
 *   assessCoverage(profile, slots, assignments, staff) → { slots, summary }
 *     slots        careDemand 的輸出
 *     assignments  [{ slotId, staffId }]
 *     staff        [{ id, certs: { 代碼: 效期 }, ladder }]（與 data.js 的 STAFF 同形）
 *   diffCoverage(before, after) → { broke, fixed }
 *     比較變更前後（替補、借調、換班）——補好一格卻弄壞另一格，在這裡現形。
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
        const h = competenceStatus(profile, byId.get(id), code, date);
        if (h.status !== 'valid') {
          out.push({ code: 'C-ALL', competence: code, staffId: id, text: `${id} ${h.text}，本格每位皆須具備${competenceLabel(profile, code)}` });
        }
      });
    });
    slot.atLeast.forEach(({ competence, min }) => {
      const holders = ids.filter((id) => competenceStatus(profile, byId.get(id), competence, date).status === 'valid');
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
        if (competenceStatus(profile, byId.get(ids[0]), code, date).status === 'valid') fragile.push({ competence: code, staffId: ids[0] });
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

/** 某人於某日是否具備某能力：valid／expired／missing／unknown，附可讀說明 */
function competenceStatus(profile, person, code, date) {
  const def = profile.competences[code];
  if (!person || !def) return { status: 'missing', text: '無法確認' };
  if (def.cert) {
    const exp = (person.certs || {})[def.cert];
    if (!exp) return { status: 'missing', text: `未持有${def.label}` };
    if (exp < date) return { status: 'expired', text: `${def.label}已於 ${exp} 過期` };
    return { status: 'valid', text: '' };
  }
  const rank = profile.ladder.indexOf(person.ladder);
  if (rank < 0) return { status: 'unknown', text: '臨床進階未登錄' };
  return rank >= profile.ladder.indexOf(def.ladderAtLeast)
    ? { status: 'valid', text: '' }
    : { status: 'missing', text: `臨床進階 ${person.ladder} 未達${def.label}` };
}

function competenceLabel(profile, code) {
  return (profile.competences[code] || {}).label || code;
}

function hoursBetween(a, b) {
  const ms = Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`);
  return Math.round(ms / 360000) / 10;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { assessCoverage, diffCoverage };
}
