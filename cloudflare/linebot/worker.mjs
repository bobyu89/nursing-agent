/**
 * worker.mjs — 班守 ShiftGuard LINE 通報機器人（Cloudflare Workers 免費版）
 *
 * 零成本路線：不碰 AWS、不呼叫任何 LLM。
 * 解析器與決策引擎都是平台的同一份程式碼（src/llm.js、src/engine.js）——
 * wrangler 打包時直接引入原始檔，「同一份程式碼在瀏覽器、測試頁、
 * CI 與 LINE bot 上跑」。
 *
 * 互動流程（無狀態；條件以 postback data 夾帶，不需要任何資料庫）：
 *   1. 傳請假訊息 → 確定性解析（日期／班別／事由，缺漏不臆測）
 *   2. 缺哪個條件，就跳「快速回覆按鈕」讓主管點選（班別 → 單位 → 必要資格）
 *   3. 條件齊全 → 同一份 evaluateGap 引擎排序 → 回覆替補建議前三名
 *      （分數＋依據）＋排除摘要＋平台連結
 *
 * 治理邊界：機器人提供「建議」，不做指派決定——正式確認與決策留痕在平台。
 * 誠實聲明：示範資料（虛構人員）；解析為確定性關鍵詞規則。
 */
import crypto from 'node:crypto';
import data from '../../src/data.js';
import rules from '../../src/rules.js';
import engineMod from '../../src/engine.js';
import llm from '../../src/llm.js';

// 依 index.html 的載入語義把全域掛回（與 tests/run-node.js 同一招）
Object.assign(globalThis, data, rules, engineMod, llm);

const FIELD_TW = { date: '日期', shift: '班別', unit: '單位', requiredCerts: '必要資格', reason: '事由' };

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

/* ── 缺班條件的無狀態編碼（postback data ≤ 300 字，綽綽有餘）── */

function encodeParams(p) {
  const qs = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => { if (v !== null && v !== undefined) qs.set(k, v); });
  return qs.toString();
}

function decodeParams(str) {
  const qs = new URLSearchParams(str || '');
  return {
    d: qs.get('d'),                                  // 日期 YYYY-MM-DD
    s: qs.get('s'),                                  // 班別代碼 D/E/N
    u: qs.get('u'),                                  // 單位代碼
    c: qs.has('c') ? qs.get('c') : null,             // 資格代碼逗號串（'' = 明確選了「無需資格」）
    id: qs.get('id'),                                // 產生詢問草稿的對象（候選人代號）
  };
}

/* ── 逐步補條件：缺什麼就出哪一組按鈕 ── */

function askNext(p) {
  const base = { d: p.d, s: p.s, u: p.u, c: p.c };
  if (!p.s) {
    return {
      text: '缺的是哪一個班別？（點下方按鈕選擇）',
      items: Object.entries(SHIFT_TYPES).map(([code, t]) => ({
        label: t.name, dataStr: encodeParams({ ...base, s: code }),
      })),
    };
  }
  if (!p.u) {
    return {
      text: '這筆缺班在哪一個照護單位？',
      items: Object.entries(UNITS).map(([code, name]) => ({
        label: name, dataStr: encodeParams({ ...base, u: code }),
      })),
    };
  }
  if (p.c === null) {
    const combos = [
      { label: 'ACLS', c: 'ACLS' },
      { label: 'ACLS＋化療給藥', c: 'ACLS,CHEMO' },
      { label: 'ACLS＋靜脈注射', c: 'ACLS,IV' },
      { label: 'ACLS＋呼吸器', c: 'ACLS,VENT' },
      { label: '無需特殊資格', c: '' },
    ];
    return {
      text: '當班需要哪些必要資格？',
      items: combos.map(({ label, c }) => ({ label, dataStr: encodeParams({ ...base, c }) })),
    };
  }
  return null;   // 條件齊全
}

/* ── 條件齊全 → 同一份引擎評估，回覆替補建議 ── */

function buildGap(p) {
  return {
    date: p.d, shift: p.s, unit: p.u,
    requiredRole: '護理師',
    requiredCerts: p.c ? p.c.split(',').filter(Boolean) : [],
    originalStaffId: null,
  };
}

