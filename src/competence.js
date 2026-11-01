/**
 * competence.js — 能力判定核心（班守與特護共用的同一個判斷）
 *
 * 「這個人在這一天，算不算具備這項能力」只在這裡判定：覆蓋檢核、替補標籤、
 * 後備深度都呼叫同一個 badgeOf，兩個產品的語義因此相同（docs/CONTEXT.md「共用核心」）。
 *
 * 移植契約（docs/ARCHITECTURE.md §6.3）：
 *   - 零依賴、不讀任何全域；本檔與 competence.d.ts 原樣複製即可在特護使用，
 *     保留檔尾的 CommonJS 防護段，以 default import 載入。
 *   - COMPETENCE_KERNEL_VERSION 依語意化版本遞增，介面只做加法；宿主的契約測試釘住它。
 *   - 私有輔助函式一律以 ck 開頭——瀏覽器以 <script> 全域載入時不與其他檔撞名。
 *
 * 輸入形狀（compileProfile 編譯後的設定檔本身就是合格的 catalog）：
 *   catalog  { competences: { 代碼: { label, cert } | { label, ladderAtLeast } }, ladder: [由低到高] }
 *   person   { id, certs: { 資格代碼: 'YYYY-MM-DD' | true }, ladder }
 *   needs    { allMust: [代碼], atLeast: [{ competence, min }] }（careDemand 的一格，或特護的一案）
 *
 * badgeOf 七態：valid 有效／expiring 即將到期（呼叫端給 expiringDays 才區分）／expired 已過期／
 *   missing 未持有（未定義的能力代碼、認不得的能力形狀或查無此人時為「無法確認」）／invalid 登錄值無法判讀／
 *   below 臨床進階未達門檻／unrated 臨床進階未登錄。只有 valid 與 expiring 計入（counts）。
 * 效期只認真實存在的 ISO 日期：'2026/1/5'、Excel 日期序號、'2027-02-30' 一律 invalid＝視同未具備，
 *   核心不猜格式、不補零、不換算。true＝持有、無效期（特護的技術標籤與無效期證書；班守 D1 不寫入 true）。
 *   基準日 onDate 不是 ISO 日期時直接拋 TypeError，不靜默比較字串。
 * candidateDelta／benchFor 只判能力：合法性（班間休息、連續上班、預假、H 規則）由宿主先篩好再傳入；
 *   benchFor 只篩選、保留輸入順序、不重排。
 */

const COMPETENCE_KERNEL_VERSION = '1.0.0';

/** 嚴格 YYYY-MM-DD，且須為真實存在的日曆日 */
function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * 通用分級判定（臨床進階與特護的技能分級共用）：scale 由低到高。
 * 空值 unrated；不在序列內 invalid；未給門檻時，凡在序列內即 meets。
 * 門檻本身不在序列內時無人達標（below）——不猜，寧可不算。
 */
function rankStatus(value, scale, atLeast) {
  if (ckBlank(value)) return 'unrated';
  const list = Array.isArray(scale) ? scale : [];
  const r = list.indexOf(value);
  if (r < 0) return 'invalid';
  if (ckBlank(atLeast)) return 'meets';
  const need = list.indexOf(atLeast);
  return need >= 0 && r >= need ? 'meets' : 'below';
}

