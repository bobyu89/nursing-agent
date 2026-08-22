/**
 * linebot/index.mjs — 班守 ShiftGuard LINE 通報機器人（Webhook Lambda，真模型版）
 *
 * 定位：通報入口放在護理人員本來就在用的 LINE。
 *   解析走既有 LLM Proxy（aws/lambda → Bedrock）；解析結果經 sanitizeParsed
 *   白名單消毒後，走與 Cloudflare 版完全相同的互動流程（src/botcore.js）：
 *   缺條件出按鈕 → 條件齊全跑同一份 evaluateGap 引擎（規則 H1–H9，
 *   含勞基法四週彈性工時 H7–H9）→ 替補建議前三名 → 詢問草稿 → 戰情儀表板。
 *
 * 與 Cloudflare 版的差別只有兩件事：
 *   1. 解析優先用 Bedrock 真模型（LLM_PROXY_URL）；Proxy 未設定或失敗時
 *      退回本機確定性解析（同一份 src/llm.js mock），服務不中斷。
 *   2. 部署打包：aws/deploy.ps1 會把 src/{data,rules,engine,llm,botcore}.js
 *      連同 src/package.json（{"type":"commonjs"}）一起裝進 zip——
 *      「同一份程式碼在瀏覽器、測試頁、CI、Workers 與 Lambda 上跑」。
 *
 * 治理邊界（與平台一致）：
 * - 機器人提供「建議」，不做指派決定——正式確認與決策留痕在平台。
 * - 訊息沒寫的欄位轉為追問（按鈕），不臆測；模型輸出一律經白名單消毒。
 *
 * 資安：
 * - 所有請求先驗 X-Line-Signature（HMAC-SHA256 + timingSafeEqual），
 *   非 LINE 平台簽發的請求一律 403——Function URL 雖為公開端點，偽造來源進不來。
 * - 金鑰只存在 Lambda 環境變數；本檔不落地任何憑證。
 * - 只使用 reply message（回覆免費、不消耗推播額度），不主動推播。
 *
 * Runtime：nodejs20.x，零外部相依（global fetch ＋ node:crypto）。
 */
import crypto from 'node:crypto';
import data from './src/data.js';
import rules from './src/rules.js';
import engineMod from './src/engine.js';
import llm from './src/llm.js';
import botcore from './src/botcore.js';

// 依 index.html 的載入語義把全域掛回（與 tests/run-node.js、worker.mjs 同一招）
Object.assign(globalThis, data, rules, engineMod, llm, botcore);

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LLM_PROXY_URL = process.env.LLM_PROXY_URL || '';   // 既有 aws/lambda 的 Function URL（可選）
const DEMO_TOKEN = process.env.DEMO_TOKEN || '';          // 與 LLM Proxy 相同的通行碼
const PLATFORM_URL = process.env.PLATFORM_URL || 'https://bobyu89.github.io/nursing-agent/';

/** 台北時區的今天（Lambda 預設 UTC；「明天」要以台灣日曆換算） */
function todayTaipei() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** LINE 簽章驗證：channel secret 對原始 body 做 HMAC-SHA256，比對 base64 */
function validSignature(rawBody, signature) {
  if (!CHANNEL_SECRET || !signature) return false;
  const mac = crypto.createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest();
  let sig;
  try { sig = Buffer.from(signature, 'base64'); } catch { return false; }
  return mac.length === sig.length && crypto.timingSafeEqual(mac, sig);
}

/** 低階回覆：直接送 messages 陣列（文字、Flex 皆可） */
async function lineReplyMessages(replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CHANNEL_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) console.error('LINE reply failed:', res.status, await res.text());
}

/** 回覆文字訊息（可含快速回覆按鈕） */
async function lineReply(replyToken, text, quickItems) {
  const message = { type: 'text', text: text.slice(0, 4900) };
  if (quickItems && quickItems.length) {
    message.quickReply = {
      items: quickItems.map(({ label, dataStr }) => ({
        type: 'action',
        action: { type: 'postback', label: label.slice(0, 20), data: dataStr, displayText: label },
      })),
    };
  }
  return lineReplyMessages(replyToken, [message]);
}

/** 轉發既有 LLM Proxy 解析；失敗回 null（呼叫端退回本機確定性解析） */
async function parseViaProxy(rawText) {
  if (!LLM_PROXY_URL) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch(LLM_PROXY_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-demo-token': DEMO_TOKEN },
      body: JSON.stringify({ task: 'parse_gap', payload: { rawText, refDate: todayTaipei() } }),
    });
    clearTimeout(timer);
    if (!res.ok) { console.error('proxy status:', res.status); return null; }
    return await res.json();
  } catch (err) {
    console.error('proxy error:', err);
    return null;
  }
}

