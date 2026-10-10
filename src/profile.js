/**
 * profile.js — 單位設定檔編譯器（護理知識的入口）
 *
 * 通用人資系統的單位只有「班別 × 人數」；本模組把一個單位的護理知識
 * 表示為五類物件，編譯成其他模組共同使用的設定檔：
 *   需求 demand          照護需求如何換算為人力（透析：場次 × 床數 ÷ 每人病人數；急診：崗位 × 時段）
 *   能力 competences     資格（含效期）或臨床進階，例：透析資格、五級檢傷、N3 以上
 *   限制 constraints     休息、連續上班、週工時；全院法規底線共用，單位只能加嚴
 *   偏好 preferences     預假與意願的處理方式
 *   責任 accountability  誰可核准替補、發布班表、核准例外
 *
 * 唯一的介面：compileProfile(draft, floor) → { ok, profile, problems }
 *   - 不論設定檔草稿出自管理者手填或 AI 草擬，都必須經過這裡；
 *     未通過（ok=false）的草稿不產生 profile，下游不會拿到半成品。
 *   - problems 每筆附代碼與欄位路徑，管理端可逐項指出要改哪裡。
 *   - profile 深度凍結，附 fingerprint（內容指紋），決策紀錄引用它即可追溯當時用的是哪一版。
 *
 * 純函式、零依賴：瀏覽器、Node 測試與 Cloudflare Worker 共用同一份。
 */

const PROFILE_KINDS = ['hemodialysis', 'emergency'];
const APPROVER_ROLES = ['head', 'exec'];   // 與 LINE 權責層級一致：head 護理長、exec 督導／主任
const DEFAULT_LADDER = ['N1', 'N2', 'N3', 'N4', 'AHN'];

/** 全院法規底線的預設值；醫院可在呼叫端覆寫，但單位設定檔只能比它嚴 */
const DEFAULT_FLOOR = {
  minRestHours: 11,
  maxConsecutiveDays: 6,
  maxWeeklyHours: 48,
  maxPatientsPerNurse: { hemodialysis: 4 },
  ladder: DEFAULT_LADDER,
};

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function compileProfile(draft, floor = DEFAULT_FLOOR) {
  const fl = { ...DEFAULT_FLOOR, ...(floor || {}) };
  const problems = [];
  const bad = (path, code, message) => problems.push({ path, code, message });
  const d = draft && typeof draft === 'object' ? draft : {};

  if (!d.unit || typeof d.unit !== 'string') bad('unit', 'P-REQUIRED', '缺少單位代碼');
  if (!PROFILE_KINDS.includes(d.kind)) bad('kind', 'P-KIND', `單位類型須為 ${PROFILE_KINDS.join('／')}`);

  const competences = normalizeCompetences(d.competences, fl, bad);
  const constraints = normalizeConstraints(d.constraints, fl, bad);
  const accountability = normalizeAccountability(d.accountability, bad);
  const demand = d.kind === 'hemodialysis' ? normalizeDialysisDemand(d.demand, fl, competences, bad)
    : d.kind === 'emergency' ? normalizeEmergencyDemand(d.demand, competences, bad)
      : null;
  const preferences = {
    honorPrebook: !(d.preferences && d.preferences.honorPrebook === false),
    maxPrebookDays: positiveOr(d.preferences && d.preferences.maxPrebookDays, 8, 'preferences.maxPrebookDays', bad),
  };

  if (problems.length) return { ok: false, profile: null, problems };

  const body = {
    unit: d.unit, kind: d.kind, label: d.label || d.unit,
    competences, demand, constraints, preferences, accountability,
    ladder: fl.ladder.slice(),
  };
  const profile = deepFreeze({ ...body, fingerprint: fingerprintOf(body) });
  return { ok: true, profile, problems: [] };
}