/** 某人某項能力在 onDate 當天的徽章；opts.expiringDays 為到期提醒視窗（天，預設 0＝不區分） */
function badgeOf(catalog, person, code, onDate, opts) {
  if (!isIsoDate(onDate)) throw new TypeError(`badgeOf：基準日須為 YYYY-MM-DD 的真實日期（收到 ${String(onDate)}）`);
  const expiringDays = (opts && opts.expiringDays) || 0;
  const def = ckOwn(catalog && catalog.competences, code);
  const label = (def && def.label) || code;
  const mk = (kind, status, more) => ({
    code, label, kind, status,
    counts: status === 'valid' || status === 'expiring',
    expiry: null, daysLeft: null, noExpiry: false, text: '',
    ...more,
  });
  if (!person || !def || !(def.cert || def.ladderAtLeast)) return mk('unknown', 'missing', { text: '無法確認' });

  if (def.cert) {
    const raw = ckOwn(person.certs, def.cert);
    if (ckBlank(raw) || raw === false) return mk('cert', 'missing', { text: `未持有${label}` });
    if (raw === true) return mk('cert', 'valid', { noExpiry: true });
    if (!isIsoDate(raw)) {
      const shown = String(raw);
      return mk('cert', 'invalid', { expiry: shown, text: `${label}效期「${shown}」無法判讀，視同未具備` });
    }
    const daysLeft = ckDay(raw) - ckDay(onDate);
    if (daysLeft < 0) return mk('cert', 'expired', { expiry: raw, daysLeft, text: `${label}已於 ${raw} 過期` });
    if (expiringDays > 0 && daysLeft <= expiringDays) {
      return mk('cert', 'expiring', { expiry: raw, daysLeft, text: `${label}將於 ${raw} 到期（剩 ${daysLeft} 天）` });
    }
    return mk('cert', 'valid', { expiry: raw, daysLeft });
  }

  const v = person.ladder;
  const st = rankStatus(v, catalog.ladder, def.ladderAtLeast);
  if (st === 'unrated') return mk('ladder', 'unrated', { text: '臨床進階未登錄' });
  if (st === 'invalid') return mk('ladder', 'invalid', { text: `臨床進階登錄值「${v}」無法辨識，視同未達${label}` });
  if (st === 'below') return mk('ladder', 'below', { text: `臨床進階 ${v} 未達${label}` });
  return mk('ladder', 'valid', {});
}

/**
 * 候選人補進這一格會改變什麼（「為什麼是找你不找他」的能力面）：
 *   fills／still  補人前就不足的 atLeast 能力，依此人能否補足分開
 *   lacks         此人不計入的 allMust 能力（Badge，附中文說明）
 *   restores      補進後每項 atLeast 都達標，且此人具備全部 allMust＝可完整補回
 * onShift 是這一格已在班的人（不含被替補者）。
 */
function candidateDelta(catalog, needs, onShift, candidate, onDate, opts) {
  const n = needs || {};
  const holds = (p, c) => badgeOf(catalog, p, c, onDate, opts).counts;
  const fills = [];
  const still = [];
  (n.atLeast || []).forEach(({ competence, min }) => {
    const need = typeof min === 'number' ? min : 1;
    const have = (onShift || []).filter((p) => holds(p, competence)).length;
    if (have >= need) return;
    (have + (holds(candidate, competence) ? 1 : 0) >= need ? fills : still).push(competence);
  });
  const lacks = (n.allMust || []).map((c) => badgeOf(catalog, candidate, c, onDate, opts)).filter((b) => !b.counts);
  return { staffId: candidate ? candidate.id : null, fills, still, lacks, restores: still.length === 0 && lacks.length === 0 };
}

/** 後備深度：people 逐一判定，bench＝可完整補回者（依輸入順序，只篩不排） */
function benchFor(catalog, needs, onShift, people, onDate, opts) {
  const rows = (people || []).map((p) => candidateDelta(catalog, needs, onShift, p, onDate, opts));
  const bench = rows.filter((r) => r.restores).map((r) => r.staffId);
  return { depth: bench.length, bench, rows };
}

/** 0 broken（不斷班警訊）／1 thin／2 以上 ok */
function benchLevel(depth) {
  return depth >= 2 ? 'ok' : depth === 1 ? 'thin' : 'broken';
}

/* ── 私有輔助（ck 前綴） ── */
function ckBlank(v) { return v === undefined || v === null || v === ''; }

/** 只讀自有屬性：代碼撞到 'constructor' 之類的原型鍵時不誤判為持有 */
function ckOwn(obj, key) {
  return obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** ISO 日期 → 自 1970-01-01 起的日數（UTC，整數） */
function ckDay(iso) { return Date.parse(`${iso}T00:00:00Z`) / 86400000; }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COMPETENCE_KERNEL_VERSION, isIsoDate, rankStatus, badgeOf, candidateDelta, benchFor, benchLevel };
}
