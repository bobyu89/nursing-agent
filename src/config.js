/**
 * config.js — 平台的部署參數（唯一需要依環境改的檔）
 *
 * PLATFORM_API：Cloudflare Worker（cloudflare/linebot）的網址。平台以 LINE 身分登入後
 * 從這裡讀雲端即時班表（D1）與送預假（docs/LINEBOT-STAGE1.md §0 第 11 個決定、§6 Phase 3）。
 * 沒登入（雙擊 index.html、直接開 GitHub Pages）時完全不呼叫——仍是離線示範模式。
 *
 * 本機開發可用 localStorage 覆寫（只影響這個瀏覽器）：
 *   localStorage.setItem('shiftguard.api', 'http://localhost:8790')
 */
const PLATFORM_API = (() => {
  try {
    const o = localStorage.getItem('shiftguard.api');
    if (o && /^https?:\/\//.test(o)) return o.replace(/\/+$/, '');
  } catch (e) { /* 無痕模式等情況拿不到 localStorage */ }
  return 'https://shiftguard-linebot.shiftguard-navicare.workers.dev';
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { PLATFORM_API };
