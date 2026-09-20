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
 * 本檔只負責 Workers 特有的部分：LINE 簽章驗證、reply／push API、
 * 白名單／頻率限制／告警、D1 與 cron 的接線；訊息組裝全部在 src/botcore.js。
 *
 * Stage 1 地基（docs/LINEBOT-STAGE1.md）：綁定 D1 後，
 *   ・身分：以 identity 表取代 ALLOWED_USERS；未綁定者只能看到綁定說明
 *   ・資料：人員與班表改讀 D1 快照（空表時回落 data.js 示範資料）
 *   ・指令：「發碼 N-04」（管理者）、「綁定 N-04 483920」（本人）
 *   ・cron：每分鐘清過期綁定碼（Phase 1 起掃替班逾時）
 * 未綁定 D1 時一切行為與 Stage 0 相同——示範部署零成本不變。
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
import { createD1Store, userHash } from './store-d1.mjs';

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

/** 管理者名單（ADMIN_USER_ID 逗號分隔可多人）；發碼與安全告警都以此為準 */
function adminIds(env) {
  return (env.ADMIN_USER_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function isAdmin(env, userId) {
  return !!userId && adminIds(env).includes(userId);
}

/** 主動推播（計 LINE 額度）。每一則 push 都要有理由——見設計 §2.3 */
async function linePush(channelToken, to, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${channelToken}` },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) console.log('LINE push failed:', res.status, await res.text());
  return res.ok;
}

async function adminAlert(env, userId, text) {
  const admins = adminIds(env);
  if (admins.length === 0 || alerted.has(userId)) return;
  alerted.add(userId);
  try {
    await linePush(env.LINE_CHANNEL_ACCESS_TOKEN, admins[0],
      [{ type: 'text', text: `【班守｜安全告警】${text}`.slice(0, 1000) }]);
  } catch (err) { console.log('[SEC] alert-failed', String(err)); }
}

/** Stage 1：D1 有綁定就建 store，否則 null（示範模式） */
function makeStore(env) {
  return env.DB ? createD1Store(env.DB, { auditCanonical: globalThis.auditCanonical }) : null;
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
/** botcore 的 items → LINE quickReply：{label, dataStr}＝postback；{label, text}＝直接送出文字 */
function quickReplyOf(items) {
  return { items: items.map((it) => {
    if (it && it.type === 'action' && it.action) return it;   // 已是 LINE 形狀（使用說明／選單）直接放行
    const { label, dataStr, text } = it;
    return {
      type: 'action',
      action: dataStr !== undefined
        ? { type: 'postback', label: label.slice(0, 20), data: dataStr, displayText: label }
        : { type: 'message', label: label.slice(0, 20), text },
    };
  }) };
}

async function lineReply(channelToken, replyToken, text, quickItems) {
  const message = { type: 'text', text: text.slice(0, 4900) };
  if (quickItems && quickItems.length) message.quickReply = quickReplyOf(quickItems);
  return lineReplyMessages(channelToken, replyToken, [message]);
}

/* ── 圖文選單依權責層掛載（docs/LINEBOT-STAGE1.md §2.4）──
 * id 來源兩處：wrangler.toml [vars] RICHMENU_*（若有設定優先），否則 D1 setting 表 richmenu.<tier>
 * （管理者在 LINE 輸入「建立選單」由 Worker 自己建好後寫入）。兩處都沒有＝不掛，不影響任何流程。 */
async function richMenuIdFor(env, store, tier) {
  const fromVar = ({ staff: env.RICHMENU_STAFF, head: env.RICHMENU_HEAD, exec: env.RICHMENU_EXEC })[tier];
  if (fromVar) return fromVar;
  if (!store || !store.getSetting) return null;
  try { return await store.getSetting(`richmenu.${tier}`); } catch { return null; }
}
async function lineRichMenuLink(channelToken, userId, richMenuId) {
  const res = await fetch(`https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`, {
    method: 'POST', headers: { authorization: `Bearer ${channelToken}` } });
  if (!res.ok) console.log('LINE richmenu link failed:', res.status, await res.text());
  return res.ok;
}
async function lineRichMenuUnlink(channelToken, userId) {
  const res = await fetch(`https://api.line.me/v2/bot/user/${userId}/richmenu`, {
    method: 'DELETE', headers: { authorization: `Bearer ${channelToken}` } });
  if (!res.ok && res.status !== 404) console.log('LINE richmenu unlink failed:', res.status, await res.text());
}
/** 綁定成功後：本人掛該 tier 的選單；換手機時舊帳號解除（退回全體預設＝未綁定選單） */
async function applyRichMenu(env, store, userId, bound) {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  try {
    if (bound.replacedLineUserId) await lineRichMenuUnlink(token, bound.replacedLineUserId);
    const id = await richMenuIdFor(env, store, bound.tier);
    if (id) await lineRichMenuLink(token, userId, id);
  } catch (err) { console.log('[RICHMENU] apply failed:', String(err)); }
}