function runEngine(p) {
  const engine = createEngine({
    staff: STAFF, shifts: SHIFTS, shiftTypes: SHIFT_TYPES, roleLevels: ROLE_LEVELS,
    certs: CERTS, units: UNITS, registry: RULE_REGISTRY, staffingMin: UNIT_MIN_STAFF,
  });
  const gap = buildGap(p);
  return { gap, ...engine.evaluateGap(gap) };
}

function evaluateAndFormat(p, platformUrl) {
  const { gap, candidates, excluded } = runEngine(p);

  const head = `【替補建議】${shortDate(gap.date)}（${weekdayOf(gap.date)}）${SHIFT_TYPES[gap.shift].name}｜${UNITS[gap.unit]}\n` +
    `需求：護理師以上${gap.requiredCerts.length ? '＋' + gap.requiredCerts.map((c) => CERTS[c].replace(/\s.*/, '')).join('、') : ''}`;

  if (candidates.length === 0) {
    const codes = [...new Set(excluded.flatMap((e) => e.violations.map((v) => v.code)))].filter((c) => c !== '—');
    return {
      text: [
        head, '',
        `⚠ 查無合格替補（${excluded.length} 人全數排除，涉及規則：${codes.join('、')}）。`,
        '請至平台查看放寬試算與第 3 層任務重分配（決策階梯會引導）：',
        platformUrl,
        '',
        '＊示範資料（虛構人員）；正式決策以平台留痕為準',
      ].join('\n'),
      items: null,
    };
  }

  const medal = ['1️⃣', '2️⃣', '3️⃣'];
  const top3 = candidates.slice(0, 3);
  const top = top3.map((c, i) => {
    const why = [...c.score.breakdown].sort((a, b) => b.points - a.points).slice(0, 2)
      .map((b) => `${b.name} ${b.points} 分`).join('、');
    const warn = c.flags.length ? `\n　⚠ ${c.flags.map((f) => f.code).join('、')}${c.needsApproval ? '（需額外核准）' : ''}` : '';
    return `${medal[i]} ${c.staff.id}　${c.score.total}／${c.score.maxTotal} 分\n　${why}${warn}`;
  }).join('\n');

  const exCodes = [...new Set(excluded.flatMap((e) => e.violations.map((v) => v.code)))].filter((c) => c !== '—');
  return {
    text: [
      head, '', top, '',
      `另有 ${excluded.length} 人被排除（${exCodes.slice(0, 4).join('、')}），逐筆原因見平台。`,
      '點下方按鈕可產生「詢問訊息草稿」，複製後自行轉傳。',
      '正式指派請至平台完成主管確認（寫回班表＋決策留痕）：',
      platformUrl,
      '',
      '＊建議由確定性引擎計算；機器人不做指派決定',
      '＊示範資料（虛構人員）',
    ].join('\n'),
    items: top3.map((c) => ({
      label: `✉ 詢問 ${c.staff.id}`,
      dataStr: encodeParams({ d: p.d, s: p.s, u: p.u, c: p.c, id: c.staff.id }),
    })),
  };
}

/* ── 詢問訊息草稿：平台同一份 llmNotificationDraft，含工時試算與誠實聲明 ── */

async function draftAndFormat(p, platformUrl) {
  globalThis.LLM.mode = 'mock';
  const { gap, candidates } = runEngine(p);
  const others = candidates.slice(0, 3).filter((c) => c.staff.id !== p.id);
  const backItems = [
    ...others.map((c) => ({
      label: `✉ 詢問 ${c.staff.id}`,
      dataStr: encodeParams({ d: p.d, s: p.s, u: p.u, c: p.c, id: c.staff.id }),
    })),
    { label: '↩ 回建議清單', dataStr: encodeParams({ d: p.d, s: p.s, u: p.u, c: p.c }) },
  ];

  const chosen = candidates.find((c) => c.staff.id === p.id);
  if (!chosen) {
    return { text: `${p.id} 已不在合格候選內（條件可能已變動），請回建議清單重新確認。`, items: backItems };
  }

  const draft = await globalThis.llmNotificationDraft(gap, chosen);
  return {
    text: [
      `【詢問訊息草稿｜${p.id}】`,
      '複製下方訊息、自行轉傳給該同仁——系統不代發，發送與否由你決定：',
      '',
      '──────────',
      draft,
      '──────────',
      '',
      '＊工時試算由引擎確定性計算；對方同意後，正式指派請至平台完成主管確認與留痕',
    ].join('\n'),
    items: backItems,
  };
}

