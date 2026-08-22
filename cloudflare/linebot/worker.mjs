/**
 * worker.mjs — 班守 ShiftGuard LINE 通報機器人（Cloudflare Workers 免費版）
 *
 * 零成本路線：不碰 AWS、不呼叫任何 LLM。
 * 解析器、決策引擎與互動流程都是平台的同一份程式碼
 * （src/llm.js、src/engine.js、src/botcore.js）——wrangler 打包時直接引入
 * 原始檔，「同一份程式碼在瀏覽器、測試頁、CI 與 LINE bot 上跑」。
 * 規則庫 H1–H10 全數生效（含四週彈性工時 H7–H9 與母性保護 H10，
 * 週期錨點 FLEX_CYCLE_ANCHOR 與平台一致）。
 *
 * 互動流程（無狀態；條件以 postback data 夾帶，不需要任何資料庫）：
 *   1. 傳請假訊息 → 確定性解析（日期／班別／事由，缺漏不臆測）
 *   2. 缺哪個條件，就跳「快速回覆按鈕」讓主管點選（班別 → 單位 → 必要資格）
 *   3. 條件齊全 → 同一份 evaluateGap 引擎排序 → 回覆替補建議前三名
 *      （分數＋依據）＋排除摘要＋平台連結
 *
 * 本檔只負責 Workers 特有的部分：LINE 簽章驗證、reply API、
 * 白名單／頻率限制／告警；訊息組裝全部在 src/botcore.js。
 *
 * 治理邊界：機器人提供「建議」，不做指派決定——正式確認與決策留痕在平台。
 * 誠實聲明：示範資料（虛構人員）；解析為確定性關鍵詞規則。
 */
import crypto from 'node:crypto';
import data from '../../src/data.js';
import rules from '../../src/rules.js';
import engineMod from '../../src/engine.js';
import llm from '../../src/llm.js';
import botcore from '../../src/botcore.js';

// 依 index.html 的載入語義把全域掛回（與 tests/run-node.js 同一招）
Object.assign(globalThis, data, rules, engineMod, llm, botcore);

/* ── 濫用防護（偵測 → 應對 → 告警）────────────────────────
 * 白名單：ALLOWED_USERS（逗號分隔的 LINE userId）設定後，名單外的使用者
 *   只會收到「請提供識別碼給管理者開通」——拿不到任何人事資訊。
 *   未設定＝示範開放模式，但每個新使用者都寫入 [SEC] 日誌供蒐集。
 * 頻率限制：每人每分鐘上限（記憶體滑動視窗）。Workers isolate 可能隨時回收，
 *   此為「盡力而為」的第一道消耗保護；正式導入改 Durable Objects／WAF 規則。
 * 告警：設定 ADMIN_USER_ID 後，安全事件以 push 通知管理者
 *   （每個 isolate 對同一使用者只告警一次，避免告警本身被拿來洗推播額度）。
 * 日誌：一律帶 [SEC] 前綴——`wrangler tail --search "[SEC]"` 就是監看台。
 */
const RATE_LIMIT = 10;            // 每人每 60 秒訊息上限
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();    // userId → [timestamps]
const alerted = new Set();        // 本 isolate 已告警的 userId
const seenUsers = new Set();      // 開放模式下已記錄的 userId

function secLog(type, detail) {
  console.log(`[SEC] ${type} ${detail}`);
}

function allowedUser(env, userId) {
  const list = (env.ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;   // 開放模式（示範）
  return !!userId && list.includes(userId);
}

function overRateLimit(userId) {
  const now = Date.now();
  const arr = (rateBuckets.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateBuckets.set(userId, arr);
  return arr.length > RATE_LIMIT;
}

async function adminAlert(env, userId, text) {
  if (!env.ADMIN_USER_ID || alerted.has(userId)) return;
  alerted.add(userId);
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ to: env.ADMIN_USER_ID, messages: [{ type: 'text', text: `【班守｜安全告警】${text}`.slice(0, 1000) }] }),
    });
  } catch (err) { console.log('[SEC] alert-failed', String(err)); }
}

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