/* ── 管理者「建立選單」：Worker 用自己手上的 channel token 建四份圖文選單 ──
 * 定義（richmenu-defs.json）與四張圖由 richmenu.ps1 -ImageOnly 產生、commit 後經 GitHub Pages 公開。
 * 一個 webhook 請求裡把四份做完會撞免費方案的單次請求預算（實測：第一份建好、第二份中途被砍、沒有例外可抓），
 * 所以拆成「工作」存在 D1 setting（richmenu.job），由每分鐘的 cron 一步一步推進——每一步各有自己的預算：
 *   unbound → staff → head → exec（各：建立 → 上傳圖 → unbound 設全體預設 → id 寫入 setting）
 *   → relink（已綁定者依 tier bulk link 整批重掛）→ cleanup（清掉自家舊版、留痕、推播報告給管理者）
 * 指令本身只登記工作並立刻回覆；本機不需要 token、不需要改 wrangler.toml、不需要重新部署。 */
const RICHMENU_NAME = 'shiftguard-menu';
const RICHMENU_JOB_KEY = 'richmenu.job';
const RICHMENU_STEPS = ['unbound', 'staff', 'head', 'exec', 'relink', 'cleanup'];

async function richMenuJobGet(store) {
  const raw = await store.getSetting(RICHMENU_JOB_KEY);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function richMenuJobStart(store, nowIso) {
  const job = { started_at: nowIso, next: 0, ids: {}, lines: [] };
  await store.setSetting(RICHMENU_JOB_KEY, JSON.stringify(job), nowIso);
  return job;
}

/** 推進一步；回 { pushes, done }。失敗＝記下原因、結束工作、推播報告（不會卡住下一次「建立選單」） */
async function richMenuJobTick(env, store, platformUrl, nowIso) {
  const job = await richMenuJobGet(store);
  if (!job) return { pushes: [], done: true };
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const auth = { authorization: `Bearer ${token}` };
  const base = platformUrl.replace(/\/?$/, '/') + 'cloudflare/linebot/';
  const step = RICHMENU_STEPS[job.next];
  const finish = async (ok) => {
    await store.deleteSetting(RICHMENU_JOB_KEY);
    await store.appendAudit({ ts: nowIso, actor: null, action: ok ? 'richmenu.built' : 'richmenu.failed', payload: { ids: job.ids, started_at: job.started_at, lines: job.lines } });
    const text = [ok ? '【圖文選單已建立】' : '【圖文選單建立失敗】', ...job.lines, '',
      ok ? 'id 已存進 D1，之後綁定成功的人會自動掛上對應層的選單；不需要改 wrangler.toml、不需要重新部署。'
        : '已停止。修好後再輸入一次「建立選單」即可從頭重來（舊的半成品會在最後一步一併清掉）。'].join('\n');
    return { pushes: [{ admin: true, text, items: null }], done: true };
  };
  try {
    if (job.next < 4) {
      const defsRes = await fetch(base + 'richmenu-defs.json');
      if (!defsRes.ok) { job.lines.push(`✗ 抓不到選單定義（${defsRes.status}）：${base}richmenu-defs.json——先 commit 並等 GitHub Pages 發布`); return finish(false); }
      const d = (await defsRes.json()).find((x) => x.key === step);
      if (!d) { job.lines.push(`✗ 定義檔裡沒有 ${step}`); return finish(false); }
      const body = { size: d.size, selected: true, name: `${RICHMENU_NAME}-${d.key}-${job.started_at.slice(0, 16).replace(/[-:T]/g, '')}`, chatBarText: d.chatBarText, areas: d.areas };
      const cr = await fetch('https://api.line.me/v2/bot/richmenu', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!cr.ok) { job.lines.push(`✗ ${step} 建立失敗 ${cr.status}：${(await cr.text()).slice(0, 200)}`); return finish(false); }
      const id = (await cr.json()).richMenuId;
      const img = await fetch(base + d.image);
      if (!img.ok) { job.lines.push(`✗ ${step} 抓不到圖（${img.status}）：${base}${d.image}`); return finish(false); }
      const up = await fetch(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, { method: 'POST', headers: { ...auth, 'content-type': 'image/png' }, body: await img.arrayBuffer() });
      if (!up.ok) { job.lines.push(`✗ ${step} 上傳圖失敗 ${up.status}：${(await up.text()).slice(0, 200)}`); return finish(false); }
      if (d.default) {
        const df = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${id}`, { method: 'POST', headers: auth });
        if (!df.ok) { job.lines.push(`✗ ${step} 設全體預設失敗 ${df.status}`); return finish(false); }
      }
      job.ids[step] = id;
      await store.setSetting(`richmenu.${step}`, id, nowIso);
      job.lines.push(`✓ ${step}${d.default ? '（全體預設）' : ''}：${id}`);
    } else if (step === 'relink') {
      const identities = await store.listAllIdentities();
      const byTier = {};
      for (const i of identities) if (job.ids[i.tier]) (byTier[i.tier] = byTier[i.tier] || []).push(i.line_user_id);
      let relinked = 0;
      for (const [tier, userIds] of Object.entries(byTier)) {
        for (let i = 0; i < userIds.length; i += 500) {
          const bl = await fetch('https://api.line.me/v2/bot/richmenu/bulk/link', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ richMenuId: job.ids[tier], userIds: userIds.slice(i, i + 500) }) });
          if (bl.ok) relinked += Math.min(500, userIds.length - i); else job.lines.push(`✗ ${tier} 重掛失敗 ${bl.status}`);
        }
      }
      job.lines.push(`✓ 已綁定者依權責層重掛：${relinked}／${identities.length} 人`);
    } else if (step === 'cleanup') {
      const keep = new Set(Object.values(job.ids));
      const listRes = await fetch('https://api.line.me/v2/bot/richmenu/list', { headers: auth });
      const old = listRes.ok ? ((await listRes.json()).richmenus || []).filter((m) => String(m.name || '').startsWith(RICHMENU_NAME) && !keep.has(m.richMenuId)) : [];
      for (const o of old) {
        const del = await fetch(`https://api.line.me/v2/bot/richmenu/${o.richMenuId}`, { method: 'DELETE', headers: auth });
        job.lines.push(`${del.ok ? '✓' : '✗'} 舊版已清除：${o.name}`);
      }
      return finish(true);
    }
  } catch (err) {
    job.lines.push(`✗ ${step}：${String(err).slice(0, 200)}`);
    return finish(false);
  }
  job.next += 1;
  await store.setSetting(RICHMENU_JOB_KEY, JSON.stringify(job), nowIso);
  return { pushes: [], done: false };
}

/* ── 事件處理（流程與訊息組裝在 src/botcore.js）── */

async function handleEvent(ev, env, { store, live }) {
  const platformUrl = env.PLATFORM_URL || 'https://bobyu89.github.io/nursing-agent/';
  // LIFF（選配）：wrangler.toml 填入 LIFF_ID 後，入口按鈕改以全高視窗在 LINE 內開啟平台
  const liffUrl = env.LIFF_ID ? `https://liff.line.me/${env.LIFF_ID}` : null;
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  const userId = (ev.source && ev.source.userId) || 'unknown';

  const nowIso = new Date().toISOString();
  const textIn = (ev.type === 'message' && ev.message && ev.message.type === 'text')
    ? String(ev.message.text || '').slice(0, 2000).trim() : '';

  /* 第一道：身分閘。
   * 有 D1：identity 表為準；未綁定者只允許「綁定」指令，其餘一律回綁定說明。管理者不受限。
   * 無 D1：維持 Stage 0 的 ALLOWED_USERS 白名單語義。 */
  /* 權責層：有 D1 以 identity.tier 為準（管理者視同 exec）；無 D1＝Stage 0 開放模式，一律 exec */
  let tier = 'exec';
  let identity = null;
  if (store) {
    identity = await store.getIdentityByUser(userId);
    if (identity && !isAdmin(env, userId)) tier = identity.tier || 'staff';
    if (!identity && !isAdmin(env, userId)) {
      const cmd = stage1Command(textIn);
      if (cmd && cmd.kind === 'bind' && ev.replyToken) {
        const out = await bindFlow({ lineUserId: userId, lineUserHash: userHash(userId),
          staffId: cmd.staffId, code: cmd.code, now: nowIso, store, db: live });
        if (out.bound) await applyRichMenu(env, store, userId, out.bound);
        return lineReply(token, ev.replyToken, out.text);
      }
      secLog('unbound-user', userHash(userId));
      if (ev.replyToken && (ev.type === 'message' || ev.type === 'follow' || ev.type === 'postback')) {
        return lineReply(token, ev.replyToken, BIND_HELP);
      }
      return;
    }
  } else if (!allowedUser(env, userId)) {
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

    /* Phase 2：預班草稿的按鈕（核准公告／暫緩＝該單位護理長以上） */
    if (p.cy) {
      if (!store || !identity) return lineReply(token, ev.replyToken, store ? BIND_HELP : STORE_DISABLED_TEXT);
      if (!commandAllowed(tier, 'publish')) return lineReply(token, ev.replyToken, tierDeniedText('publish', tier));
      const ctx = { cy: p.cy, actor: identity, now: nowIso, store, db: live };
      const out = p.act === 'publish' ? await publishFlow(ctx)
        : p.act === 'hold' ? await holdFlow(ctx)
          : { reply: { text: '不認得的動作。', items: null }, pushes: [] };
      await dispatchPushes(env, store, out.pushes);
      return lineReply(token, ev.replyToken, out.reply.text, out.reply.items);
    }

    /* Phase 1：替班請求的按鈕（核准／略過／駁回＝護理長；接／不接＝被問到的人） */
    if (p.rq) {
      if (!store || !identity) return lineReply(token, ev.replyToken, store ? BIND_HELP : STORE_DISABLED_TEXT);
      const ctx = { rq: p.rq, actor: identity, now: nowIso, store, db: live };
      let out;
      if (['approve', 'skip', 'reject', 'adjust', 'top', 'timeout'].includes(p.act)) {
        if (!commandAllowed(tier, 'manage')) {      // 核准／調整權＝護理長以上（矩陣 §2.5）
          return lineReply(token, ev.replyToken, tierDeniedText('manage', tier));
        }
        out = p.act === 'approve' ? await approveFlow(ctx)
          : p.act === 'skip' ? await skipFlow({ ...ctx, who: p.who })
            : p.act === 'reject' ? await rejectFlow(ctx)
              : p.act === 'adjust' ? await adjustFlow(ctx)
                : p.act === 'top' ? await topFlow({ ...ctx, who: p.who })
                  : await timeoutFlow({ ...ctx, minutes: Number(p.who) });
      } else if (p.act === 'accept' || p.act === 'decline') {
        out = await answerFlow({ ...ctx, answer: p.act });
      } else {
        return lineReply(token, ev.replyToken, '不認得的動作。');
      }
      await dispatchPushes(env, store, out.pushes);
      return lineReply(token, ev.replyToken, out.reply.text, out.reply.items);
    }

    if (!p.d) return lineReply(token, ev.replyToken, '這筆通報的日期不明，請重新傳一次請假訊息（例：我明天白班沒辦法上）。');
    if (p.id) {
      const out = await draftAndFormat(p, platformUrl, live);
      return lineReply(token, ev.replyToken, out.text, out.items);
    }
    const ask = askNext(p);
    if (ask) return lineReply(token, ev.replyToken, ask.text, ask.items);
    return completeGap(p);
  }

  /* 條件齊全：有身分＝建立替班請求（Phase 1 迴路）；無 D1＝Stage 0 只回建議 */
  async function completeGap(p) {
    if (store && identity) {
      const out = await reportFlow({ p, reporter: identity, reasonType: p.r || null, now: nowIso, store, db: live });
      await dispatchPushes(env, store, out.pushes);
      return lineReply(token, ev.replyToken, out.reply.text, out.reply.items);
    }
    const out = evaluateAndFormat(p, platformUrl, live);
    return lineReply(token, ev.replyToken, out.text, out.items);
  }

  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text' || !ev.replyToken) return;

  /* 文字訊息：Stage 1 指令 → 儀表板／選單 → 指令四兄弟 → 解析流程 */
  const text = textIn;
  const s1 = stage1Command(text);
  if (s1) {
    if (!store) return lineReply(token, ev.replyToken, STORE_DISABLED_TEXT);
    if (s1.kind === 'issue') {
      if (!isAdmin(env, userId)) {
        secLog('issue-denied', userHash(userId));
        return lineReply(token, ev.replyToken, '「發碼」限管理者使用。');
      }
      const out = await issueBindCodeFlow({ staffId: s1.staffId, tierWord: s1.tierWord, adminHash: userHash(userId),
        now: nowIso, store, db: live });
      return lineReply(token, ev.replyToken, out.text);
    }
    // 已綁定者再綁（換代號／換手機／升權責層）：同一流程，consumeBindCode 保證一碼一用
    const out = await bindFlow({ lineUserId: userId, lineUserHash: userHash(userId),
      staffId: s1.staffId, code: s1.code, now: nowIso, store, db: live });
    if (out.bound) await applyRichMenu(env, store, userId, out.bound);
    return lineReply(token, ev.replyToken, out.text);
  }
  /* 管理者專用：建立四份圖文選單（Worker 自己拿 token 做，本機零設定） */
  if (/^(建立選單|建選單|重建選單|建立圖文選單)$/.test(normalizeCmdText(text))) {
    if (!isAdmin(env, userId)) { secLog('richmenu-denied', userHash(userId)); return lineReply(token, ev.replyToken, '「建立選單」限管理者使用。'); }
    if (!store) return lineReply(token, ev.replyToken, STORE_DISABLED_TEXT);
    const running = await richMenuJobGet(store);
    if (running && Date.now() - Date.parse(running.started_at) < 10 * 60_000) return lineReply(token, ev.replyToken, `圖文選單正在建立中（第 ${running.next + 1}／${RICHMENU_STEPS.length} 步，${running.started_at.slice(11, 16)}Z 開始）。完成後會推播報告給你；卡住超過 10 分鐘再輸入一次。`);
    await richMenuJobStart(store, nowIso);
    return lineReply(token, ev.replyToken, `已開始建立圖文選單：每分鐘做一步，共 ${RICHMENU_STEPS.length} 步（四份選單 → 已綁定者重掛 → 清舊版），約 ${RICHMENU_STEPS.length} 分鐘後推播報告給你。`);
  }
  /* 權責閘（docs/LINEBOT-STAGE1.md §2.5）：指令歸類 → 查矩陣 → 不足時誠實回覆，不假裝指令不存在 */
  const cmdKey = classifyCommand(text);
  if (!commandAllowed(tier, cmdKey)) {
    secLog('tier-denied', `${userHash(userId)} ${tier} ${cmdKey}`);
    return lineReply(token, ev.replyToken, tierDeniedText(cmdKey, tier));
  }
  /* Phase 1.5：常駐指令（圖文選單格子）與文字版管理指令 */
  if (cmdKey === 'bindguide') return lineReply(token, ev.replyToken, identity ? `你已綁定為 ${identity.staff_id}。\n\n${BIND_HELP}` : BIND_HELP);
  if (cmdKey === 'whoami') return lineReply(token, ev.replyToken, whoamiText(identity, isAdmin(env, userId)));
  if (cmdKey === 'reportguide') { const g = reportGuideMessage(); return lineReply(token, ev.replyToken, g.text, g.items); }
  if (store && identity) {
    if (cmdKey === 'pending') { const o = await pendingFlow({ actor: identity, store }); return lineReply(token, ev.replyToken, o.reply.text, o.reply.items); }
    if (cmdKey === 'myask') { const o = await myAskFlow({ actor: identity, now: nowIso, store }); return lineReply(token, ev.replyToken, o.reply.text, o.reply.items); }
    if (cmdKey === 'manage') {
      const c = phase15Command(text);
      const o = c.kind === 'reorder'
        ? await reorderFlow({ rq: c.rq, order: c.order, actor: identity, now: nowIso, store })
        : await timeoutFlow({ rq: c.rq, minutes: c.minutes, actor: identity, now: nowIso, store });
      return lineReply(token, ev.replyToken, o.reply.text, o.reply.items);
    }
    /* Phase 2：預班迴路（開啟／預假／查詢／進度／催繳／截止）；每個 flow 自己驗單位與狀態 */
    const p2 = { text, actor: identity, now: nowIso, store, db: live };
    const p2flow = { opencycle: openCycleFlow, prebook: prebookFlow, myprebook: myPrebookFlow,
      cyclestatus: cycleStatusFlow, remindnow: remindNowFlow, closecycle: closeCycleFlow }[cmdKey];
    if (p2flow) {
      const o = await p2flow(p2);
      await dispatchPushes(env, store, o.pushes);
      return lineReply(token, ev.replyToken, o.reply.text, o.reply.items);
    }
  } else if (['pending', 'myask', 'manage', 'opencycle', 'prebook', 'myprebook', 'cyclestatus', 'remindnow', 'closecycle'].includes(cmdKey)) {
    return lineReply(token, ev.replyToken, store ? BIND_HELP : STORE_DISABLED_TEXT);
  }
  /* Phase 1.6 資料範圍：head／staff 鎖在自己的單位，exec／管理者／示範模式全院 */
  const scope = resolveScope(identity, tier);
  if (DASHBOARD_RE.test(text)) {
    const du = dashboardUnit(text, scope);
    return lineReplyMessages(token, ev.replyToken, [buildDashboardFlex(platformUrl, liffUrl, live, du.unit, du.note)]);
  }
  if (MENU_RE.test(text)) {
    return lineReplyMessages(token, ev.replyToken, [menuMessage(platformUrl, liffUrl, tier)]);
  }
  // 指令四兄弟：換班預檢／調度棋盤／負荷雷達／使用說明（皆為確定性回覆，未命中回 null）
  const extra = extraCommand(text, platformUrl, liffUrl, live, { tier, scope });
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
    // 通報者的單位由身分帶入（identity.unit），訊息有寫才覆蓋——少問一題
    u: (ex.unit && ex.unit.value) ? ex.unit.value : (identity ? identity.unit : null),
    c: ex.requiredCerts && Array.isArray(ex.requiredCerts.value) && ex.requiredCerts.value.length
      ? ex.requiredCerts.value.join(',') : null,
    r: ex.reason && ex.reason.value ? ex.reason.value : null,
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
  return completeGap(p);
}

/** Phase 1：把 flow 回傳的 pushes（staffId 或 admin）解析成 line_user_id 後推播。查無綁定者記 log、不擋流程。 */
async function dispatchPushes(env, store, pushes) {
  for (const m of pushes || []) {
    const msg = { type: 'text', text: String(m.text || '').slice(0, 4900) };
    if (m.items && m.items.length) msg.quickReply = quickReplyOf(m.items);
    let targets = [];
    if (m.admin) targets = adminIds(env);
    else if (m.staffId) {
      const id = await store.getIdentityByStaff(m.staffId);
      if (id) targets = [id.line_user_id];
      else console.log(`[PUSH] ${m.staffId} 未綁定，訊息未送出`);
    }
    for (const to of targets) {
      try { await linePush(env.LINE_CHANNEL_ACCESS_TOKEN, to, [msg]); }
      catch (err) { console.log('[PUSH] failed:', String(err)); }
    }
  }
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

    // Stage 1：一次請求載一次快照；D1 未綁定或表為空 → live 為 undefined，botcore 回落示範資料
    const store = makeStore(env);
    let live;
    if (store) {
      try {
        const snap = await store.loadDb();
        if (!snap.empty) live = snap;
      } catch (err) { console.log('[D1] loadDb failed, fallback to demo data:', String(err)); }
    }

    await Promise.all((body.events || []).map(
      (ev) => handleEvent(ev, env, { store, live }).catch((err) => console.log('event error:', err))));
    return new Response('ok', { status: 200 });
  },

  /** Cron（wrangler.toml [triggers]）：每分鐘一次。清過期綁定碼、替班逾時、預班催繳與截止；無 D1 直接返回。 */
  async scheduled(event, env) {
    const store = makeStore(env);
    if (!store) return;
    const nowIso = new Date().toISOString();
    try {
      const purged = await store.purgeExpiredBindCodes(nowIso);
      if (purged) console.log(`[CRON] purged ${purged} expired/used bind codes`);
      // Phase 1：替班詢問逾時 → 標 timeout、問下一位（或宣告無人可補）
      const out = await expireFlow({ now: nowIso, store });
      if (out.expired) console.log(`[CRON] ${out.expired} ask(s) timed out, ${out.pushes.length} push(es)`);
      await dispatchPushes(env, store, out.pushes);
      // Phase 2：預班催繳（截止前 3 天／1 天，只推未回覆者）與到期截止→生成草稿→通知護理長
      const pb = await prebookCron({ now: nowIso, store });
      if (pb.reminded || pb.closed) console.log(`[CRON] prebook: reminded ${pb.reminded}, closed ${pb.closed}, ${pb.pushes.length} push(es)`);
      await dispatchPushes(env, store, pb.pushes);
      // 圖文選單建立工作：一步一 tick（各有自己的請求預算），做完推播報告給管理者
      const rm = await richMenuJobTick(env, store, env.PLATFORM_URL || 'https://bobyu89.github.io/nursing-agent/', nowIso);
      if (rm.pushes.length) console.log('[CRON] richmenu job finished');
      await dispatchPushes(env, store, rm.pushes);
    } catch (err) { console.log('[CRON] error:', String(err)); }
  },
};