/* ── 能力：資格（cert，看效期）或臨床進階（ladderAtLeast） ── */
function normalizeCompetences(raw, fl, bad) {
  const out = {};
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) {
    bad('competences', 'P-REQUIRED', '至少需定義一項能力');
    return out;
  }
  Object.keys(raw).forEach((code) => {
    const c = raw[code] || {};
    const path = `competences.${code}`;
    if (c.cert && c.ladderAtLeast) bad(path, 'P-COMPETENCE', '一項能力只能以資格或臨床進階其中一種判定');
    else if (c.cert) out[code] = { label: c.label || code, cert: String(c.cert) };
    else if (c.ladderAtLeast) {
      if (!fl.ladder.includes(c.ladderAtLeast)) bad(path, 'P-COMPETENCE', `臨床進階 ${c.ladderAtLeast} 不在進階序列 ${fl.ladder.join('<')}`);
      else out[code] = { label: c.label || code, ladderAtLeast: c.ladderAtLeast };
    } else bad(path, 'P-COMPETENCE', '能力須指定資格代碼（cert）或臨床進階下限（ladderAtLeast）');
  });
  return out;
}

/* ── 限制：底線共用，只能加嚴 ── */
function normalizeConstraints(raw, fl, bad) {
  const c = raw || {};
  const out = {
    minRestHours: c.minRestHours === undefined ? fl.minRestHours : c.minRestHours,
    maxConsecutiveDays: c.maxConsecutiveDays === undefined ? fl.maxConsecutiveDays : c.maxConsecutiveDays,
    maxWeeklyHours: c.maxWeeklyHours === undefined ? fl.maxWeeklyHours : c.maxWeeklyHours,
  };
  if (!(out.minRestHours >= fl.minRestHours)) {
    bad('constraints.minRestHours', 'P-LOOSER', `班距至少 ${fl.minRestHours} 小時（全院底線），單位只能加嚴`);
  }
  if (!(out.maxConsecutiveDays <= fl.maxConsecutiveDays && out.maxConsecutiveDays >= 1)) {
    bad('constraints.maxConsecutiveDays', 'P-LOOSER', `連續上班最多 ${fl.maxConsecutiveDays} 天（全院底線），單位只能加嚴`);
  }
  if (!(out.maxWeeklyHours <= fl.maxWeeklyHours && out.maxWeeklyHours > 0)) {
    bad('constraints.maxWeeklyHours', 'P-LOOSER', `週工時最多 ${fl.maxWeeklyHours} 小時（全院底線），單位只能加嚴`);
  }
  return out;
}

/* ── 責任：核准類權責不得落在一般護理人員 ── */
function normalizeAccountability(raw, bad) {
  const a = raw || {};
  const out = {};
  ['approveSubstitution', 'publishRoster', 'grantException'].forEach((k) => {
    const v = a[k] || (k === 'grantException' ? 'exec' : 'head');
    if (!APPROVER_ROLES.includes(v)) bad(`accountability.${k}`, 'P-ROLE', `須為 ${APPROVER_ROLES.join('／')} 之一`);
    out[k] = v;
  });
  return out;
}

/* ── 需求：血液透析室（場次 × 區域 × 每人病人數） ── */
function normalizeDialysisDemand(raw, fl, competences, bad) {
  const r = raw || {};
  const cap = (fl.maxPatientsPerNurse || {}).hemodialysis || 4;
  const ppn = r.patientsPerNurse === undefined ? cap : r.patientsPerNurse;
  if (!(ppn > 0 && ppn <= cap)) {
    bad('demand.patientsPerNurse', 'P-LOOSER', `每名護理人員至多照護 ${cap} 床（血液透析業務評估要點），單位只能加嚴`);
  }
  const sessions = normalizeList(r.sessions, 'demand.sessions', bad, (s, path) => {
    checkTime(s.start, `${path}.start`, bad);
    checkTime(s.end, `${path}.end`, bad);
    const weekdays = Array.isArray(s.weekdays) && s.weekdays.length ? s.weekdays.slice() : [1, 2, 3, 4, 5, 6];
    if (weekdays.some((w) => !(Number.isInteger(w) && w >= 0 && w <= 6))) bad(`${path}.weekdays`, 'P-NUM', '星期須為 0（日）至 6（六）');
    return { id: s.id, label: s.label || s.id, start: s.start, end: s.end, weekdays };
  });
  const areas = normalizeList(r.areas, 'demand.areas', bad, (a, path) => ({
    id: a.id, label: a.label || a.id,
    stations: positiveOr(a.stations, null, `${path}.stations`, bad),
    ...normalizeNeeds(a, path, competences, bad),
  }));
  return { patientsPerNurse: ppn, sessions, areas };
}