/* ── 戰情儀表板（Flex Message）──────────────────────────
 * 與平台管理總覽同一份引擎即時計算：缺口方程式、帶班平衡、單點依賴、
 * 證照效期、結構性訊號＋前三項行動。輸入「儀表板」即生成。
 */
const C = { red: '#B0413E', amber: '#A8842C', green: '#5E7F58', ink: '#3D3A34', faint: '#8A877E', line: '#E4E1D9' };

function buildDashboardFlex(platformUrl) {
  const eng = createEngine({
    staff: STAFF, shifts: SHIFTS, shiftTypes: SHIFT_TYPES, roleLevels: ROLE_LEVELS,
    ladderLevels: LADDER_LEVELS, certs: CERTS, units: UNITS,
    registry: RULE_REGISTRY, staffingMin: UNIT_MIN_STAFF,
  });
  const UNIT = 'MED-3A';
  const gap = eng.workforceGapAnalysis({ dates: WEEK_DATES, demand: UNIT_MIN_STAFF });
  const cap = eng.capabilityAnalysis({ dates: WEEK_DATES, unit: UNIT });

  const cells = gap.cells.filter((c) => c.unit === UNIT);
  const gapCells = cells.filter((c) => c.gap > 0);
  const need = cells.reduce((n, c) => n + c.need, 0);
  const sched = cells.reduce((n, c) => n + Math.min(c.scheduled, c.need), 0);
  const fills = gap.absorb.fills.filter((f) => f.unit === UNIT);
  const flagged = fills.filter((f) => f.flags.length > 0);
  const residual = gap.absorb.residual.filter((u) => u.unit === UNIT).length;
  const structural = gap.structural.filter((s) => s.unit === UNIT);

  const balance = ['D', 'E', 'N'].map((code) => {
    const staffed = cap.shiftMix.filter((x) => x.shift === code && !x.empty);
    return { code, staffed: staffed.length, ok: staffed.filter((x) => x.hasSenior).length };
  }).filter((b) => b.staffed > 0);
  const worst = balance.reduce((w, b) => (b.ok / b.staffed < w.ok / w.staffed ? b : w), balance[0]);
  const sp = cap.certSinglePoints.filter((c) => c.count <= 1);
  const expired = cap.expiring.filter((x) => x.status === 'expired').length;
  const expSoon = cap.expiring.filter((x) => x.status === 'expiring').length;

  const kpiRow = (label, value, color) => ({
    type: 'box', layout: 'horizontal', margin: 'md',
    contents: [
      { type: 'text', text: label, size: 'sm', color: C.ink, flex: 5 },
      { type: 'text', text: value, size: 'sm', weight: 'bold', color, align: 'end', flex: 3 },
    ],
  });
  const actions = [];
  balance.filter((b) => b.ok < b.staffed).forEach((b) =>
    actions.push(`${SHIFT_TYPES[b.code].name}資深覆蓋 ${b.ok}/${b.staffed} 天 → 輪入 N3↑`));
  sp.forEach((c) => actions.push(`${CERTS[c.code].replace(/\s.*/, '')}${c.count === 0 ? '無人持有' : `僅 ${c.holders[0]}`} → 培訓第二人`));
  if (expired) actions.push(`${expired} 張證照已過期 → 安排回訓`);
  if (flagged.length) actions.push(`吸收方案 ${flagged.length} 筆有公平代價 → 留意集中`);

  return {
    type: 'flex',
    altText: `班守戰情：缺口 ${gapCells.length} 班次、殘餘 ${residual}、行動 ${actions.length} 項`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg',
        contents: [
          { type: 'text', text: '班守 ShiftGuard｜今日戰情', weight: 'bold', size: 'md', color: C.ink },
          { type: 'text', text: `${UNITS[UNIT]}・本週（示範資料）`, size: 'xs', color: C.faint, margin: 'sm' },
          { type: 'separator', margin: 'lg', color: C.line },
          { type: 'text', margin: 'lg', size: 'sm', color: C.ink, wrap: true,
            text: `缺口方程式：需 ${need} − 排 ${sched} ＝ 缺 ${gapCells.length} → 可吸收 ${fills.length} ＝ 殘餘 ${residual}` },
          kpiRow('殘餘缺口', `${residual} 班次`, residual ? C.red : C.green),
          kpiRow(`帶班平衡（最弱：${SHIFT_TYPES[worst.code].name}）`, `${worst.ok}/${worst.staffed} 天`, worst.ok < worst.staffed ? C.red : C.green),
          kpiRow('資格單點依賴', `${sp.length} 項`, sp.length ? C.red : C.green),
          kpiRow('證照 過期＋將到期', `${expired}＋${expSoon}`, (expired + expSoon) ? C.amber : C.green),
          kpiRow('結構性缺口', structural.length ? structural.map((s) => SHIFT_TYPES[s.shift].name).join('、') : '無', structural.length ? C.red : C.green),
          { type: 'separator', margin: 'lg', color: C.line },
          { type: 'text', text: '需要行動', weight: 'bold', size: 'sm', color: C.ink, margin: 'lg' },
          ...(actions.length ? actions.slice(0, 3).map((t) => ({
            type: 'text', text: `・${t}`, size: 'xs', color: C.ink, wrap: true, margin: 'sm',
          })) : [{ type: 'text', text: '目前無需行動事項', size: 'xs', color: C.faint, margin: 'sm' }]),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: 'md',
        contents: [{
          type: 'button', style: 'primary', height: 'sm', color: C.ink,
          action: { type: 'uri', label: '開啟完整儀表板', uri: platformUrl },
        }],
      },
    },
  };
}