/**
 * 解析：Bedrock（Proxy）優先，退回本機確定性規則（同一份 src/llm.js mock）。
 * 模型輸出不可直接信任——一律經 sanitizeParsed 白名單消毒；
 * 消毒失敗（形狀不符）視同解析失敗，走本機退路，服務不中斷。
 */
async function parseMessage(text) {
  globalThis.GAP_EVENT.raisedAt = `${todayTaipei()} 08:00`;   // 「明天」以台灣今天為基準
  const viaProxy = await parseViaProxy(text);
  if (viaProxy && viaProxy.extracted) {
    try { return globalThis.sanitizeParsed(viaProxy); }
    catch (err) { console.error('sanitize failed, fallback to mock:', err); }
  }
  globalThis.LLM.mode = 'mock';
  return globalThis.llmParseGapMessage(text);
}

/* ── 事件處理（流程與訊息組裝在 src/botcore.js，與 Cloudflare 版同一份）── */

async function handleEvent(ev) {
  if (ev.type === 'follow' && ev.replyToken) return lineReply(ev.replyToken, welcomeText(PLATFORM_URL));

  /* 按鈕回傳：條件逐步補齊 → 齊全即評估；帶 id 則產生詢問草稿 */
  if (ev.type === 'postback' && ev.replyToken) {
    const p = decodeParams(ev.postback && ev.postback.data);
    if (!p.d) return lineReply(ev.replyToken, '這筆通報的日期不明，請重新傳一次請假訊息（例：我明天白班沒辦法上）。');
    if (p.id) {
      const out = await draftAndFormat(p, PLATFORM_URL);
      return lineReply(ev.replyToken, out.text, out.items);
    }
    const ask = askNext(p);
    if (ask) return lineReply(ev.replyToken, ask.text, ask.items);
    const out = evaluateAndFormat(p, PLATFORM_URL);
    return lineReply(ev.replyToken, out.text, out.items);
  }

  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !ev.replyToken) return;

  /* 文字訊息：指令（儀表板／選單）優先，其餘走解析流程 */
  const text = String(ev.message.text || '').slice(0, 2000);
  if (DASHBOARD_RE.test(text.trim())) {
    return lineReplyMessages(ev.replyToken, [buildDashboardFlex(PLATFORM_URL)]);
  }
  if (MENU_RE.test(text.trim())) {
    return lineReplyMessages(ev.replyToken, [menuMessage(PLATFORM_URL)]);
  }
  // 指令三兄弟：換班預檢／調度棋盤／負荷雷達（皆為確定性引擎，未命中回 null）
  const extra = extraCommand(text.trim(), PLATFORM_URL);
  if (extra) return lineReply(ev.replyToken, extra.text, extra.items);

  const parsed = await parseMessage(text);
  const ex = (parsed && parsed.extracted) || {};

  const lines = ['【班守 ShiftGuard】已收到缺班通報，解析如下：'];
  ['date', 'shift', 'unit', 'requiredCerts', 'reason'].forEach((f) => {
    if (ex[f] && ex[f].label) lines.push(`・${FIELD_TW[f]}：${ex[f].label}`);
  });

  const p = {
    d: ex.date && ex.date.value ? ex.date.value : null,
    s: ex.shift && ex.shift.value ? ex.shift.value : null,
    u: ex.unit && ex.unit.value ? ex.unit.value : null,
    c: ex.requiredCerts && Array.isArray(ex.requiredCerts.value) && ex.requiredCerts.value.length
      ? ex.requiredCerts.value.join(',') : null,
  };

  if (!p.d) {
    lines.push('', '訊息中的日期無法明確換算（或含多個時間線索）——',
      '請補傳一句明確的說法，例如「明天」「8/20」「下週三」。');
    return lineReply(ev.replyToken, lines.join('\n'));
  }

  const ask = askNext(p);
  if (ask) {
    lines.push('', ask.text);
    return lineReply(ev.replyToken, lines.join('\n'), ask.items);
  }
  const out = evaluateAndFormat(p, PLATFORM_URL);
  return lineReply(ev.replyToken, out.text, out.items);
}

export const handler = async (event) => {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const sig = (event.headers || {})['x-line-signature'];
  if (!validSignature(raw, sig)) return { statusCode: 403, body: 'signature validation failed' };

  let body;
  try { body = JSON.parse(raw); } catch { return { statusCode: 400, body: 'bad json' }; }

  // LINE 要求 webhook 快速回 200；逐事件錯誤只記錄不拋出
  await Promise.all((body.events || []).map(
    (ev) => handleEvent(ev).catch((err) => console.error('event error:', err))));
  return { statusCode: 200, body: 'ok' };
};