/* ── 需求：急診（班別 × 崗位，保底人數加上可選的時段預測換算） ── */
function normalizeEmergencyDemand(raw, competences, bad) {
  const r = raw || {};
  const shifts = normalizeList(r.shifts, 'demand.shifts', bad, (s, path) => {
    checkTime(s.start, `${path}.start`, bad);
    checkTime(s.end, `${path}.end`, bad);
    return { id: s.id, label: s.label || s.id, start: s.start, end: s.end };
  });
  const posts = normalizeList(r.posts, 'demand.posts', bad, (p, path) => ({
    id: p.id, label: p.label || p.id,
    min: positiveOr(p.min, null, `${path}.min`, bad),
    visitsPerNurse: p.visitsPerNurse === undefined ? null : positiveOr(p.visitsPerNurse, null, `${path}.visitsPerNurse`, bad),
    ...normalizeNeeds(p, path, competences, bad),
  }));
  return { shifts, posts };
}

/** allMust：該格每一位都須具備；atLeast：至少 min 位具備 */
function normalizeNeeds(src, path, competences, bad) {
  const known = (code, p) => {
    if (!competences[code]) bad(p, 'P-UNKNOWN-COMPETENCE', `未定義的能力 ${code}`);
  };
  const allMust = Array.isArray(src.allMust) ? src.allMust.slice() : [];
  allMust.forEach((code, i) => known(code, `${path}.allMust.${i}`));
  const atLeast = (Array.isArray(src.atLeast) ? src.atLeast : []).map((n, i) => {
    known(n.competence, `${path}.atLeast.${i}`);
    return { competence: n.competence, min: positiveOr(n.min, 1, `${path}.atLeast.${i}.min`, bad) };
  });
  return { allMust, atLeast };
}

function normalizeList(raw, path, bad, fn) {
  if (!Array.isArray(raw) || !raw.length) {
    bad(path, 'P-REQUIRED', '至少需一項');
    return [];
  }
  const seen = new Set();
  return raw.map((item, i) => {
    const p = `${path}.${i}`;
    if (!item || !item.id) bad(`${p}.id`, 'P-REQUIRED', '缺少代碼');
    else if (seen.has(item.id)) bad(`${p}.id`, 'P-DUP', `代碼 ${item.id} 重複`);
    else seen.add(item.id);
    return fn(item || {}, p);
  });
}

function positiveOr(v, fallback, path, bad) {
  if (v === undefined || v === null) {
    if (fallback === null) bad(path, 'P-REQUIRED', '缺少數值');
    return fallback;
  }
  if (!(typeof v === 'number' && v > 0)) bad(path, 'P-NUM', '須為正數');
  return v;
}

function checkTime(t, path, bad) {
  if (!HHMM_RE.test(t || '')) bad(path, 'P-TIME', '時間格式須為 HH:MM');
}

/* ── 指紋：鍵排序後的 JSON 做 FNV-1a，與鍵順序無關、與內容一一對應 ── */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function fingerprintOf(obj) {
  const s = canonical(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p-${h.toString(16).padStart(8, '0')}`;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { compileProfile, DEFAULT_FLOOR };
}
