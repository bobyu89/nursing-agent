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

/** 回覆訊息（可含快速回覆按鈕） */
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
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${channelToken}` },
    body: JSON.stringify({ replyToken, messages: [message] }),
  });
  if (!res.ok) console.log('LINE reply failed:', res.status, await res.text());
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

/* ── 事件處理 ── */

const welcomeText = (platformUrl) => [
  '【班守 ShiftGuard】值班通報機器人',
  '',
  '臨時請假／缺班，把訊息直接傳到這裡：',
  '範例：「護理長不好意思，我明天白班發燒沒辦法上」',
  '',
  '我會解析日期、班別與事由；缺的條件用按鈕點選，',
  '條件齊全後直接給你合規的替補建議排序。',
  '',
  '提醒：請以人員代號通報；訊息中請勿包含任何病人資訊。',
  `平台入口：${platformUrl}`,
].join('\n');

async function handleEvent(ev, env) {
  const platformUrl = env.PLATFORM_URL || 'https://bobyu89.github.io/nursing-agent/';
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;

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

  /* 文字訊息：確定性解析 → 顯示解析結果 → 續問缺漏條件 */
  const text = String(ev.message.text || '').slice(0, 2000);
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
      return new Response('signature validation failed', { status: 403 });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
    await Promise.all((body.events || []).map(
      (ev) => handleEvent(ev, env).catch((err) => console.log('event error:', err))));
    return new Response('ok', { status: 200 });
  },
};
