/**
 * live.js — 平台以 LINE 身分登入的 session 與 API 呼叫（index.html 與 prebook.html 共用）
 *
 * 流程（docs/LINEBOT-STAGE1.md §0 第 11 個決定）：
 *   LINE 輸入「平台」→ 機器人回本人專屬連結（#t=簽章 link token，10 分鐘）
 *   → 開頁：把 link token 換成 session token（12 小時，存 sessionStorage、只在這個分頁）
 *   → 之後的 API 呼叫帶 Authorization: Bearer <session>
 *
 * 沒有 token、換不到 session、或 API 失敗：一律回落離線示範模式，不擋任何畫面。
 * 這裡不碰 DOM、不碰業務資料；只管「我是誰」與「怎麼呼叫」。
 */
const LIVE_SESSION_KEY = 'shiftguard.session.v1';

const LIVE = {
  active: false,     // 已登入且快照載入成功
  identity: null,    // { staff_id, unit, role, tier }
  session: null,     // session token
  exp: 0,            // session 到期（ms）
  scope: null,       // 資料範圍：單位代碼；null＝全院
  loadedAt: null,    // 快照時間
  version: null,     // 班表版本（樂觀鎖；寫回時帶回去）
  canWrite: false,   // 護理長才可寫回
  error: null,       // 最後一次失敗的人話說明
};

function liveReadHashToken() {
  const m = /[#&]t=([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/.exec(location.hash || '');
  return m ? m[1] : null;
}

function liveStripHash() {
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
}

function liveLoadSession() {
  try {
    const raw = sessionStorage.getItem(LIVE_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.session || !(s.exp > Date.now())) return null;
    return s;
  } catch (e) { return null; }
}

function liveSaveSession(s) {
  try { sessionStorage.setItem(LIVE_SESSION_KEY, JSON.stringify(s)); } catch (e) {}
}

function liveClearSession() {
  try { sessionStorage.removeItem(LIVE_SESSION_KEY); } catch (e) {}
  LIVE.active = false; LIVE.identity = null; LIVE.session = null; LIVE.exp = 0; LIVE.scope = null;
}

/** 呼叫 Worker API；401 即清 session 並丟出人話錯誤 */
async function liveFetch(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
  if (LIVE.session) headers.authorization = `Bearer ${LIVE.session}`;
  if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); headers['content-type'] = 'application/json'; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(PLATFORM_API + path, Object.assign({}, opts, { headers, signal: ctrl.signal, cache: 'no-store' }));
  } finally { clearTimeout(timer); }
  let body = null;
  try { body = await res.json(); } catch (e) {}
  if (res.status === 401) { liveClearSession(); }
  if (!res.ok) {
    const err = new Error((body && body.message) || `API ${res.status}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

/**
 * 建立 session：先看網址的 #t=（換 session），再看 sessionStorage。
 * 回 true＝有可用 session；false＝離線示範模式。
 */
async function liveEstablish() {
  const linkToken = liveReadHashToken();
  if (linkToken) {
    liveStripHash();   // 連結 token 不留在網址列／歷史（分享截圖也不外洩）
    try {
      const r = await liveFetch(`/api/session?t=${encodeURIComponent(linkToken)}`);
      const s = { session: r.session, exp: r.exp, identity: r.identity };
      liveSaveSession(s);
      LIVE.session = s.session; LIVE.exp = s.exp; LIVE.identity = s.identity;
      return true;
    } catch (e) {
      LIVE.error = e.message || String(e);
      return false;
    }
  }
  const s = liveLoadSession();
  if (!s) return false;
  LIVE.session = s.session; LIVE.exp = s.exp; LIVE.identity = s.identity;
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LIVE, LIVE_SESSION_KEY, liveReadHashToken, liveEstablish, liveFetch, liveClearSession };
}