const DASHBOARD_RE = /^(儀表板|戰情|狀態|缺口|dashboard)$/i;
const MENU_RE = /^(選單|功能|幫助|menu|help)$/i;

/** 功能選單：快速按鈕（圖文選單 Rich Menu 的輕量版，隨時可叫出） */
function menuMessage(platformUrl) {
  return {
    type: 'text',
    text: '請選擇功能（也可以直接把請假訊息傳給我）：',
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '📊 戰情儀表板', text: '儀表板' } },
      { type: 'action', action: { type: 'message', label: '📝 通報範例', text: '護理長不好意思，我明天白班發燒沒辦法上，很抱歉' } },
      { type: 'action', action: { type: 'uri', label: '🌐 開啟平台', uri: platformUrl } },
      { type: 'action', action: { type: 'uri', label: 'ℹ️ 功能介紹', uri: platformUrl.replace(/\/?$/, '/') + 'home.html' } },
    ] },
  };
}

/* ── 事件處理 ── */

const welcomeText = (platformUrl) => [
  '【班守 ShiftGuard】值班通報機器人',
  '',
  '兩種用法：',
  '① 通報缺班：直接傳請假訊息，例如',
  '　「護理長不好意思，我明天白班發燒沒辦法上」',
  '　我會解析並用按鈕補條件，給你合規替補建議。',
  '② 看戰情：輸入「儀表板」，立刻回覆本週缺口、',
  '　帶班平衡、單點依賴與需要行動的事項。',
  '',
  '隨時輸入「選單」叫出功能快速按鈕。',
  '提醒：請以人員代號通報；訊息中請勿包含任何病人資訊。',
  `平台入口：${platformUrl}`,
].join('\n');

async function handleEvent(ev, env) {
  const platformUrl = env.PLATFORM_URL || 'https://bobyu89.github.io/nursing-agent/';
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
    return lineReplyMessages(token, ev.replyToken, [buildDashboardFlex(platformUrl)]);
  }
  if (MENU_RE.test(text.trim())) {
    return lineReplyMessages(token, ev.replyToken, [menuMessage(platformUrl)]);
  }
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
