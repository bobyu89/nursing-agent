/**
 * linebot/index.mjs — 班守 ShiftGuard LINE 通報機器人（Webhook Lambda）
 *
 * 定位：通報入口放在護理人員本來就在用的 LINE；解析與決策留在平台。
 *   護理師 LINE 訊息 → LINE Messaging API → 本 Lambda（驗章）
 *     → 既有 LLM Proxy（aws/lambda，Bedrock 解析）→ 回覆解析摘要＋追問＋平台連結
 *
 * 治理邊界（與平台一致）：
 * - 機器人只做「解析與轉達」——不建立正式缺班事件、不指派、不代替主管決定。
 * - 訊息沒寫的欄位轉為追問，不臆測（由 LLM Proxy 的不臆測原則保證）。
 * - 未設定 LLM_PROXY_URL 時退化為「確認收到＋轉達」，服務不中斷（同 mock 退路哲學）。
 *
 * 資安：
 * - 所有請求先驗 X-Line-Signature（HMAC-SHA256 + timingSafeEqual），
 *   非 LINE 平台簽發的請求一律 403——Function URL 雖為公開端點，偽造來源進不來。
 * - 金鑰只存在 Lambda 環境變數；本檔不落地任何憑證。
 * - 只使用 reply message（回覆免費、不消耗推播額度），不主動推播。
 *
 * Runtime：nodejs20.x，零相依（global fetch ＋ node:crypto）。
 */
import crypto from 'node:crypto';

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

async function lineReply(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CHANNEL_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
  if (!res.ok) console.error('LINE reply failed:', res.status, await res.text());
}

/** 轉發既有 LLM Proxy 解析；失敗回 null（呼叫端走退路，服務不中斷） */
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

const FIELD_TW = { date: '日期', shift: '班別', unit: '單位', requiredCerts: '必要資格', reason: '事由' };

/** 解析結果 → LINE 文字訊息（label 由 Proxy 生成，本檔不改寫任何解析值） */
function formatParsed(parsed) {
  const ex = parsed.extracted || {};
  const lines = ['【班守 ShiftGuard】已收到缺班通報，解析如下：'];
  ['date', 'shift', 'unit', 'requiredCerts', 'reason'].forEach((f) => {
    const field = ex[f];
    if (field && field.label) lines.push(`・${FIELD_TW[f]}：${field.label}`);
  });
  const missing = parsed.missing || [];
  if (missing.length) {
    lines.push('', '訊息未載明、需主管補充：');
    missing.forEach((m) => lines.push(`・${m.question || FIELD_TW[m.field] || m.field}`));
  }
  lines.push(
    '',
    '主管請至平台確認條件並評估替補（每一步留痕）：',
    PLATFORM_URL,
    '',
    '－機器人只做解析與轉達，不做任何排班決定－',
  );
  return lines.join('\n');
}

/** 解析服務未啟用／暫時失敗時的退路：確認收到、原文轉達，服務不中斷 */
function formatFallback(text) {
  return [
    '【班守 ShiftGuard】已收到缺班通報（解析服務暫未啟用，原文已轉達值班主管）：',
    '',
    `「${text.slice(0, 300)}」`,
    '',
    '主管請至平台建立缺班事件：',
    PLATFORM_URL,
  ].join('\n');
}

const WELCOME = [
  '【班守 ShiftGuard】值班通報機器人',
  '',
  '臨時請假／缺班，把訊息直接傳到這裡，我會解析日期、班別與事由並轉達值班主管。',
  '範例：「護理長不好意思，我明天白班發燒沒辦法上，很抱歉」',
  '',
  '提醒：請以人員代號通報；訊息中請勿包含任何病人資訊。',
  `平台入口：${PLATFORM_URL}`,
].join('\n');

async function handleEvent(ev) {
  if (ev.type === 'follow' && ev.replyToken) return lineReply(ev.replyToken, WELCOME);
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !ev.replyToken) return;
  const text = String(ev.message.text || '').slice(0, 2000);
  const parsed = await parseViaProxy(text);
  const reply = parsed && parsed.extracted ? formatParsed(parsed) : formatFallback(text);
  return lineReply(ev.replyToken, reply);
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
