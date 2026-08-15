/**
 * worker.mjs — 班守 ShiftGuard LINE 通報機器人（Cloudflare Workers 免費版）
 *
 * 零成本路線：不碰 AWS、不呼叫任何 LLM。
 * 解析器就是平台的同一份確定性 mock 解析器（src/llm.js 關鍵詞規則）——
 * wrangler 打包時直接引入原始檔，「同一份程式碼在瀏覽器、測試頁、
 * CI 與 LINE bot 上跑」的故事延伸到第四個環境。
 *
 * 誠實聲明（與平台一致）：關鍵詞規則的理解力弱於真實模型，
 * 但確定性、離線可驗證，且通報訊息只在本 Worker 內處理、
 * 不送往任何第三方模型端點——個資面反而更乾淨。
 *
 * 治理邊界：機器人只做解析與轉達；不建立正式事件、不指派、不代替主管決定。
 */
import crypto from 'node:crypto';
import data from '../../src/data.js';
import rules from '../../src/rules.js';
import engine from '../../src/engine.js';
import llm from '../../src/llm.js';

// 依 index.html 的載入語義把全域掛回（與 tests/run-node.js 同一招）
Object.assign(globalThis, data, rules, engine, llm);

const FIELD_TW = { date: '日期', shift: '班別', unit: '單位', requiredCerts: '必要資格', reason: '事由' };

/** 台北時區的今天（Workers 跑 UTC；「明天」要以台灣日曆換算） */
function todayTaipei() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** LINE 簽章驗證：channel secret 對原始 body 做 HMAC-SHA256，比對 base64 */
function validSignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const mac = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let sig;
  try { sig = Buffer.from(signature, 'base64'); } catch { return false; }
  return mac.length === sig.length && crypto.timingSafeEqual(mac, sig);
}

async function lineReply(channelToken, replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${channelToken}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
  if (!res.ok) console.log('LINE reply failed:', res.status, await res.text());
}

/** 解析結果 → LINE 文字訊息（label 由解析器生成，本檔不改寫任何解析值） */
function formatParsed(parsed, platformUrl) {
  const ex = (parsed && parsed.extracted) || {};
  const lines = ['【班守 ShiftGuard】已收到缺班通報，解析如下：'];
  ['date', 'shift', 'unit', 'requiredCerts', 'reason'].forEach((f) => {
    const field = ex[f];
    if (field && field.label) lines.push(`・${FIELD_TW[f]}：${field.label}`);
  });
  const missing = (parsed && parsed.missing) || [];
  if (missing.length) {
    lines.push('', '訊息未載明、需主管補充：');
    missing.forEach((m) => lines.push(`・${m.question || FIELD_TW[m.field] || m.field}`));
  }
  lines.push(
    '',
    '主管請至平台確認條件並評估替補（每一步留痕）：',
    platformUrl,
    '',
    '－機器人只做解析與轉達，不做任何排班決定；',
    '　解析為確定性關鍵詞規則，內容以主管確認為準－',
  );
  return lines.join('\n');
}

const welcomeText = (platformUrl) => [
  '【班守 ShiftGuard】值班通報機器人',
  '',
  '臨時請假／缺班，把訊息直接傳到這裡，我會解析日期、班別與事由並轉達值班主管。',
  '範例：「護理長不好意思，我明天白班發燒沒辦法上，很抱歉」',
  '',
  '提醒：請以人員代號通報；訊息中請勿包含任何病人資訊。',
  `平台入口：${platformUrl}`,
].join('\n');

async function handleEvent(ev, env) {
  const platformUrl = env.PLATFORM_URL || 'https://bobyu89.github.io/nursing-agent/';
  if (ev.type === 'follow' && ev.replyToken) {
    return lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, ev.replyToken, welcomeText(platformUrl));
  }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !ev.replyToken) return;

  const text = String(ev.message.text || '').slice(0, 2000);
  // mock 解析的日期換算基準取自 GAP_EVENT.raisedAt（demo 固定日）；
  // 通報機器人以「台灣的今天」為基準，「明天／禮拜天」才會算對
  globalThis.GAP_EVENT.raisedAt = `${todayTaipei()} 08:00`;
  globalThis.LLM.mode = 'mock';   // Worker 恆為確定性解析，不走任何外部端點
  const parsed = await globalThis.llmParseGapMessage(text);
  return lineReply(env.LINE_CHANNEL_ACCESS_TOKEN, ev.replyToken, formatParsed(parsed, platformUrl));
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('shiftguard linebot: alive', { status: 200 });
    }
    const raw = await request.text();
    const sig = request.headers.get('x-line-signature');
    if (!validSignature(env.LINE_CHANNEL_SECRET || '', raw, sig)) {
      return new Response('signature validation failed', { status: 403 });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
    await Promise.all((body.events || []).map(
      (ev) => handleEvent(ev, env).catch((err) => console.log('event error:', err))));
    return new Response('ok', { status: 200 });
  },
};