/** 低階回覆：直接送 messages 陣列（文字、Flex 皆可） */
async function lineReplyMessages(channelToken, replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${channelToken}` },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) console.log('LINE reply failed:', res.status, await res.text());
}

/** 回覆文字訊息（可含快速回覆按鈕） */
async function lineReply(channelToken, replyToken, text, quickItems) {
  const message = { type: 'text', text: text.slice(0, 4900) };
  if (quickItems && quickItems.length) {
    message.quickReply = {
      items: quickItems.map(({ label, dataStr }) => ({
        type: 'action',
        action: { type: 'postback', label: label.slice(0, 20), data: dataStr, displayText: label },
      })),
    };
  }
  return lineReplyMessages(channelToken, replyToken, [message]);
}

/* ── 事件處理（流程與訊息組裝在 src/botcore.js）── */

async function handleEvent(ev, env) {
  const platformUrl = env.PLATFORM_URL || 'https://bobyu89.github.io/nursing-agent/';
  // LIFF（選配）：wrangler.toml 填入 LIFF_ID 後，入口按鈕改以全高視窗在 LINE 內開啟平台
  const liffUrl = env.LIFF_ID ? `https://liff.line.me/${env.LIFF_ID}` : null;
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const userId = (ev.source && ev.source.userId) || 'unknown';

  /* 第一道：白名單。名單外的使用者拿不到任何功能與人事資訊 */
  if (!allowedUser(env, userId)) {
    secLog('blocked-user', userId);
    await adminAlert(env, userId, `名單外使用者嘗試使用機器人：${userId}`);
    if (ev.replyToken && (ev.type === 'message' || ev.type === 'follow' || ev.type === 'postback')) {
      return lineReply(token, ev.replyToken, [
        '此為院內內部系統，您的帳號尚未開通。',
        '如需使用，請把下方識別碼提供給管理者：',
        userId,
      ].join('\n'));
    }
    return;
  }
  if (!seenUsers.has(userId)) {
    seenUsers.add(userId);
    secLog('user-active', userId + ((env.ALLOWED_USERS || '').trim() ? '' : ' (open-mode)'));
  }

  /* 第二道：頻率限制。超限先警告一次，之後靜默丟棄（不回覆＝不被拿來耗資源）*/
  if (ev.type === 'message' || ev.type === 'postback') {
    if (overRateLimit(userId)) {
      secLog('rate-limited', userId);
      await adminAlert(env, userId, `使用者觸發頻率限制（>${RATE_LIMIT} 則/分）：${userId}`);
      const arr = rateBuckets.get(userId) || [];
      if (arr.length === RATE_LIMIT + 1 && ev.replyToken) {
        return lineReply(token, ev.replyToken, '訊息過於頻繁，請稍候一分鐘再試。');
      }
      return;   // 靜默丟棄
    }
  }

  if (ev.type === 'follow' && ev.replyToken) {
    return lineReply(token, ev.replyToken, welcomeText(platformUrl));
  }

  /* 按鈕回傳：條件逐步補齊 → 齊全即評估；帶 id 則產生詢問草稿 */
  if (ev.type === 'postback' && ev.replyToken) {
    const p = decodeParams(ev.postback && ev.postback.data);
    if (!p.d) return lineReply(token, ev.replyToken, '這筆通報的日期不明，請重新傳一次請假訊息（例：我明天白班沒辦法上）。');
    if (p.id) {
      const out = await draftAndFormat(p, platformUrl);
      return lineReply(token, ev.replyToken, out.text, out.items);
    }
    const ask = askNext(p);
    if (ask) return lineReply(token, ev.replyToken, ask.text, ask.items);
    const out = evaluateAndFormat(p, platformUrl);
    return lineReply(token, ev.replyToken, out.text, out.items);
  }

  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !ev.replyToken) return;

  /* 文字訊息：指令（儀表板／選單）優先，其餘走解析流程 */
  const text = String(ev.message.text || '').slice(0, 2000);
  if (DASHBOARD_RE.test(text.trim())) {
    return lineReplyMessages(token, ev.replyToken, [buildDashboardFlex(platformUrl, liffUrl)]);
  }
  if (MENU_RE.test(text.trim())) {
    return lineReplyMessages(token, ev.replyToken, [menuMessage(platformUrl, liffUrl)]);
  }
  // 指令三兄弟：換班預檢／調度棋盤／負荷雷達（皆為確定性引擎，未命中回 null）
  const extra = extraCommand(text.trim(), platformUrl);
  if (extra) return lineReply(token, ev.replyToken, extra.text, extra.items);
  globalThis.GAP_EVENT.raisedAt = `${todayTaipei()} 08:00`;   // 「明天」以台灣今天為基準
  globalThis.LLM.mode = 'mock';                                // 恆為確定性解析
  const parsed = await globalThis.llmParseGapMessage(text);
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
    return lineReply(token, ev.replyToken, lines.join('\n'));
  }

  const ask = askNext(p);
  if (ask) {
    lines.push('', ask.text);
    return lineReply(token, ev.replyToken, lines.join('\n'), ask.items);
  }
  const out = evaluateAndFormat(p, platformUrl);
  return lineReply(token, ev.replyToken, out.text, out.items);
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('shiftguard linebot: alive', { status: 200 });
    }
    const raw = await request.text();
    const sig = request.headers.get('x-line-signature');
    if (!validSignature(env.LINE_CHANNEL_SECRET || '', raw, sig)) {
      secLog('bad-signature', `ip=${request.headers.get('cf-connecting-ip') || '?'} len=${raw.length}`);
      return new Response('signature validation failed', { status: 403 });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
    await Promise.all((body.events || []).map(
      (ev) => handleEvent(ev, env).catch((err) => console.log('event error:', err))));
    return new Response('ok', { status: 200 });
  },
};
