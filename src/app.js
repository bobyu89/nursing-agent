/**
 * app.js — 畫面渲染與流程控制
 *
 * 八個畫面：缺班事件 → 替補候選人 → 主管確認 → 公平性與留痕 → 班表與人員 → 規則庫 → 多筆缺班 → 班表生成
 * 所有決策數字來自 engine.js，所有敘述文字來自 llm.js，本檔只負責呈現。
 */

const state = {
  parsed: null,        // llmParseGapMessage 的結果
  gap: null,           // 補全後的缺班事件
  result: null,        // evaluateGap 的結果
  chosen: null,        // 主管選定的候選人
  confirmed: false,    // 是否已完成主管確認
  audit: [],           // 決策留痕
  multiQueue: [],      // 畫面 7 帶入的缺班佇列（{gap, suggestedId}）
  suggestedId: null,   // 當前評估中，全局指派建議的人選（畫面標示用）
  rosterWeekStart: WEEK.start,   // 畫面 5 目前顯示的週（週一）
  qpWeekStart: WEEK.start,       // 畫面 1 快速通報目前顯示的週（週一）
  qpDay: GAP_EVENT.date,         // 快速通報目前選定的日期
  quickSel: new Map(),           // 快速通報已點選的缺班（key sid|date|shift → {staffId,date,shift,unit,certs,role}）
  swap: { a: null, b: null },    // 換班簽核：甲乙兩側點選的班次（{staffId,date,shift}）
  todayDate: GAP_EVENT.raisedAt.slice(0, 10),   // 今日戰情的基準日（示範今日 2026-08-08）
};

/** 開場時的替補次數基準值，用來標示本次連線期間的變化 */
const BASELINE_STANDBY = {};

/**
 * 決策引擎實例：把資料層明確注入引擎。
 * staff／shifts／registry 傳的是同一份參照，
 * 規則庫設定頁的調整與主管確認後的寫回都會即時反映。
 */
const engine = createEngine({
  staff: STAFF,
  shifts: SHIFTS,
  shiftTypes: SHIFT_TYPES,
  roleLevels: ROLE_LEVELS,
  ladderLevels: LADDER_LEVELS,
  certs: CERTS,
  units: UNITS,
  registry: RULE_REGISTRY,
  staffingMin: UNIT_MIN_STAFF,
  flexCycleAnchor: FLEX_CYCLE_ANCHOR,
});

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ══ 動畫層（anime.js v4，assets/anime.umd.min.js）══════════
 * 動畫是妝點不是依賴：檔案沒載到（極端離線環境）或使用者設定
 * prefers-reduced-motion 時，整層靜默成 no-op，功能與版面完全不受影響。
 * 所有進場動畫由 JS 設定起點（opacity 0），不在 CSS 預先隱藏——
 * 動畫層失效時元素照常可見。 */
const MOTION = (() => {
  const lib = (typeof anime !== 'undefined' && anime && typeof anime.animate === 'function') ? anime : null;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const on = !!lib && !reduced;

  /** 區塊進場：淡入上移、交錯出現。root 可傳選擇器或元素，childSel 縮小動畫對象 */
  function enter(root, childSel) {
    if (!on) return;
    const el = typeof root === 'string' ? $(root) : root;
    if (!el) return;
    const targets = childSel ? Array.from(el.querySelectorAll(childSel)) : Array.from(el.children);
    if (!targets.length) return;
    lib.utils.remove(targets);   // 快速連續切換時砍掉舊動畫，避免疊加
    lib.animate(targets, {
      opacity: [0, 1], translateY: [12, 0],
      duration: 400, delay: lib.stagger(45, { start: 30 }), ease: 'out(2.5)',
    });
  }

  /** 小元件回饋：縮放彈出（chip 點選、格子編輯） */
  function pop(el) {
    if (!on || !el) return;
    lib.utils.remove(el);
    lib.animate(el, { scale: [0.82, 1], duration: 260, ease: 'out(3)' });
  }

  /** 數字滾動：只動元素的第一個文字節點（「74.5 <small>/ 100</small>」只滾 74.5）。
   *  結束時寫回原始字串，確保畫面數字與引擎輸出一字不差。 */
  function count(els, { duration = 700 } = {}) {
    if (!on) return;
    els.forEach((el) => {
      const node = el.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return;
      const orig = node.textContent;
      const target = parseFloat(orig);
      if (!isFinite(target) || target === 0) return;
      const decimals = /\.\d/.test(orig.trim()) ? 1 : 0;
      const o = { v: 0 };
      lib.animate(o, {
        v: target, duration, ease: 'out(3)',
        onUpdate: () => { node.textContent = o.v.toFixed(decimals); },
        onComplete: () => { node.textContent = orig; },
      });
    });
  }

  /** 評分長條由 0 長到定位（讀 inline width 為終點，結束值即引擎算出的比例） */
  function bars(root) {
    if (!on) return;
    const el = typeof root === 'string' ? $(root) : root;
    if (!el) return;
    el.querySelectorAll('.bar > i').forEach((bar) => {
      const w = bar.style.width;
      if (!w) return;
      lib.animate(bar, { width: ['0%', w], duration: 650, ease: 'out(2.5)' });
    });
  }

  return { on, enter, pop, count, bars };
})();

/* ══ 圖示庫：手寫 inline SVG（24×24 線條風）════════════════
 * 不用 icon font 也不外連 CDN——CSP 同源、離線雙擊、主題色
 * （stroke: currentColor）三個條件一次滿足。裝飾性圖示一律
 * aria-hidden，可見文字仍是唯一的語意來源。 */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  swap: '<path d="M17 2l4 4-4 4"/><path d="M3 12V10a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 12v2a4 4 0 0 1-4 4H3"/>',
  chart: '<path d="M6 20v-8M12 20V5M18 20v-5"/><path d="M3 20h18"/>',
  shield: '<path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"/><path d="M9 11.5l2 2 4-4"/>',
  sparkles: '<path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/>',
  layers: '<path d="M12 2l10 6-10 6L2 8z"/><path d="M2 13l10 6 10-6"/>',
  zap: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v5h-5"/>',
  download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  award: '<circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/>',
  scale: '<path d="M12 3v18M8 21h8M5 7h14"/><path d="M7 7l-3 6a3 3 0 0 0 6 0z"/><path d="M17 7l-3 6a3 3 0 0 0 6 0z"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  alert: '<path d="M12 3L2 21h20z"/><path d="M12 10v5"/><path d="M12 18.5v.5"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  'user-check': '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 11l2 2 4-4"/>',
};

function icon(name) {
  const paths = ICONS[name];
  if (!paths) return '';
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"` +
    ` fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

/* ══ Toast 通知：操作完成的輕量回饋 ═══════════════════════
 * 進出場走 CSS animation／transition，prefers-reduced-motion 由
 * 全域樣式歸零；aria-live=polite 讓螢幕報讀器也收得到回饋。
 * 只在「使用者主動操作完成」時使用，系統自動重算不彈——
 * 通知太多等於沒有通知。 */
function toast(message, level = 'ok') {
  const stack = $('#toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast toast-${level}`;
  el.innerHTML = `${icon(level === 'ok' ? 'check' : level === 'warn' ? 'alert' : 'x')}<span></span>`;
  el.querySelector('span').textContent = message;   // textContent：訊息不進 HTML 解析器
  stack.appendChild(el);
  while (stack.children.length > 4) stack.firstChild.remove();
  const leave = () => {
    if (!el.parentElement) return;
    el.classList.add('out');
    let gone = false;
    const done = () => { if (!gone) { gone = true; el.remove(); } };
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 500);   // transitionend 沒觸發時的保險
  };
  setTimeout(leave, 3000);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 以 file:// 直接開啟時 Clipboard API 可能不可用，備妥 execCommand 退路 */
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 落入退路 */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

/**
 * 留痕採雜湊鏈結（tamper-evident）：每筆紀錄的雜湊包含前一筆的雜湊，
 * 事後修改任何一筆都會讓後續整條鏈驗證失敗。
 * 這是前端 demo 能誠實做到的防竄改；正式導入時改由後端 append-only 儲存。
 */
function chainHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function logAction(action, detail, actor = '內科病房 3A 護理長') {
  const time = nowStamp();
  const prev = state.audit.length ? state.audit[0].hash : 'genesis';
  const hash = chainHash(prev + time + action + detail + actor);
  state.audit.unshift({ time, action, detail, actor, prev, hash });
  renderAuditLog();
}

/** 由最早一筆往回重算整條鏈，任何一筆被改過都會驗出斷鏈 */
function verifyAuditChain() {
  const chrono = [...state.audit].reverse();
  return chrono.every((e, i) => {
    const prev = i === 0 ? 'genesis' : chrono[i - 1].hash;
    return e.prev === prev && e.hash === chainHash(prev + e.time + e.action + e.detail + e.actor);
  });
}

/* ══ 規則庫持久化（localStorage）═══════════════════════════
 * 只保存主管可調整的欄位（權重、門檻、啟用狀態），不保存規則文字，
 * 因此程式更新規則描述時不會被舊快照蓋掉。
 * 班表寫回與 audit log 刻意不持久化：重新整理即可重置演示。
 */
const RULES_STORE_KEY = 'shiftguard.rules.v1';

/**
 * localStorage 是可被任意改寫的儲存（devtools、同源其他程式都動得到），
 * 載回的數值必須夾限在合理範圍——H4 班間休息被塞成 0 或負數，
 * 等於無聲關掉法定下限檢查，這在本平台是合規事故等級的錯誤。
 */
const PARAM_RANGE = {
  H4: [0, 24],    // 班間休息時數
  H5: [1, 14],    // 連續上班天數上限
  H6: [8, 168],   // 週工時絕對上限
  H7: [0, 14],    // 二週週期最少例假日數
  H8: [40, 320],  // 四週正常工時總量上限
  H9: [0, 28],    // 四週週期最少例假＋休息日數
  S1: [1, 99],    // 公平性飽和次數
  S2: [8, 168],   // 週工時軟性上限
};
const WEIGHT_RANGE = [0, 50];  // 與規則庫頁滑桿的 min/max 一致

function clampTo(value, [lo, hi]) {
  return Math.min(hi, Math.max(lo, value));
}

function saveRules() {
  try {
    localStorage.setItem(RULES_STORE_KEY, JSON.stringify({
      hard: RULE_REGISTRY.hard.map((r) => ({ code: r.code, enabled: r.enabled, param: r.param ? r.param.value : null })),
      soft: RULE_REGISTRY.soft.map((r) => ({ code: r.code, weight: r.weight, param: r.param ? r.param.value : null })),
    }));
  } catch (e) { /* 無痕模式等情況拿不到 localStorage，略過即可 */ }
}

function loadRules() {
  try {
    const raw = localStorage.getItem(RULES_STORE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    let adjusted = 0;   // 竄改可視化：夾限發生＝儲存值不合法，計數後上報留痕
    const clampCount = (v, range) => {
      const c = clampTo(v, range);
      if (c !== v) adjusted += 1;
      return c;
    };
    (saved.hard || []).forEach((s) => {
      const r = getHardRule(s.code);
      if (!r) return;
      if (typeof s.enabled === 'boolean') r.enabled = s.enabled;
      if (r.param && Number.isFinite(s.param)) {
        r.param.value = clampCount(s.param, PARAM_RANGE[r.code] || [0, 999]);
      }
    });
    (saved.soft || []).forEach((s) => {
      const r = RULE_REGISTRY.soft.find((x) => x.code === s.code);
      if (!r) return;
      if (Number.isFinite(s.weight)) r.weight = clampCount(s.weight, WEIGHT_RANGE);
      if (r.param && Number.isFinite(s.param)) {
        r.param.value = clampCount(s.param, PARAM_RANGE[r.code] || [0, 999]);
      }
    });
    return { adjusted };
  } catch (e) { return null; }
}

function resetRules() {
  try { localStorage.removeItem(RULES_STORE_KEY); } catch (e) {}
  location.reload();
}

/* ══ 班表持久化（localStorage）══════════════════════════
 * 排班工作區的變更（格子編輯／貼上匯入／套用生成草稿）保存在本機；
 * 「主管確認寫回」維持既有語義：屬演示行為，不主動保存、重整即重置。
 * 載回時逐筆白名單驗證（代號∈STAFF、日期真實存在、班別∈SHIFT_TYPES、
 * 單位∈UNITS）——localStorage 是可被任意改寫的儲存，不驗證等於開後門。
 */
const SCHEDULE_STORE_KEY = 'shiftguard.schedule.v1';

function saveSchedule() {
  try { localStorage.setItem(SCHEDULE_STORE_KEY, JSON.stringify(SHIFTS)); } catch (e) {}
  const badge = $('#roster-modified');
  if (badge) badge.hidden = false;
}

function loadSchedule() {
  try {
    const raw = localStorage.getItem(SCHEDULE_STORE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const valid = arr.filter((x) => x
      && STAFF.some((s) => s.id === x.staffId)
      && isValidDateStr(x.date)
      && SHIFT_TYPES[x.shift]
      && UNITS[x.unit]);
    SHIFTS.length = 0;
    valid.forEach((x) => SHIFTS.push({
      staffId: x.staffId, date: x.date, shift: x.shift, unit: x.unit,
      ...(x.isReplacement ? { isReplacement: true } : {}),
      ...(x.isSwap ? { isSwap: true } : {}),
    }));
    // 竄改可視化：被剔除的筆數＝儲存中出現不合法資料，上報留痕
    return { dropped: arr.length - valid.length };
  } catch (e) { return null; }
}

function resetSchedule() {
  try { localStorage.removeItem(SCHEDULE_STORE_KEY); } catch (e) {}
  location.reload();
}

/** 班表變更後的統一重算：排班工作區、缺口總覽、能力儀表板、主動預警、入口狀態、FHIR 統計 */
function refreshAfterScheduleChange() {
  renderRoster();
  renderQuickPick();   // 快速通報的在班名單直接取自班表，班表變了要跟著變
  renderSwapPicker();  // 換班簽核的班次清單同理
  renderToday();       // 今日戰情的在班與缺口同理
  renderOverview();
  renderCapability();
  renderWarnings();
  renderPortalStatus();
  renderFhirStats();
}

/* ══ 兩層導覽與分頁切換 ═════════════════════════════════
 * 首層依「系統」分流：入口 → 排班系統／替班系統 → 總覽／治理。
 * 畫面 id 與編號不變（台本與文件以編號指涉）。 */

const NAV_GROUPS = [
  { key: 'home', label: '入口', screens: [
    ['portal', '系統入口', '⌂'],
  ] },
  { key: 'sched', label: '排班系統', screens: [
    ['roster', '班表工作區', '5'], ['swap', '換班簽核', '換'], ['generate', '班表生成', '8'],
  ] },
  { key: 'gap', label: '替班系統', screens: [
    ['intake', '通報解析', '1'], ['candidates', '替補候選', '2'],
    ['confirm', '主管確認', '3'], ['multi', '多筆與韌性', '7'],
  ] },
  { key: 'ov', label: '總覽', screens: [
    ['today', '今日戰情', '今'], ['overview', '人力缺口', '◎'], ['capability', '能力與出勤', '★'],
  ] },
  { key: 'gov', label: '治理', screens: [
    ['dashboard', '公平與留痕', '4'], ['rules', '規則庫', '6'], ['fhir', 'FHIR 介接', '9'],
  ] },
];

function navGroupOf(name) {
  return NAV_GROUPS.find((g) => g.screens.some(([id]) => id === name)) || NAV_GROUPS[0];
}

const NAV_ICONS = { home: 'home', sched: 'calendar', gap: 'swap', ov: 'chart', gov: 'shield' };

function renderNav(active) {
  const g = navGroupOf(active);
  $('#nav').innerHTML = `
    <div class="nav-primary">${NAV_GROUPS.map((x) =>
    `<button class="np${x.key === g.key ? ' active' : ''}" data-group="${x.key}">${icon(NAV_ICONS[x.key])}${x.label}</button>`).join('')}</div>
    <div class="nav-secondary">${g.screens.map(([id, label, no]) =>
    `<button class="tab${id === active ? ' active' : ''}" data-screen="${id}"><span class="tab-no">${no}</span>${label}</button>`).join('')}</div>`;
}

function switchScreen(name) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  renderNav(name);
  // 讓每個畫面可直接以 #hash 連結（home.html 的「排班／替班」按鈕即靠這個進場）
  try { history.replaceState(null, '', `#${name}`); } catch (e) { /* file:// 受限時略過 */ }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // 進場動畫：畫面頂層區塊交錯進場，KPI 數字滾動到定位（皆為妝點，數值不變）
  const active = $(`#screen-${name}`);
  if (active) {
    MOTION.enter(active);
    MOTION.count(Array.from(active.querySelectorAll('.ov-num, .kpi-num')));
  }
}

/** 進場畫面：#hash 指名畫面（#roster）或分組（#sched → 該組第一個畫面），否則入口 */
function screenFromHash() {
  const h = decodeURIComponent((location.hash || '').replace(/^#/, ''));
  if (h && document.getElementById(`screen-${h}`)) return h;
  const g = NAV_GROUPS.find((x) => x.key === h);
  return g ? g.screens[0][0] : 'portal';
}

/* ══ ⌂ 系統入口（Portal）═══════════════════════════════ */

/** 入口卡上的即時狀態：排班側看違規預警與缺口，替班側看缺口可否合法吸收。
 *  口徑與「人力缺口總覽」一致：只算名單完整的示範單位（內科 3A），
 *  避免部分名單單位的殘缺資料撐出嚇人的假數字。 */
function renderPortalStatus() {
  const schedEl = $('#portal-sched-status');
  const gapEl = $('#portal-gap-status');
  if (!schedEl || !gapEl) return;
  const UNIT = 'MED-3A';
  const high = engine.rosterWarnings().filter((w) => w.level === 'high').length;
  const r = engine.workforceGapAnalysis({ dates: WEEK_DATES, demand: UNIT_MIN_STAFF });
  const gapCells = r.cells.filter((c) => c.unit === UNIT && c.gap > 0).length;
  const residual = r.absorb.residual.filter((u) => u.unit === UNIT).length;
  schedEl.innerHTML = high
    ? `目前班表有 <b>${high}</b> 條「已違規」預警（工時／班距／四週彈性工時），請優先處理`
    : `目前班表無「已違規」預警；${UNITS[UNIT]}本週尚有 <b>${gapCells}</b> 個缺口班次可從源頭排補`;
  gapEl.innerHTML = residual
    ? `${UNITS[UNIT]}本週 ${gapCells} 個缺口中 <b>${residual}</b> 個無人可合法替補，需走升級路徑`
    : `${UNITS[UNIT]}本週 ${gapCells} 個缺口皆有合法替補人選可指派`;
}

function initPortal() {
  $('#portal-sched').addEventListener('click', () => switchScreen('roster'));
  $('#portal-gap').addEventListener('click', () => switchScreen('intake'));
  $$('.portal-mini').forEach((b) => b.addEventListener('click', () => switchScreen(b.dataset.goto)));
}

/* ══ 儀表板圖表：手寫 SVG（零依賴，深色主題原生）═══════ */

/**
 * 水平長條圖。rows: [{ label, segs: [{v, color, title}], right }]
 * max 為共同尺度；marker 可在指定值畫垂直虛線（如飽和門檻）。
 * 顏色用 CSS 變數字串，inline SVG 直接繼承主題。
 */
function chartHBar(rows, { max, width = 640, marker } = {}) {
  const LABEL_W = 96; const RIGHT_W = 96; const BAR_H = 16; const ROW_H = 30;
  const barW = width - LABEL_W - RIGHT_W;
  const H = rows.length * ROW_H + 10;
  const x0 = LABEL_W;
  const scale = max > 0 ? barW / max : 0;

  const body = rows.map((r, i) => {
    let x = 0;
    const segs = (r.segs || []).map((s) => {
      const w = Math.max(0, s.v * scale);
      const rect = `<rect x="${(x0 + x).toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${BAR_H}" rx="3" fill="${s.color}"><title>${esc(s.title || r.label)}：${s.v}</title></rect>`;
      x += w;
      return rect;
    }).join('');
    return `<g transform="translate(0 ${i * ROW_H + 6})">
      <text x="0" y="12" font-size="12" fill="var(--ink-soft)">${esc(r.label)}</text>
      <rect x="${x0}" y="0" width="${barW}" height="${BAR_H}" rx="3" fill="var(--line-soft)"/>
      ${segs}
      <text x="${x0 + barW + 8}" y="12" font-size="12" fill="var(--ink-faint)">${esc(r.right || '')}</text>
    </g>`;
  }).join('');

  const mk = marker ? `
    <line x1="${(x0 + marker.v * scale).toFixed(1)}" y1="4" x2="${(x0 + marker.v * scale).toFixed(1)}" y2="${H - 6}"
      stroke="var(--warn)" stroke-dasharray="4 3" stroke-width="1.5"></line>` : '';

  return `<svg class="chart" viewBox="0 0 ${width} ${H}" role="img">${body}${mk}</svg>`;
}

const stampTag = () => `<span class="tag tag-brand">即時計算 ${nowStamp().slice(11)}</span>`;

/* ══ ★ 能力與出勤儀表板 ════════════════════════════════ */

function lvBadge(code) {
  return code
    ? `<span class="lv-badge lv-${esc(code)}">${esc(code)}</span>`
    : '<span class="lv-badge lv-none">未評級</span>';
}

function renderCapability() {
  const UNIT = 'MED-3A';
  const r = engine.capabilityAnalysis({ dates: WEEK_DATES, unit: UNIT });
  const CERT_SHORT = Object.fromEntries(Object.entries(CERTS).map(([k, v]) => [k, v.replace(/\s.*/, '')]));

  /* A. 帶班平衡熱圖：班別 × 日期，無 N3↑ 的班標紅 */
  const mixHead = `<thead><tr><th>班別</th>${WEEK_DATES.map((d) =>
    `<th class="center">${shortDate(d)}<br>（${weekdayOf(d)}）</th>`).join('')}<th class="center">資深覆蓋</th></tr></thead>`;
  const mixBody = ['D', 'E', 'N'].map((code) => {
    const cells = WEEK_DATES.map((d) => {
      const m = r.shiftMix.find((x) => x.date === d && x.shift === code);
      if (!m || m.empty) return '<td class="center" style="color:var(--ink-faint)">·</td>';
      const chips = m.onDuty.map((s) => s.ladder || '—').join('·');
      return `<td class="center mix-cell${m.hasSenior ? '' : ' mix-warn'}" title="${m.onDuty.map((s) => `${s.id} ${s.ladder || '未評級'}`).join('、')}">${esc(chips)}${m.hasSenior ? '' : '<br><b class="expired">無 N3↑</b>'}</td>`;
    }).join('');
    const staffed = r.shiftMix.filter((x) => x.shift === code && !x.empty);
    const ok = staffed.filter((x) => x.hasSenior).length;
    const tag = staffed.length === 0 ? '—'
      : (ok === staffed.length ? `<span class="tag tag-ok">${ok}/${staffed.length} 天</span>`
        : `<span class="tag tag-danger">${ok}/${staffed.length} 天</span>`);
    return `<tr><td><b>${SHIFT_TYPES[code].name}</b></td>${cells}<td class="center">${tag}</td></tr>`;
  }).join('');

  /* B. 徽章牆 */
  const wall = r.badges.map((b) => `
    <tr>
      <td><b>${esc(b.id)}</b></td>
      <td>${lvBadge(b.ladder)}</td>
      <td style="white-space:normal">${b.certs.map((c) => {
        const label = { valid: '', expiring: `（${c.expiry} 到期）`, expired: '（已過期）' }[c.status];
        return `<span class="cert-badge cert-${c.status}" title="${CERTS[c.code]}｜效期 ${c.expiry}">${esc(CERT_SHORT[c.code])}${label}</span>`;
      }).join('')}</td>
    </tr>`).join('');

  /* C. 單點依賴 + 到期雷達 */
  const spRows = r.certSinglePoints.map((c) => `
    <div class="fact">
      <span>${esc(CERTS[c.code])}</span>
      <span>${c.count === 0 ? '<b class="expired">0 人——能力已消失</b>'
        : c.count === 1 ? `<b class="expired">僅 ${esc(c.holders[0])} 一人——單點故障</b>`
        : `${c.count} 人（${c.holders.map(esc).join('、')}）`}</span>
    </div>`).join('');
  const radarRows = r.expiring.length ? r.expiring.map((x) => `
    <div class="fact">
      <span>${esc(x.id)}｜${esc(CERT_SHORT[x.code])}</span>
      <span class="${x.status === 'expired' ? 'expired' : ''}">${x.status === 'expired' ? `已於 ${x.expiry} 過期——回訓後才可計入戰力` : `${x.expiry} 到期，請排回訓`}</span>
    </div>`).join('') : '<div class="sc-evi">未來 90 天內無證照到期。</div>';

  /* D. 出勤與公平快照 */
  const leaveDays = STAFF.filter((s) => s.unit === UNIT).flatMap((s) =>
    WEEK_DATES.filter((d) => s.leaves.some((lv) => d >= lv.from && d <= lv.to)).map(() => s.id));
  const leaveWho = [...new Set(leaveDays)];
  const counts = STAFF.filter((s) => s.unit === UNIT).map((s) => s.standbyCount30d);
  const nightCerts = r.certCoverage.find((c) => c.shift === 'N');

  /* 結論磚與行動清單：先講結論，依據收抽屜 */
  const shiftBalance = ['D', 'E', 'N'].map((code) => {
    const staffed = r.shiftMix.filter((x) => x.shift === code && !x.empty);
    return { code, staffed: staffed.length, ok: staffed.filter((x) => x.hasSenior).length };
  }).filter((b) => b.staffed > 0);
  const worstBalance = shiftBalance.reduce((w, b) => (b.ok / b.staffed < w.ok / w.staffed ? b : w), shiftBalance[0]);
  const balanceBad = shiftBalance.some((b) => b.ok < b.staffed);
  const spCritical = r.certSinglePoints.filter((c) => c.count <= 1);
  const expired = r.expiring.filter((x) => x.status === 'expired');
  const expSoon = r.expiring.filter((x) => x.status === 'expiring');
  const spread = Math.max(...counts) - Math.min(...counts);
  const saturated = STAFF.filter((s) => s.unit === UNIT && s.standbyCount30d >= 4);

  const actions = [];
  shiftBalance.filter((b) => b.ok < b.staffed).forEach((b) => actions.push({
    level: 'bad',
    text: `${SHIFT_TYPES[b.code].name}資深覆蓋僅 ${b.ok}／${b.staffed} 天（無 N3↑ 帶班）→ 將 N3／N4 輪入該班別（畫面 5 點格即改，熱圖立即轉綠）`,
  }));
  spCritical.forEach((c) => actions.push({
    level: 'bad',
    text: c.count === 0
      ? `${CERTS[c.code]}有效持有 0 人——能力已消失 → 立即培訓或啟動跨單位支援`
      : `${CERTS[c.code]}僅 ${c.holders[0]} 一人（單點故障）→ 培訓第二位持有者是最便宜的保險`,
  }));
  expired.forEach((x) => actions.push({
    level: 'warn',
    text: `${x.id} 的 ${CERT_SHORT[x.code]} 已於 ${x.expiry} 過期 → 安排回訓（回訓前不計入戰力）`,
  }));
  expSoon.forEach((x) => actions.push({
    level: 'warn',
    text: `${x.id} 的 ${CERT_SHORT[x.code]} 將於 ${x.expiry} 到期 → 預排回訓`,
  }));
  if (saturated.length) actions.push({
    level: 'warn',
    text: `${saturated.map((s) => s.id).join('、')} 近 30 天代班已達 ${saturated.map((s) => s.standbyCount30d).join('、')} 次 → 暫停指派、優先輪替他人`,
  });

  const covChart = chartHBar(shiftBalance.map((b) => ({
    label: SHIFT_TYPES[b.code].name,
    right: `${b.ok}／${b.staffed} 天`,
    segs: [
      { v: b.ok, color: 'var(--ok)', title: '有 N3↑ 帶班' },
      { v: b.staffed - b.ok, color: 'var(--danger)', title: '無資深帶班' },
    ],
  })), { max: Math.max(...shiftBalance.map((b) => b.staffed)) });

  const standbyChart = chartHBar(
    STAFF.filter((s) => s.unit === UNIT).map((s) => ({
      label: s.id,
      right: `${s.standbyCount30d} 次`,
      segs: [{ v: s.standbyCount30d, color: s.standbyCount30d >= 4 ? 'var(--danger)' : 'var(--brand)', title: '近 30 天代班' }],
    })), { max: 5, marker: { v: 5 } });

  $('#capability-body').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">${stampTag()}</div>
    <div class="kpi-row">
      <div class="kpi ${balanceBad ? 'kpi-bad' : 'kpi-ok'}">
        <div class="kpi-num">${worstBalance.ok}／${worstBalance.staffed}</div>
        <div class="kpi-lbl">帶班平衡（最弱：${SHIFT_TYPES[worstBalance.code].name}的資深覆蓋天數）</div>
      </div>
      <div class="kpi ${spCritical.length ? 'kpi-bad' : 'kpi-ok'}">
        <div class="kpi-num">${spCritical.length}</div>
        <div class="kpi-lbl">資格單點依賴（有效持有 ≤ 1 人）</div>
      </div>
      <div class="kpi ${(expired.length + expSoon.length) ? 'kpi-warn' : 'kpi-ok'}">
        <div class="kpi-num">${expired.length}＋${expSoon.length}</div>
        <div class="kpi-lbl">證照：已過期＋90 天內到期</div>
      </div>
      <div class="kpi ${spread >= 3 ? 'kpi-warn' : 'kpi-ok'}">
        <div class="kpi-num">${spread}</div>
        <div class="kpi-lbl">代班集中度（最高 − 最低次數）</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>三班資深覆蓋（N3↑ 帶班）</h2>
        <span class="tag ${balanceBad ? 'tag-danger' : 'tag-ok'}">綠＝有資深、紅＝無</span>
      </div>
      ${covChart}
    </div>

    <div class="card">
      <div class="card-head">
        <h2>需要行動</h2>
        <span class="tag ${actions.some((a) => a.level === 'bad') ? 'tag-danger' : (actions.length ? 'tag-warn' : 'tag-ok')}">${actions.length} 項</span>
      </div>
      ${actions.length
        ? actions.map((a) => `<div class="act-item"><span class="act-dot ${a.level}"></span><span>${a.text}</span></div>`).join('')
        : '<div class="sc-evi">目前無需行動事項——三班平衡、無單點依賴、證照效期健康。</div>'}
      <p class="fineprint">上方結論磚只報狀態、這裡只列「要做什麼」；全部依據與明細收在下方抽屜，點開即查。</p>
    </div>

    <details class="drill">
      <summary>三班帶班平衡熱圖（依據）</summary>
      <div class="drill-body">
        <div class="table-scroll"><table>${mixHead}<tbody>${mixBody}</tbody></table></div>
        <p class="fineprint">每格為該班在班人員的進階組成（滑鼠停留看名單）；無 N3 以上的班標紅。調整方向：把資深輪進夜班（畫面 5 點格即改），或於「班表生成」納入帶班約束（藍圖下一步）。</p>
      </div>
    </details>

    <details class="drill">
      <summary>徽章牆：進階 × 資格效期（全員）</summary>
      <div class="drill-body">
        <div class="table-scroll"><table>
          <thead><tr><th>人員</th><th>進階</th><th>資格徽章（灰＝過期不計戰力）</th></tr></thead>
          <tbody>${wall}</tbody>
        </table></div>
      </div>
    </details>

    <details class="drill">
      <summary>單點依賴與到期雷達（全清單）</summary>
      <div class="drill-body">
        <h4 style="margin:8px 0 4px;font-size:13px;color:var(--ink-faint)">各資格有效持有人</h4>
        ${spRows}
        <p class="fineprint">大夜的呼吸器覆蓋 ${nightCerts ? nightCerts.certs.find((c) => c.cert === 'VENT').coveredDays : 0}／${nightCerts ? nightCerts.staffedDays : 0} 天——單點依賴＋夜間零覆蓋，是畫面 7 韌性模式劇本的前兆。</p>
        <h4 style="margin:12px 0 4px;font-size:13px;color:var(--ink-faint)">到期雷達（未來 90 天）</h4>
        ${radarRows}
      </div>
    </details>

    <details class="drill">
      <summary>出勤與公平快照（本週；正式導入後累積為趨勢）</summary>
      <div class="drill-body">
        <h4 style="margin:8px 0 0;font-size:13px;color:var(--ink-faint)">近 30 天代班分佈（虛線＝飽和門檻 5 次）</h4>
        ${standbyChart}
        <div class="fact"><span>請假影響</span><span>${leaveWho.length} 人、${leaveDays.length} 人日（${leaveWho.map(esc).join('、') || '無'}）——缺口帳見「人力缺口」頁</span></div>
        <div class="fact"><span>替補集中度（近 30 天）</span><span>最高 ${Math.max(...counts)} 次／最低 ${Math.min(...counts)} 次</span></div>
        <div class="fact"><span>公平性飽和警戒</span><span>${saturated.map((s) => s.id).join('、') || '無'}（達 4 次以上，再叫班即觸頂）</span></div>
        <p class="fineprint">出勤與公平是離職螺旋的前導指標：缺人 → 集中叫班 → 更多人離開。目標是在螺旋成形前看見它。</p>
      </div>
    </details>`;
}

/* ══ ◎ 人力缺口總覽（管理首頁）═════════════════════════ */

/**
 * 缺口方程式：營運所需 − 可合法且合理排入 ＝ 實際缺口。
 * 主敘事以名單完整的示範單位（內科 3A）呈現；部分名單與無資料單位
 * 誠實標示，不讓殘缺資料撐出假數字。班表寫回後即時重算。
 */
/* ══ 畫面 今：今日戰情 ═══════════════════════════════════
 * 護理長每天上工的第一眼。總覽是給督導與護理部看「這週」的帳，
 * 這一頁只回答四個問題：今天到齊了嗎、48 小時內哪裡有洞、
 * 誰在請假、哪張證照要到期——每個洞都能就地起跳去處理。 */

const DEMO_TODAY = GAP_EVENT.raisedAt.slice(0, 10);

function renderToday() {
  const el = $('#today-body');
  if (!el) return;
  const today = state.todayDate;
  const next2 = [addDays(today, 1), addDays(today, 2)];
  // 缺口判定口徑與入口／總覽一致：只算名單完整的示範單位，
  // 部分名單單位（外科 5B、ICU）的殘缺資料不得撐出嚇人的假缺口
  const FULL_ROSTER_UNITS = ['MED-3A'];
  $('#today-title').textContent =
    `${today}（${weekdayOf(today)}）${today === DEMO_TODAY ? '｜示範今日' : ''}`;

  /* 今日三班在班 */
  const cols = Object.values(SHIFT_TYPES).map((t) => {
    const rows = SHIFTS.filter((s) => s.date === today && s.shift === t.code)
      .slice().sort((a, b) => (a.staffId < b.staffId ? -1 : 1));
    const short = FULL_ROSTER_UNITS.map((u) => ({
      u, n: rows.filter((s) => s.unit === u).length, min: (UNIT_MIN_STAFF[u] || {})[t.code] || 0,
    })).filter((x) => x.n < x.min);
    const chips = rows.map((s) =>
      `<span class="chip today-chip">${esc(s.staffId)}${s.isReplacement ? '<sup>替</sup>' : s.isSwap ? '<sup>換</sup>' : ''}` +
      `<span class="qp-cnt">${esc(s.unit)}</span></span>`).join('');
    return `<div class="qp-col${short.length ? ' today-short' : ''}">
      <div class="qp-col-head"><b>${t.name}</b><span class="qp-time">${t.start}–${t.end}</span>
        <span class="qp-time" style="margin-left:auto">${rows.length} 人</span></div>
      ${chips ? `<div class="qp-people">${chips}</div>` : '<div class="qp-col-empty">無人排班</div>'}
      ${short.map((x) => `<div class="today-gap">▲ ${esc(UNITS[x.u])}低於最低配置：${x.n}／需 ${x.min}</div>`).join('')}
    </div>`;
  }).join('');

  /* 未來 48 小時缺口（含最低配置比對；部分名單與無資料單位誠實略過不假裝） */
  const gaps = engine.coverageGaps(next2)
    .filter((g) => !g.noData && FULL_ROSTER_UNITS.includes(g.unit));
  const gapRows = gaps.map((g) => `
    <div class="fact">
      <span>${shortDate(g.date)}（${weekdayOf(g.date)}）${SHIFT_TYPES[g.shift].name} @ ${esc(UNITS[g.unit])}</span>
      <span><span class="expired">${g.count}／需 ${g.min}</span>
        <button class="btn btn-sm today-goto-roster" data-d="${g.date}">去排補</button>
        <button class="btn btn-sm today-goto-intake" data-d="${g.date}">快速通報</button></span>
    </div>`).join('');

  /* 今日請假與異動、證照到期（7 天內）與已過期 */
  const onLeave = STAFF.filter((s) => engine.isOnLeave(s, today))
    .map((s) => ({ s, lv: engine.leaveOn ? engine.leaveOn(s, today) : s.leaves.find((l) => today >= l.from && today <= l.to) }));
  const changes = SHIFTS.filter((s) => s.date === today && (s.isReplacement || s.isSwap));
  const expSoon = [];
  const expired = [];
  STAFF.forEach((s) => Object.entries(s.certs).forEach(([code, exp]) => {
    if (exp < today) expired.push({ s, code, exp });
    else if (exp <= addDays(today, 7)) expSoon.push({ s, code, exp });
  }));

  el.innerHTML = `
    <div class="qp-board" style="margin-bottom:14px">${cols}</div>

    <div class="card-head" style="margin-top:4px"><h2>未來 48 小時</h2>
      <span class="tag ${gaps.length ? 'tag-danger' : 'tag-ok'}">${gaps.length ? `${gaps.length} 個缺口` : '無缺口'}</span></div>
    ${gapRows || '<p class="fineprint" style="margin:4px 0 0">明後兩天各單位皆達最低配置。</p>'}

    <div class="grid-2" style="margin-top:16px">
      <div>
        <div class="card-head"><h2>今日請假</h2>
          <span class="tag ${onLeave.length ? 'tag-warn' : 'tag-neutral'}">${onLeave.length} 人</span></div>
        ${onLeave.map(({ s, lv }) => `
          <div class="fact"><span><b>${esc(s.id)}</b>　${esc(UNITS[s.unit])}</span>
            <span>${esc(lv ? lv.type : '請假')}（${lv ? `${shortDate(lv.from)}–${shortDate(lv.to)}` : ''}）</span></div>`).join('')
      || '<p class="fineprint" style="margin:4px 0 0">今日無人請假。</p>'}
        <div class="card-head" style="margin-top:14px"><h2>今日異動</h2>
          <span class="tag tag-neutral">${changes.length} 筆</span></div>
        ${changes.map((s) => `
          <div class="fact"><span><b>${esc(s.staffId)}</b>　${SHIFT_TYPES[s.shift].name} @ ${esc(UNITS[s.unit])}</span>
            <span>${s.isReplacement ? '替補上班' : '換班承接'}</span></div>`).join('')
      || '<p class="fineprint" style="margin:4px 0 0">今日班表無替補或換班異動。</p>'}
      </div>
      <div>
        <div class="card-head"><h2>證照效期警示</h2>
          <span class="tag ${expired.length || expSoon.length ? 'tag-danger' : 'tag-ok'}">${expired.length ? `${expired.length} 張已過期` : ''}${expired.length && expSoon.length ? '、' : ''}${expSoon.length ? `${expSoon.length} 張 7 日內到期` : ''}${!expired.length && !expSoon.length ? '全數有效' : ''}</span></div>
        ${expired.map((x) => `
          <div class="fact"><span><b>${esc(x.s.id)}</b>　${esc(CERTS[x.code])}</span>
            <span class="expired">已於 ${x.exp} 過期，未回訓</span></div>`).join('')}
        ${expSoon.map((x) => `
          <div class="fact"><span><b>${esc(x.s.id)}</b>　${esc(CERTS[x.code])}</span>
            <span style="color:var(--warn)">將於 ${x.exp} 到期</span></div>`).join('')}
        ${!expired.length && !expSoon.length ? '<p class="fineprint" style="margin:4px 0 0">未來 7 天內無證照到期。</p>' : ''}
        <p class="fineprint">效期三態與 90 天到期雷達的完整清單見「能力與出勤」。</p>
      </div>
    </div>`;

  $$('#today-body .today-goto-roster').forEach((b) => b.addEventListener('click', () => {
    state.rosterWeekStart = weekDatesOf(b.dataset.d)[0];
    renderRoster();
    switchScreen('roster');
  }));
  $$('#today-body .today-goto-intake').forEach((b) => b.addEventListener('click', () => {
    state.qpWeekStart = weekDatesOf(b.dataset.d)[0];
    state.qpDay = b.dataset.d;
    renderQuickPick();
    switchScreen('intake');
  }));
}

function renderOverview() {
  const r = engine.workforceGapAnalysis({ dates: WEEK_DATES, demand: UNIT_MIN_STAFF });
  const UNIT = 'MED-3A';
  const cells = r.cells.filter((c) => c.unit === UNIT);
  const gapCells = cells.filter((c) => c.gap > 0);
  const fills = r.absorb.fills.filter((f) => f.unit === UNIT);
  const residual = r.absorb.residual.filter((u) => u.unit === UNIT);
  const flagged = fills.filter((f) => f.flags.length > 0);
  const need = cells.reduce((n, c) => n + c.need, 0);
  const sched = cells.reduce((n, c) => n + Math.min(c.scheduled, c.need), 0);
  const gapHours = gapCells.reduce((h, c) => h + SHIFT_TYPES[c.shift].hours * c.gap, 0);

  /* 缺口矩陣：班別 × 日期 */
  const matrixHead = `<thead><tr><th>班別</th>${WEEK_DATES.map((d) =>
    `<th class="center">${shortDate(d)}<br>（${weekdayOf(d)}）</th>`).join('')}<th class="center">缺口天數</th></tr></thead>`;
  const matrixBody = ['D', 'E', 'N'].map((code) => {
    const row = WEEK_DATES.map((d) => {
      const cell = cells.find((c) => c.date === d && c.shift === code);
      if (!cell) return '<td class="center" style="color:var(--ink-faint)">·</td>';
      return cell.gap > 0
        ? '<td class="center"><span class="cell cell-G">缺</span></td>'
        : '<td class="center" style="color:var(--ink-faint)">✓</td>';
    }).join('');
    const days = gapCells.filter((c) => c.shift === code).length;
    return `<tr><td><b>${SHIFT_TYPES[code].name}</b></td>${row}
      <td class="center">${days ? `<b class="expired">${days} 天</b>` : '0'}</td></tr>`;
  }).join('');

  const FLAG_TEXT = { F1: '加班超時需核准', F2: '連續上班天數偏高', F3: '跨單位支援', F4: '公平性集中風險' };
  const fillRows = fills.map((f) => `
    <div class="fact">
      <span>${shortDate(f.date)}（${weekdayOf(f.date)}）${SHIFT_TYPES[f.shift].name} → <b>${esc(f.staffId)}</b>${f.cross ? '（跨單位）' : ''}</span>
      <span>${f.flags.length ? f.flags.map((c) => `<span class="tag tag-warn">${c} ${FLAG_TEXT[c] || ''}</span>`).join(' ') : '<span style="color:var(--ink-faint)">無風險標記</span>'}</span>
    </div>`).join('');

  const structuralMed = r.structural.filter((s) => s.unit === UNIT);
  const structuralOther = r.structural.filter((s) => s.unit !== UNIT);

  /* 行動清單：紅在前、黃在後，每項都收斂到一個動作 */
  const ovActions = [];
  residual.forEach((u) => ovActions.push({
    level: 'bad',
    text: `${shortDate(u.date)}（${weekdayOf(u.date)}）${SHIFT_TYPES[u.shift].name}無人可合法填補（${u.blockers.map((b) => `${b.code} 擋下 ${b.count} 人`).join('；')}）→ 上報院級調度或跨單位支援`,
  }));
  structuralMed.forEach((s) => ovActions.push({
    level: 'bad',
    text: `${SHIFT_TYPES[s.shift].name}一週 ${s.days}／${WEEK_DATES.length} 天出現缺口——結構性 → 員額評估、夜班培訓、把需求放進「班表生成」從源頭排滿`,
  }));
  if (flagged.length) ovActions.push({
    level: 'warn',
    text: `可吸收的 ${fills.length} 筆中 ${flagged.length} 筆帶公平性代價（${[...new Set(flagged.map((f) => f.staffId))].join('、')}）→ 吸收不等於建議照做，留意集中在少數人身上`,
  });

  const eqChart = chartHBar([{
    label: '本週人力帳',
    right: `需求 ${need} 班次`,
    segs: [
      { v: sched, color: 'var(--brand)', title: '已排定' },
      { v: fills.length, color: '#2f7180', title: '可合法吸收' },
      { v: residual.length, color: 'var(--danger)', title: '殘餘缺口' },
    ],
  }], { max: need });

  const gapChart = chartHBar(['D', 'E', 'N'].map((code) => {
    const n = gapCells.filter((c) => c.shift === code).length;
    return {
      label: SHIFT_TYPES[code].name,
      right: `${n} 班次`,
      segs: [{ v: n, color: 'var(--danger)', title: '缺口' }],
    };
  }), { max: WEEK_DATES.length });

  $('#overview-body').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>缺口方程式｜${UNITS[UNIT]}（本週）</h2>
        <span>${stampTag()} <span class="tag tag-neutral">名單完整之示範單位</span></span>
      </div>
      <div class="ov-eq">
        <div class="ov-term"><div class="ov-num">${need}</div><div class="ov-lbl">營運所需（班次）</div></div>
        <div class="ov-op">−</div>
        <div class="ov-term"><div class="ov-num">${sched}</div><div class="ov-lbl">已排定</div></div>
        <div class="ov-op">＝</div>
        <div class="ov-term"><div class="ov-num danger">${gapCells.length}</div><div class="ov-lbl">缺口班次（${gapHours} 小時）</div></div>
        <div class="ov-op">→</div>
        <div class="ov-term"><div class="ov-num ok">${fills.length}</div><div class="ov-lbl">可合法吸收</div></div>
        <div class="ov-op">＝</div>
        <div class="ov-term"><div class="ov-num ${residual.length ? 'danger' : 'ok'}">${residual.length}</div><div class="ov-lbl">殘餘缺口</div></div>
      </div>
      ${eqChart}
      <div class="legend">
        <span><i class="dot" style="background:var(--brand)"></i>已排定</span>
        <span><i class="dot" style="background:#2f7180"></i>可合法吸收</span>
        <span><i class="dot" style="background:var(--danger)"></i>殘餘缺口</span>
      </div>
      <p class="fineprint">一句話：本週缺 ${gapCells.length} 班次可全數合法吸收${flagged.length ? `，但 ${flagged.length} 筆有公平性代價` : ''}${structuralMed.length ? `；${structuralMed.map((s) => SHIFT_TYPES[s.shift].name).join('、')}為結構性缺口，補洞不是解方` : ''}。</p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>需要行動</h2>
        <span class="tag ${ovActions.some((a) => a.level === 'bad') ? 'tag-danger' : (ovActions.length ? 'tag-warn' : 'tag-ok')}">${ovActions.length} 項</span>
      </div>
      ${ovActions.length
        ? ovActions.map((a) => `<div class="act-item"><span class="act-dot ${a.level}"></span><span>${a.text}</span></div>`).join('')
        : '<div class="sc-evi">本週缺口全數可吸收且無結構性訊號。</div>'}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-primary" id="btn-ov-intake">處理今日缺班通報 →</button>
        <button class="btn" id="btn-ov-multi">多筆缺班與全局指派 →</button>
        <button class="btn" id="btn-ov-generate">生成下週班表（第 0 層）→</button>
      </div>
    </div>

    <details class="drill">
      <summary>缺口矩陣：班別 × 日期（依據）</summary>
      <div class="drill-body">
        <h4 style="margin:8px 0 0;font-size:13px;color:var(--ink-faint)">各班別缺口天數</h4>
        ${gapChart}
        <div class="table-scroll"><table>${matrixHead}<tbody>${matrixBody}</tbody></table></div>
        <p class="fineprint">需求基準＝各班別最低安全配置（規則庫可調）。</p>
      </div>
    </details>

    <details class="drill">
      <summary>吸收方案逐筆（含代價與殘餘）</summary>
      <div class="drill-body">
        ${fillRows || '<div class="empty-state">本週無缺口需要填補。</div>'}
        ${residual.length ? `
          <h4 style="margin:12px 0 4px;font-size:13px;color:var(--ink-faint)">殘餘缺口（無人可合法填補）</h4>
          ${residual.map((u) => `<div class="fact"><span>${shortDate(u.date)} ${SHIFT_TYPES[u.shift].name}</span>
            <span class="expired">${u.blockers.map((b) => `${b.code} 擋下 ${b.count} 人`).join('；')}</span></div>`).join('')}` : ''}
        <p class="fineprint">每一筆都通過 H1–H6 硬性檢查，但<b>可吸收 ≠ 建議照做</b>——公平性標記（F4）是「補得上，但不該一直這樣補」的訊號，決定權在主管。</p>
      </div>
    </details>

    <details class="drill">
      <summary>其他單位與資料誠實聲明</summary>
      <div class="drill-body">
        <div class="fact"><span>外科病房 5B</span><span>缺口 ${r.cells.filter((c) => c.unit === 'SUR-5B' && c.gap > 0).length} 格，殘餘 ${r.absorb.residual.filter((u) => u.unit === 'SUR-5B').length} 格${structuralOther.filter((s) => s.unit === 'SUR-5B').length ? '（含結構性）' : ''}——<b>示範資料僅含該單位部分名單，數字為機制展示</b></span></div>
        <div class="fact"><span>加護病房</span><span>無排班資料，不列入計算（noData）——系統不對沒有資料的單位假裝算得出缺口</span></div>
      </div>
    </details>

    <details class="drill">
      <summary>待驗證假設（企業訪談清單）與平台定位</summary>
      <div class="drill-body">
        <ul style="margin:0;padding-left:18px;font-size:13.5px">
          <li>管理者目前能否快速且精準地知道「缺多少人」？</li>
          <li>缺口是否經常到很晚才被發現？</li>
          <li>現行缺口以總人數、班次、工時還是專業資格衡量？</li>
          <li>若能提早看到缺口及其影響，管理者實際可採取哪些行動？</li>
        </ul>
        <p class="fineprint">本平台定位：缺工情境下的排班與人力缺口決策支援工具——不承諾解決整體醫療缺工，
          承諾把缺工從模糊感受變成可量化、可追蹤、可行動的管理資訊。缺口紀錄持續累積後，
          可支援招募員額、預算編列、跨院區支援與培訓規劃等中長期決策。</p>
      </div>
    </details>`;

  $('#btn-ov-intake').addEventListener('click', () => switchScreen('intake'));
  $('#btn-ov-multi').addEventListener('click', () => switchScreen('multi'));
  $('#btn-ov-generate').addEventListener('click', () => switchScreen('generate'));
}

/* ══ 畫面 1：缺班事件建立 ═══════════════════════════════ */

let parsing = false;

async function handleParse() {
  // 重入保護：貼上事件與按鈕點擊可能重疊觸發，同時跑兩次會互相覆蓋畫面
  if (parsing) return;
  parsing = true;
  const btn = $('#btn-parse');
  btn.disabled = true;
  btn.innerHTML = `${icon('sparkles')}解析中…`;
  try {
    await doParse();
  } finally {
    // 不論成功失敗，按鈕都要回復可用——解析失敗時畫面不能卡在「解析中」
    parsing = false;
    btn.disabled = false;
    btn.innerHTML = `${icon('sparkles')}重新解析`;
  }
}

async function doParse() {
  // 骨架載入：形狀對應即將出現的五列解析結果，而不是一行文字
  $('#parse-result').innerHTML = '<div class="skeleton-rows">' +
    Array.from({ length: 5 }, () =>
      '<div class="sk-row"><i class="sk sk-key"></i><i class="sk sk-val"></i></div>').join('') +
    '</div>';

  const parsed = await llmParseGapMessage($('#raw-message').value);
  state.parsed = parsed;

  const e = parsed.extracted;
  const row = (key, f) => `
    <div class="field-row">
      <div class="field-key">${key}</div>
      <div>
        ${f.value
          ? `<div class="field-val">${esc(f.label)}</div><div class="field-src">依據：${esc(f.source)}</div>`
          : '<div class="field-val field-missing">訊息未提及 —— 待主管補充</div><div class="field-src">Agent 不自行推測，改以追問處理</div>'}
      </div>
    </div>`;

  $('#parse-result').className = '';
  $('#parse-result').innerHTML =
    row('缺班日期', e.date) + row('缺班班別', e.shift) + row('缺班原因', e.reason) +
    row('照護單位', e.unit) + row('必要資格', e.requiredCerts);

  /* 四項關鍵欄位一律可編輯：缺漏的轉為追問，已解析的預填並開放主管修正——
   * Agent 解析可能出錯，最終認定權在主管，不能只靠改寫訊息重來 */
  const INPUTS = {
    date: (v) => `<input type="text" id="ans-date" value="${esc(v || GAP_EVENT.date)}" placeholder="YYYY-MM-DD">`,
    shift: (v) => `<select id="ans-shift">${Object.values(SHIFT_TYPES).map((t) =>
      `<option value="${t.code}"${t.code === (v || 'D') ? ' selected' : ''}>${t.name} ${t.start}–${t.end}</option>`).join('')}</select>`,
    unit: (v) => `<select id="ans-unit">${Object.entries(UNITS).map(([k, nm]) =>
      `<option value="${k}"${k === (v || 'MED-3A') ? ' selected' : ''}>${nm}（${k}）</option>`).join('')}</select>`,
    requiredCerts: (v) => `<div class="checks">${Object.entries(CERTS).map(([k, nm]) =>
      `<label><input type="checkbox" class="ans-cert" value="${k}"
        ${(v || GAP_EVENT.requiredCerts).includes(k) ? 'checked' : ''}> ${nm}</label>`).join('')}</div>
      <div class="q-hint" style="margin:8px 0 0">${esc(GAP_EVENT.contextNote)}</div>`,
  };
  const FIELD_LABELS = { date: '缺班日期', shift: '缺班班別', unit: '照護單位', requiredCerts: '必要資格' };

  $('#followup-body').innerHTML = ['date', 'shift', 'unit', 'requiredCerts'].map((f) => {
    const m = parsed.missing.find((x) => x.field === f);
    if (m) {
      return `
        <div class="q-block">
          <div class="q-text">${esc(m.question)}</div>
          <div class="q-hint">${esc(m.hint)}</div>
          ${INPUTS[f](null)}
        </div>`;
    }
    const ex = parsed.extracted[f];
    return `
      <div class="q-block q-confirmed">
        <div class="q-text">${FIELD_LABELS[f]}：${esc(ex.label)}</div>
        <div class="q-hint">依據：${esc(ex.source)}。解析有誤可直接修正。</div>
        ${INPUTS[f](ex.value)}
      </div>`;
  }).join('');

  $('#followup-card').hidden = false;
  $('#followup-note').textContent = parsed.missing.length === 0
    ? '四項欄位皆已解析，請主管確認無誤後執行評估。'
    : `${parsed.missing.length} 項未載明轉為追問；其餘已解析，請確認或修正。`;

  const got = ['date', 'shift', 'unit', 'requiredCerts'].filter((f) => parsed.extracted[f].value);
  logAction('解析通報訊息',
    `自訊息抽出 ${got.length} 項欄位（${got.join('、')}）；${parsed.missing.length} 項未載明，轉為追問`);
}

function handleEvaluate() {
  const answers = { reporterStaffId: $('#ans-reporter').value || null };
  if ($('#ans-date')) {
    // 追問欄位被清空也要擋下來，否則會帶著 null 日期進引擎；
    // 格式對但不存在的日期（2026-02-31）也要擋——JS Date 會自動進位成別的日子
    answers.date = $('#ans-date').value.trim();
    if (!isValidDateStr(answers.date)) {
      alert('日期請填實際存在的日期，格式 YYYY-MM-DD。');
      return;
    }
  }
  if ($('#ans-shift')) answers.shift = $('#ans-shift').value;
  if ($('#ans-unit')) answers.unit = $('#ans-unit').value;
  if ($$('.ans-cert').length) {
    answers.requiredCerts = $$('.ans-cert').filter((c) => c.checked).map((c) => c.value);
    if (answers.requiredCerts.length === 0) {
      alert('請至少選擇一項必要資格。');
      return;
    }
  }

  state.gap = completeGapEvent(state.parsed.extracted, answers);
  state.chosen = null;
  state.confirmed = false;
  state.suggestedId = null;   // 一般流程沒有全局建議標示
  state.result = engine.evaluateGap(state.gap);

  const g = state.gap;
  logAction('確認缺班條件',
    `${g.date}（${weekdayOf(g.date)}）${SHIFT_TYPES[g.shift].name} @ ${UNITS[g.unit]}；` +
    `必要資格：${g.requiredCerts.map((c) => CERTS[c]).join('、')}` +
    (g.originalStaffId ? `；通報人員 ${g.originalStaffId}` : '；通報人員未識別'));
  logAction('執行替補評估',
    `評估 ${STAFF.length} 名人員，排除 ${state.result.excluded.length} 名，產生 ${state.result.candidates.length} 名合格候選人`,
    '班守 ShiftGuard 規則引擎');

  renderCandidates();
  renderConfirmPlaceholder();
  renderRoster();
  renderStaffTable();   // 證照效期以本次事件日期重新判定
  switchScreen('candidates');
}

/* ══ 畫面 1：快速通報（班表點選）════════════════════════
 * 「貼訊息」是替代路徑，不是必經之路——缺班的人本來就在班表上。
 * 點日期 → 當天三班在班名單 → 點人即通報：人、日期、班別、單位
 * 直接取自班表（來源可稽核），只剩「必要資格」需要主管確認，
 * 這一項系統不臆測（與訊息流程的追問同一原則）。
 * 多選即多筆：交給 assignGreedy／assignJointly 一起計算，
 * 再沿用畫面 7 的佇列機制逐筆走主管確認。 */

const QP_DEFAULT_CERTS = ['ACLS'];   // 院內政策：每班需 ACLS（同畫面 8 生成條件），主管可調整
const QP_MAX_BATCH = 4;              // 全局指派為完整枚舉，筆數上限防止組合爆炸（4 筆已逾一晚倒兩人的常態）

function qpKey(sel) { return `${sel.staffId}|${sel.date}|${sel.shift}`; }

function qpDates() {
  return Array.from({ length: 7 }, (_, i) => addDays(state.qpWeekStart, i));
}

function renderQuickPick() {
  if (!$('#qp-days')) return;
  // 班表被編輯後，點選中的班次可能已不存在——逐筆核對，失效的自動移除
  [...state.quickSel.values()].forEach((sel) => {
    const alive = SHIFTS.some((s) => s.staffId === sel.staffId && s.date === sel.date && s.shift === sel.shift);
    if (!alive) state.quickSel.delete(qpKey(sel));
  });

  const dates = qpDates();
  $('#qp-week-label').textContent = state.qpWeekStart === WEEK.start
    ? WEEK.label
    : `${shortDate(dates[0])}（一）– ${shortDate(dates[6])}（日）`;

  $('#qp-days').innerHTML = dates.map((d) => {
    const n = SHIFTS.filter((s) => s.date === d).length;
    return `<button class="chip${d === state.qpDay ? ' active' : ''}" data-day="${d}" aria-pressed="${d === state.qpDay}">` +
      `${shortDate(d)}（${weekdayOf(d)}）<span class="qp-cnt">${n} 班</span></button>`;
  }).join('');

  $('#qp-board').innerHTML = Object.values(SHIFT_TYPES).map((t) => {
    const rows = SHIFTS.filter((s) => s.date === state.qpDay && s.shift === t.code)
      .slice().sort((a, b) => (a.staffId < b.staffId ? -1 : 1));
    const people = rows.map((s) => {
      const selected = state.quickSel.has(`${s.staffId}|${s.date}|${s.shift}`);
      const label = `${selected ? '取消通報' : '通報缺班'}：${s.staffId} ${t.name} @ ${UNITS[s.unit] || s.unit}`;
      return `<button class="qp-person${selected ? ' sel' : ''}" data-sid="${esc(s.staffId)}"` +
        ` data-d="${s.date}" data-sh="${s.shift}" data-u="${esc(s.unit)}"` +
        ` aria-pressed="${selected}" aria-label="${esc(label)}" title="${esc(label)}">` +
        `${esc(s.staffId)}${s.isReplacement ? '<sup>替</sup>' : ''}<span class="qp-unit">${esc(s.unit)}</span></button>`;
    }).join('');
    return `<div class="qp-col">
      <div class="qp-col-head"><b>${t.name}</b><span class="qp-time">${t.start}–${t.end}</span>
        <span class="qp-time" style="margin-left:auto">${rows.length} 人在班</span></div>
      ${people ? `<div class="qp-people">${people}</div>` : '<div class="qp-col-empty">當日此班別無人排班</div>'}
    </div>`;
  }).join('');

  renderQuickSelected();
}

function qpSortedSels() {
  return [...state.quickSel.values()]
    .sort((a, b) => (a.date + a.shift + a.staffId < b.date + b.shift + b.staffId ? -1 : 1));
}

function renderQuickSelected() {
  const sels = qpSortedSels();
  $('#qp-selected').innerHTML = !sels.length ? '' : `
    <div class="qp-sel-head">待通報缺班（${sels.length} 筆）——人／日期／班別／單位取自班表；請逐筆確認必要資格與職務門檻：</div>
    ${sels.map((sel) => `
      <div class="qp-sel-row" data-key="${esc(qpKey(sel))}">
        <div class="qp-sel-who"><b>${esc(sel.staffId)}</b> 缺班<br>${multiGapLabel(sel)}</div>
        <div class="checks">${Object.entries(CERTS).map(([k, nm]) => `
          <label><input type="checkbox" class="qp-cert" value="${k}"${sel.certs.includes(k) ? ' checked' : ''}> ${esc(nm)}</label>`).join('')}</div>
        <select class="qp-role">
          ${['護理師', '資深護理師'].map((r) => `<option value="${r}"${sel.role === r ? ' selected' : ''}>${r}以上</option>`).join('')}
        </select>
        <button class="btn btn-sm qp-remove">移除</button>
      </div>`).join('')}`;
  updateQpRunBtn();
}

function updateQpRunBtn() {
  const btn = $('#btn-qp-run');
  if (!btn) return;
  const n = state.quickSel.size;
  btn.disabled = n === 0;
  btn.innerHTML = icon('user-check') + (n === 0 ? '請先在上方點選缺班人員'
    : n === 1 ? '建立缺班事件，開始尋找替補'
      : `全局指派：${n} 筆缺班一起找替補`);
}

function qpTogglePerson(btnEl) {
  const key = `${btnEl.dataset.sid}|${btnEl.dataset.d}|${btnEl.dataset.sh}`;
  if (state.quickSel.has(key)) {
    state.quickSel.delete(key);
  } else {
    state.quickSel.set(key, {
      staffId: btnEl.dataset.sid, date: btnEl.dataset.d, shift: btnEl.dataset.sh,
      unit: btnEl.dataset.u, certs: [...QP_DEFAULT_CERTS], role: '護理師',
    });
  }
  $('#qp-result').innerHTML = '';   // 選擇一變，上一輪指派結果即過期，不得殘留誤導
  renderQuickPick();
  MOTION.pop($(`#qp-board .qp-person[data-sid="${btnEl.dataset.sid}"][data-d="${btnEl.dataset.d}"][data-sh="${btnEl.dataset.sh}"]`));
}

function buildQuickGap(sel) {
  return {
    id: `GAP-${sel.date.replace(/-/g, '')}-${sel.shift}-${sel.unit}`,
    date: sel.date, shift: sel.shift, unit: sel.unit,
    requiredRole: sel.role, requiredCerts: [...sel.certs],
    originalStaffId: sel.staffId,
    reason: `原班人員 ${sel.staffId} 臨時請假（快速通報）`,
    raisedBy: '排班快速通報', raisedAt: nowStamp(),
    contextNote: '必要資格由主管於快速通報清單確認',
  };
}

/** 通報成立即事實：該員當日班次取消、標記臨時請假（同示範資料 N-05 的語義，
 *  引擎的 H3 與缺口總覽因此看得到這筆缺勤）。僅存在於本次連線——
 *  刻意不寫 localStorage，重新整理或「還原示範班表」即復原，方便重複演示。 */
function vacateForQuickGap(sel) {
  const idx = SHIFTS.findIndex((s) => s.staffId === sel.staffId && s.date === sel.date && s.shift === sel.shift);
  if (idx >= 0) SHIFTS.splice(idx, 1);
  const staff = STAFF.find((s) => s.id === sel.staffId);
  if (staff && !engine.isOnLeave(staff, sel.date)) {
    staff.leaves.push({ from: sel.date, to: sel.date, type: '臨時請假（快速通報）' });
  }
}

function handleQuickRun() {
  const sels = qpSortedSels();
  if (!sels.length) return;
  if (sels.length > QP_MAX_BATCH) {
    alert(`一次最多 ${QP_MAX_BATCH} 筆（全局指派為完整枚舉所有組合，筆數過多會算不完），請分批處理。`);
    return;
  }
  const noCert = sels.find((s) => s.certs.length === 0);
  if (noCert) {
    alert(`${noCert.staffId}（${multiGapLabel(noCert)}）：請至少勾選一項必要資格。`);
    return;
  }

  const gaps = sels.map(buildQuickGap);
  sels.forEach(vacateForQuickGap);
  state.quickSel.clear();

  gaps.forEach((g) => logAction('快速通報缺班',
    `${multiGapLabel(g)}：原班人員 ${g.originalStaffId} 臨時請假，當日班次取消；` +
    `必要資格 ${g.requiredCerts.map((c) => CERTS[c]).join('、')}、${g.requiredRole}以上（主管於清單確認）`));

  refreshAfterScheduleChange();   // 班次取消 → 名單、缺口帳、預警即時重算
  renderStaffTable();

  if (gaps.length === 1) {
    state.parsed = null;
    state.gap = gaps[0];
    state.chosen = null;
    state.confirmed = false;
    state.suggestedId = null;
    state.multiQueue = [];
    state.result = engine.evaluateGap(state.gap);
    logAction('執行替補評估',
      `評估 ${STAFF.length} 名人員，排除 ${state.result.excluded.length} 名，產生 ${state.result.candidates.length} 名合格候選人`,
      '班守 ShiftGuard 規則引擎');
    toast(`${state.gap.originalStaffId} 缺班已通報，合格候選 ${state.result.candidates.length} 位`,
      state.result.candidates.length ? 'ok' : 'warn');
    renderCandidates();
    renderConfirmPlaceholder();
    switchScreen('candidates');
    return;
  }

  runQuickAssign(gaps);
}

/** 多筆：逐筆貪心與全局指派都算，結果並列；帶入主流程仍逐筆主管確認 */
function runQuickAssign(gaps) {
  const greedy = engine.assignGreedy(gaps);
  const joint = engine.assignJointly(gaps);
  const gFilled = greedy.filter((s) => s.staffId).length;

  const rows = gaps.map((g, i) => {
    const d = joint.details[i];
    return `
      <div class="fact">
        <span>${multiGapLabel(g)}<br><small style="color:var(--ink-faint)">原班 ${esc(g.originalStaffId)}｜需 ${g.requiredCerts.map((c) => CERTS[c]).join('、')}</small></span>
        <span>${d
    ? `全局建議 <b>${esc(d.staffId)}</b>(${d.score} 分)`
    : `<span class="expired">✗ 無人可指派</span> <button class="btn btn-sm qp-drill" data-i="${i}">看排除原因與放寬試算</button>`}</span>
      </div>`;
  }).join('');

  $('#qp-result').innerHTML = `
    <div class="card" style="margin-top:14px;border-color:var(--brand)">
      <div class="card-head">
        <h2>全局指派結果（${gaps.length} 筆一起看）</h2>
        <span class="tag ${joint.filled < gaps.length ? 'tag-danger' : 'tag-ok'}">填補 ${joint.filled}／${gaps.length} 筆</span>
      </div>
      ${rows}
      <p class="fineprint">
        ${joint.filled > gFilled
    ? `逐筆貪心只能補 ${gFilled} 筆：先處理的缺班會把稀缺人力用掉。全局指派把 ${gaps.length} 筆一起看（先求填補筆數、再求總分），多補了 ${joint.filled - gFilled} 筆——方法說明見「替班系統 → 多筆缺班」頁。`
    : `逐筆貪心與全局指派結果一致（各補 ${joint.filled} 筆）；兩種算法皆為確定性運算，數字可完整重現。`}
        ${joint.filled < gaps.length ? '無人可指派的缺班已誠實列示，請沿升級路徑處理（放寬試算／任務重分配），或於缺口總覽追蹤。' : ''}
      </p>
      ${joint.filled > 0 ? `
      <div class="btn-row">
        <button class="btn btn-primary" id="btn-qp-apply" style="margin-top:0">將全局建議帶入主流程，逐筆確認</button>
      </div>
      <p class="fineprint">帶入後仍走完整的候選評估與主管確認；每筆確認寫回後，下一筆會以最新班表重新評估。</p>` : ''}
    </div>`;

  const applyBtn = $('#btn-qp-apply');
  if (applyBtn) applyBtn.addEventListener('click', () => startMultiQueue(gaps, joint));
  $$('#qp-result .qp-drill').forEach((b) => b.addEventListener('click', () => {
    const g = gaps[Number(b.dataset.i)];
    state.parsed = null;
    state.gap = g;
    state.chosen = null;
    state.confirmed = false;
    state.suggestedId = null;
    state.result = engine.evaluateGap(g);
    logAction('檢視無解缺班',
      `${multiGapLabel(g)}：查無合格替補，開啟排除原因與放寬試算`);
    renderCandidates();
    renderConfirmPlaceholder();
    switchScreen('candidates');
  }));
  MOTION.enter($('#qp-result'), '.fact, .card-head, .btn-row');

  toast(`全局指派完成：填補 ${joint.filled}／${gaps.length} 筆`,
    joint.filled < gaps.length ? 'warn' : 'ok');

  logAction('快速通報多筆指派',
    `${gaps.length} 筆缺班：逐筆貪心填補 ${gFilled} 筆，全局指派填補 ${joint.filled} 筆` +
    `（${joint.assignment.map((id, i) => `${multiGapLabel(gaps[i])}→${id || '無'}`).join('、')}）`,
    '班守 ShiftGuard 規則引擎');
}

/* ══ 畫面 2：替補候選人 ═════════════════════════════════ */

function renderGapBanner() {
  const g = state.gap;
  const items = [
    ['缺班單位', UNITS[g.unit]],
    ['缺班時段', `${shortDate(g.date)}（${weekdayOf(g.date)}）${SHIFT_TYPES[g.shift].name} ${SHIFT_TYPES[g.shift].start}–${SHIFT_TYPES[g.shift].end}`],
    ['缺班原因', g.reason],
    ['必要資格', g.requiredCerts.map((c) => CERTS[c]).join('、')],
    ['通報時間', g.raisedAt],
  ];
  $('#gap-banner').innerHTML = `<div class="gap-banner">${items.map(([k, v]) =>
    `<div class="gb-item"><div class="gb-key">${k}</div><div class="gb-val">${esc(v)}</div></div>`).join('')}</div>`;
}

/**
 * 候選人不足時的升級路徑。
 * 命題要求至少提供三位候選人；不足時 Agent 必須說清楚「還能怎麼辦」，
 * 而不是丟一張空白清單給主管。
 */
function renderShortfall(candidates) {
  if (candidates.length >= 3) return '';

  const zero = candidates.length === 0;
  const opts = engine.relaxationAnalysis(state.gap);
  const legal = opts.filter((o) => !o.relax.allowed);
  const soft = opts.filter((o) => o.relax.allowed);

  const optionRow = (o) => `
    <div class="excl">
      <div><span class="rule-code${o.relax.allowed ? ' neutral' : ''}">${o.code}</span></div>
      <div>
        <div class="excl-reason"><b>放寬「${esc(o.name)}」可多出 ${o.unlocked.length} 位：${o.unlocked.join('、')}</b></div>
        <div class="sc-evi">依據：${esc(o.basis)}</div>
        <div class="sc-evi ${o.relax.allowed ? '' : 'expired'}">${o.relax.allowed ? '可評估：' : '不建議放寬：'}${esc(o.relax.note)}</div>
      </div>
    </div>`;

  return `
    <div class="card" style="border-color:var(--danger)">
      <div class="card-head">
        <h2>${zero ? '查無合格候選人' : `合格候選人僅 ${candidates.length} 位，未達建議的 3 位`}</h2>
        <span class="tag tag-danger">需主管決策的升級路徑</span>
      </div>
      <p class="lede" style="margin-bottom:14px">
        Agent 不會自行放寬任何規則。以下是試算結果，是否採行、由誰核准，由授權主管決定。
      </p>
      ${zero ? `<div class="sc-evi" style="margin-bottom:12px">
        決策階梯位置：第 1 層 找合格替補 <b class="expired">✗ 無解</b>
        → <b>第 2 層 放寬試算（下方）</b> → 第 3 層 任務重新分配（本卡片末段）
      </div>` : ''}

      ${soft.length ? `<h4 style="margin:0 0 4px;font-size:13px;color:var(--ink-faint)">可評估的鬆綁選項</h4>${soft.map(optionRow).join('')}` : ''}
      ${legal.length ? `<h4 style="margin:14px 0 4px;font-size:13px;color:var(--ink-faint)">以下條件涉及法規或病安下限，列出僅供了解缺口成因</h4>${legal.map(optionRow).join('')}` : ''}
      ${opts.length === 0 ? '<div class="sc-evi">放寬任何單一條件都無法產生新的候選人，缺口屬結構性人力不足。</div>' : ''}

      <h4 style="margin:16px 0 4px;font-size:13px;color:var(--ink-faint)">不涉及鬆綁規則的其他處理方式</h4>
      <ul style="margin:0;padding-left:18px;font-size:13.5px">
        <li>擴大至鄰近單位支援池，並同步提高交班與 orientation 的時間</li>
        <li>評估拆班（兩人各分擔半班），降低單一人員的工時衝擊</li>
        <li>通報護理部調度中心，啟動院級人力調度或約用人力</li>
      </ul>
      ${zero ? `
      <div class="excl" style="margin-top:14px">
        <div><span class="rule-code">第3層</span></div>
        <div>
          <div class="excl-reason"><b>放寬也無解、外援也來不及時：任務重新分配（韌性模式）</b></div>
          <div class="sc-evi">缺的不再是「一個人」，而是「一班的任務」——把缺班者的任務拆解重分配給在班人力：
            資格硬性匹配、負荷平衡，無人可承接的任務誠實標示為缺口，交主管啟動上報或調度。</div>
          <button class="btn btn-sm" id="btn-goto-realloc" style="margin-top:8px">前往第 3 層：任務重新分配 →</button>
        </div>
      </div>` : ''}
      <p class="fineprint">若本情境反覆出現，代表該單位在此時段的人力配置需要結構性檢討，而非每次靠替補補洞——這正是第 0 層「班表生成」（畫面 8）要從源頭解決的問題。</p>
    </div>`;
}

/**
 * 「Excel 看不出來」的排除：班表上當日沒班、也沒請假，
 * 卻因工時規則（H4／H5／H6）被排除的人。依當次評估結果動態產生，
 * 缺班條件改變時這段話會跟著變，不會殘留與事實不符的敘述。
 */
function renderInvisibleExclusionNote(excluded) {
  const invisible = excluded.filter((e) =>
    !e.isOriginal &&
    e.violations.length > 0 &&
    e.violations.every((v) => ['H4', 'H5', 'H6'].includes(v.code)));
  if (invisible.length === 0) return '';

  const who = invisible.map((e) =>
    `<b>${e.staff.id}</b>（${[...new Set(e.violations.map((v) => v.code))].join('、')}）`).join('、');
  return `
      <p class="fineprint">
        ★ 特別注意 ${who}：班表上當日「沒有班」，用 Excel 篩「有空的人」都會被選出來，
        但工時規則已將${invisible.length > 1 ? '他們' : '他'}排除——這正是規則引擎存在的意義。
      </p>`;
}

async function renderCandidates() {
  renderGapBanner();
  const { candidates, excluded } = state.result;

  const explains = await Promise.all(candidates.map((c) => llmExplainCandidate(c, state.gap)));

  const candHtml = candidates.map((c, i) => {
    const ex = explains[i];
    // 權重全數歸零時 maxTotal 為 0，避免除以零產生 NaN
    const pct = c.score.maxTotal > 0 ? (c.score.total / c.score.maxTotal) * 100 : 0;
    return `
      <div class="cand${c.rank === 1 ? ' top' : ''}" data-idx="${i}">
        <div class="cand-head js-toggle" role="button" tabindex="0" aria-expanded="false">
          <div class="rank">${c.rank}</div>
          <div>
            <div class="cand-id">${esc(c.staff.id)}　<span class="cand-meta">${esc(c.staff.role)} · ${esc(UNITS[c.staff.unit])}</span>${state.suggestedId === c.staff.id ? '　<span class="tag tag-brand">全局建議</span>' : ''}</div>
            <div class="cand-meta">週工時 ${c.score.base} → ${c.score.projected} 小時 ｜ 替補後連續上班 ${c.consecutiveDays} 天 ｜ 近 30 天代班 ${c.staff.standbyCount30d} 次</div>
          </div>
          <div class="cand-spacer"></div>
          <div class="score-wrap">
            <div class="score-num">${c.score.total} <small>/ ${c.score.maxTotal}</small></div>
            <div class="bar"><i style="width:${pct}%"></i></div>
          </div>
          <div class="chev"><span class="chev-arrow">▼</span>展開評分卡</div>
          ${c.flags.length ? `<div class="cand-flags">${c.flags.map((f) =>
            `<span class="flag flag-${f.level}">${f.needsApproval ? '⚠ 需核准 · ' : ''}${esc(f.text)}</span>`).join('')}</div>` : ''}
        </div>

        <div class="cand-body">
          <div class="verdict">${esc(ex.verdict)}</div>

          <div class="reasons">
            <div class="pos">
              <h4>推薦理由</h4>
              <ul>${ex.strengths.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>—</li>'}</ul>
            </div>
            <div class="neg">
              <h4>須留意</h4>
              <ul>${ex.concerns.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>無</li>'}</ul>
            </div>
          </div>

          <div class="scorecard">
            <div class="scorecard-head"><span>評分構面（可於規則庫調整權重）</span><span>得分 / 權重</span></div>
            ${c.score.breakdown.map((b) => `
              <div class="sc-row">
                <div>
                  <div class="sc-name"><span class="sc-code">${b.code}</span>${b.name}</div>
                  <div class="sc-evi">${esc(b.evidence)}</div>
                </div>
                <div class="bar"><i style="width:${b.ratio * 100}%"></i></div>
                <div class="sc-pts">${b.points} <small>/ ${b.weight}</small></div>
              </div>`).join('')}
            <div class="sc-total"><span>加權總分</span><span>${c.score.total} / ${c.score.maxTotal}</span></div>
          </div>

          <div class="btn-row">
            <button class="btn btn-primary js-choose" data-idx="${i}" style="margin-top:0">選定 ${c.staff.id} 為替補人選</button>
          </div>
        </div>
      </div>`;
  }).join('');

  const exclHtml = excluded.map((e) => `
    <div class="excl">
      <div>
        <div class="excl-id">${esc(e.staff.id)}</div>
        <div class="excl-role">${esc(e.staff.role)}</div>
      </div>
      <div>
        ${e.violations.map((v) => `
          <div class="excl-reason">
            <span class="rule-code${v.neutral ? ' neutral' : ''}">${v.code}</span>
            <span>${esc(v.detail)}</span>
          </div>`).join('')}
      </div>
    </div>`).join('');

  $('#candidates-body').innerHTML = `
    ${renderShortfall(candidates)}
    <div class="card">
      <div class="card-head">
        <h2>合格候選人（依適合程度排序）</h2>
        <span class="tag tag-${candidates.length >= 3 ? 'ok' : 'danger'}">${candidates.length} 位通過全部硬性約束</span>
      </div>
      ${candHtml || '<div class="empty-state">沒有任何人員通過全部硬性約束，請參考上方升級路徑。</div>'}
      <p class="fineprint">分數由規則引擎確定性計算；推薦理由與敘述文字由語言模型依上述數字生成，不改寫任何數值。</p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>不推薦名單</h2>
        <span class="tag tag-danger">${excluded.length} 位遭排除，逐筆註明原因</span>
      </div>
      ${exclHtml}
      ${renderInvisibleExclusionNote(excluded)}
    </div>`;

  $$('#candidates-body .js-toggle').forEach((h) => {
    const toggle = () => {
      const open = h.parentElement.classList.toggle('open');
      h.setAttribute('aria-expanded', String(open));
      if (open) {
        // 展開評分卡：構面列交錯進場、長條由 0 長到引擎算出的比例
        const body = h.parentElement.querySelector('.cand-body');
        MOTION.enter(body, '.sc-row, .verdict, .reasons, .sc-total');
        MOTION.bars(body);
      }
    };
    h.addEventListener('click', (ev) => {
      if (ev.target.closest('.js-choose')) return;
      toggle();
    });
    // 評分卡是本平台的核心證據，鍵盤使用者也要打得開
    h.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      if (ev.target.closest('.js-choose')) return;
      ev.preventDefault();
      toggle();
    });
  });
  $$('#candidates-body .js-choose').forEach((b) => {
    b.addEventListener('click', () => chooseCandidate(Number(b.dataset.idx)));
  });
  // 進場動畫：候選與排除名單交錯出現、總分滾動、評分長條由 0 長到定位（數值不變）
  MOTION.enter($('#candidates-body'), '.cand, .excl');
  MOTION.count($$('#candidates-body .cand-head .score-num'));
  MOTION.bars($('#candidates-body'));
  // 第 1 層無解時的階梯引導：一鍵前往第 3 層（畫面 7 韌性模式卡片）
  const gotoRealloc = $('#btn-goto-realloc');
  if (gotoRealloc) gotoRealloc.addEventListener('click', () => {
    logAction('沿決策階梯升級至第 3 層',
      `${state.gap ? `${shortDate(state.gap.date)} ${SHIFT_TYPES[state.gap.shift].name} @ ${UNITS[state.gap.unit]}：` : ''}查無合格替補，前往任務重新分配（韌性模式）`);
    switchScreen('multi');
    const card = $('#btn-realloc-run');
    if (card) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
  });
}

/* ══ 畫面 3：主管確認 ═══════════════════════════════════ */

function renderConfirmPlaceholder() {
  $('#confirm-body').className = 'empty-state';
  $('#confirm-body').textContent = '請先在「替補候選人」頁選定人選。';
}

async function chooseCandidate(idx) {
  // 生命週期鎖：已確認結案的缺班事件不得重新選人，避免重複寫回班表
  if (state.confirmed) {
    alert('本筆缺班事件已確認結案。若要重新評估，請回「缺班事件」頁重新確認條件，建立新的評估。');
    return;
  }
  const chosen = state.result.candidates[idx];
  state.chosen = chosen;
  state.confirmed = false;
  logAction('選定替補人選', `${chosen.staff.id}（排序第 ${chosen.rank} 名，加權總分 ${chosen.score.total}）`);

  const delta = engine.scheduleDelta(state.gap, chosen.staff.id);
  const coverage = engine.unitCoverage(state.gap);
  const [summary, draft] = await Promise.all([
    llmSupervisorSummary(state.result, chosen, delta, coverage),
    llmNotificationDraft(state.gap, chosen),
  ]);

  const others = state.result.candidates.filter((c) => c !== chosen);
  const second = others[0];

  $('#confirm-body').className = '';
  $('#confirm-body').innerHTML = `
    <div class="card">
      <div class="headline">${esc(summary.headline)}</div>
      <div class="facts">${summary.facts.map((f) =>
        `<div class="fact"><span>${esc(f.label)}</span><span>${esc(f.value)}</span></div>`).join('')}</div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>替補後班表變化</h2><span class="tag tag-brand">僅影響缺班當日</span></div>
        <div class="table-scroll"><table>
          <thead><tr><th>人員</th><th>原班表</th><th>替補後</th></tr></thead>
          <tbody>
            ${state.gap.originalStaffId ? `<tr>
              <td><b>${state.gap.originalStaffId}</b></td>
              <td><span class="cell cell-${state.gap.shift}">${SHIFT_TYPES[state.gap.shift].name}</span></td>
              <td><span class="cell cell-L">請假</span></td>
            </tr>` : ''}
            <tr>
              <td><b>${chosen.staff.id}</b></td>
              <td><span class="cell">休假</span></td>
              <td><span class="cell cell-${state.gap.shift}">${SHIFT_TYPES[state.gap.shift].name}</span></td>
            </tr>
          </tbody>
        </table></div>
        <p class="fineprint">當日 ${UNITS[state.gap.unit]} 其他班別不受影響；本平台不重排完整月班表。</p>
      </div>

      <div class="card">
        <div class="card-head"><h2>備援方案</h2></div>
        ${second ? `
          <div class="fact"><span>第二替代方案</span><span>${second.staff.id}（${second.score.total} 分）</span></div>
          <div class="fact"><span>第三順位</span><span>${others[1] ? `${others[1].staff.id}（${others[1].score.total} 分）` : '—'}</span></div>
          <p class="fineprint">若優先人選無法配合，可直接改採第二方案，評分卡與風險標記已一併備妥。</p>
        ` : '<p class="fineprint">無其他合格候選人。</p>'}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>人工確認事項</h2><span class="tag tag-warn">Agent 不代為執行</span></div>
      <ul class="checklist">${summary.checklist.map((c) =>
        `<li><input type="checkbox"> <span>${esc(c)}</span></li>`).join('')}</ul>
    </div>

    <div class="card">
      <div class="card-head"><h2>會後通知草稿</h2><span class="tag tag-danger">草稿，不會自動發送</span></div>
      <div class="draft-box" id="draft-text">${esc(draft)}</div>
      <div class="no-send">系統不具備發送能力，也不會寫入院內正式班表。是否發送、何時發送，由主管自行決定。</div>
      <div class="btn-row">
        <button class="btn" id="btn-copy">複製草稿到剪貼簿</button>
        <button class="btn btn-primary" id="btn-confirm" style="margin-top:0">完成主管確認並留痕</button>
      </div>
    </div>`;

  $('#btn-copy').addEventListener('click', () => {
    copyToClipboard(draft).then((ok) => {
      $('#btn-copy').textContent = ok ? '已複製 ✓' : '複製失敗，請手動選取草稿內容';
      toast(ok ? '通知草稿已複製，發送與否由主管決定' : '複製失敗，請手動選取草稿內容', ok ? 'ok' : 'danger');
      if (ok) logAction('複製通知草稿', '主管手動複製，系統未發送');
    });
  });
  $('#btn-confirm').addEventListener('click', () => {
    if (state.confirmed) return;
    state.confirmed = true;
    $('#btn-confirm').textContent = '已完成確認 ✓';
    $('#btn-confirm').disabled = true;
    // 寫回：班次進入班表、替補次數累計 → 下一次評估會看到新的公平性狀態
    engine.applyReplacement(state.gap, chosen.staff.id);
    logAction('主管確認替補',
      `核定 ${chosen.staff.id} 替補 ${shortDate(state.gap.date)} ${SHIFT_TYPES[state.gap.shift].name}` +
      `${chosen.needsApproval ? '（含需額外核准事項）' : ''}；正式調班登錄由主管於院內系統執行`);
    toast(`已核定 ${chosen.staff.id} 替補，班表與公平性同步更新`);
    renderFairness();
    renderWarnings();
    renderRoster();
    renderQuickPick();     // 替補班次寫回後，快速通報的在班名單同步更新
    renderOverview();      // 寫回後缺口帳即時重算
    renderCapability();    // 帶班組成同步更新

    // 治理迴路的下一步：一鍵開始第二筆缺班，班表與公平性延續累計
    const next = document.createElement('button');
    next.className = 'btn';
    next.id = 'btn-next-gap';
    next.textContent = '處理下一筆缺班 →';
    $('#btn-confirm').parentElement.appendChild(next);
    next.addEventListener('click', startNextGap);

    // 畫面 7 帶入的佇列還有待辦時，提供一鍵繼續（以最新班表重新評估）
    if (state.multiQueue.length > 0) {
      const cont = document.createElement('button');
      cont.className = 'btn btn-primary';
      cont.style.marginTop = '0';
      cont.textContent = `繼續佇列：下一筆缺班（剩 ${state.multiQueue.length} 筆）`;
      $('#btn-confirm').parentElement.appendChild(cont);
      cont.addEventListener('click', startQueuedGap);
    }

    switchScreen('dashboard');
  });

  switchScreen('confirm');
}

/* ══ 畫面 4：公平性與留痕 ═══════════════════════════════ */

/** 主管確認結案後，一鍵重置評估狀態、開始下一筆缺班（班表與公平性延續） */
function startNextGap() {
  state.parsed = null;
  state.gap = null;
  state.result = null;
  state.chosen = null;
  state.confirmed = false;
  state.suggestedId = null;
  state.multiQueue = [];   // 手動開新事件即放棄剩餘佇列，避免殘留過期建議
  $('#parse-result').className = 'empty-state';
  $('#parse-result').textContent = '尚未解析。請貼上新的通報訊息後點左側按鈕。';
  $('#followup-card').hidden = true;
  $('#gap-banner').innerHTML = '';
  $('#candidates-body').className = 'empty-state';
  $('#candidates-body').textContent = '請先在「缺班事件」頁完成解析與確認。';
  $('#recalc-result').innerHTML = '';   // 上一筆事件的重算結果不得殘留到新事件
  $('#qp-result').innerHTML = '';       // 上一輪快速通報的指派結果同樣不得殘留
  renderQuickPick();
  renderConfirmPlaceholder();
  logAction('開始處理下一筆缺班', '評估狀態已重置；已寫回的班表與替補次數延續累計');
  switchScreen('intake');
}

function renderWarnings() {
  const warnings = engine.rosterWarnings();
  const gaps = engine.coverageGaps(WEEK_DATES);

  const levelTag = { high: 'flag-high', medium: 'flag-medium', low: 'flag-low' };
  const levelName = { high: '已違規', medium: '達門檻', low: '接近門檻' };

  const personRows = warnings.map((w) => `
    <div class="excl">
      <div>
        <div class="excl-id">${w.staffId}</div>
        <div class="excl-role"><span class="flag ${levelTag[w.level]}">${levelName[w.level]}</span></div>
      </div>
      <div>
        <div class="excl-reason"><span class="rule-code${w.level === 'high' ? '' : ' neutral'}">${w.code}</span><span>${esc(w.text)}</span></div>
      </div>
    </div>`).join('');

  // 配置缺口依單位彙整；無資料的單位一句話帶過，避免部分名單造成整週誤報
  const byUnit = {};
  const noData = [];
  gaps.forEach((g) => {
    if (g.noData) { noData.push(g.unit); return; }
    (byUnit[g.unit] = byUnit[g.unit] || []).push(g);
  });
  const coverageRows = Object.keys(byUnit).map((unit) => `
    <div class="excl">
      <div><div class="excl-id">${esc(UNITS[unit])}</div></div>
      <div>
        <div class="excl-reason"><span class="rule-code neutral">配置</span>
          <span>本週 ${byUnit[unit].length} 個時段在班人數低於最低配置：
            ${byUnit[unit].slice(0, 6).map((g) => `${shortDate(g.date)} ${SHIFT_TYPES[g.shift].name}`).join('、')}${byUnit[unit].length > 6 ? '…' : ''}${byUnit[unit].length >= 10 ? '（示範資料僅含該單位部分名單）' : ''}</span>
        </div>
      </div>
    </div>`).join('');
  const noDataNote = noData.length
    ? `<p class="fineprint">${noData.map((u) => UNITS[u]).join('、')}本週無排班資料（示範資料為部分名單），不列入配置掃描。</p>` : '';

  const total = warnings.length + Object.keys(byUnit).length;
  $('#warn-count').textContent = total === 0 ? '本週無風險訊號' : `${total} 項風險訊號`;
  $('#warn-count').className = 'tag ' + (warnings.some((w) => w.level === 'high') ? 'tag-danger' : total ? 'tag-warn' : 'tag-ok');

  $('#warnings-body').innerHTML =
    (personRows || '<div class="empty-state">人員工時與公平性皆無風險訊號。</div>') +
    coverageRows + noDataNote;
}

function renderFairness() {
  const max = Math.max(...STAFF.map((s) => s.standbyCount30d), 1);
  const changed = STAFF.filter((s) => s.standbyCount30d > BASELINE_STANDBY[s.id]);

  const counts = STAFF.map((s) => s.standbyCount30d);
  const maxC = Math.max(...counts);
  const minC = Math.min(...counts);
  const avg = (counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1);
  const spread = maxC - minC;
  const summary = `
    <div class="fair-summary">
      <span>平均 <b>${avg}</b> 次</span>
      <span>最高 <b>${maxC}</b> 次 ／ 最低 <b>${minC}</b> 次</span>
      <span>差距 <b class="${spread >= 4 ? 'expired' : ''}">${spread}</b> 次${spread >= 4 ? '（分配不均，建議優先指派低次數人員）' : ''}</span>
    </div>`;

  $('#fairness-chart').innerHTML = summary + STAFF.map((s) => {
    const base = BASELINE_STANDBY[s.id];
    const added = s.standbyCount30d - base;
    return `
      <div class="fair-row">
        <div class="fair-id">${s.id}</div>
        <div class="fair-bar">
          <i style="width:${(base / max) * 100}%"></i>
          ${added ? `<i class="add" style="width:${(added / max) * 100}%"></i>` : ''}
        </div>
        <div class="fair-num">${s.standbyCount30d}${added ? ` <b>(+${added})</b>` : ''} 次</div>
      </div>`;
  }).join('') + (changed.length
    ? `<p class="fineprint">黃色為本次連線期間新增的替補。這些次數已<b>實際寫回資料</b>，
       ${changed.map((s) => `${s.id} 現為 ${s.standbyCount30d} 次`).join('、')}——
       下一筆缺班評估時，他們的 S1 公平性分數會自動下降。</p>`
    : '<p class="fineprint">完成主管確認後，替補次數會寫回資料並反映在下一次評估。</p>');
}

function renderAuditLog() {
  const el = $('#audit-log');
  if (!el) return;
  if (state.audit.length === 0) {
    el.innerHTML = '<div class="empty-state">尚無決策紀錄。</div>';
    return;
  }
  el.innerHTML = state.audit.map((a) => `
    <div class="log-item">
      <div class="log-time">${a.time}　·　${esc(a.actor)}　·　<span class="log-hash" title="鏈式雜湊：本筆內容 + 前一筆雜湊">#${a.hash}</span></div>
      <div class="log-action">${esc(a.action)}</div>
      <div class="log-detail">${esc(a.detail)}</div>
    </div>`).join('');
}

/* ══ 畫面 5：班表與人員 ═════════════════════════════════ */

function rosterDates() {
  return Array.from({ length: 7 }, (_, i) => addDays(state.rosterWeekStart, i));
}

function renderRoster() {
  const ws = state.rosterWeekStart;
  const dates = rosterDates();
  $('#week-label').textContent = ws === WEEK.start
    ? WEEK.label
    : `${shortDate(ws)}（一）– ${shortDate(dates[6])}（日）`;

  const head = `<thead><tr><th>人員</th><th>職務</th>${
    dates.map((d) => `<th class="center">${shortDate(d)}<br>（${weekdayOf(d)}）</th>`).join('')
  }<th class="center">週工時</th></tr></thead>`;

  const gap = state.gap || GAP_EVENT;
  const gapFilled = state.confirmed && state.chosen;

  const body = STAFF.map((s) => {
    const cells = dates.map((d) => {
      if (engine.isOnLeave(s, d)) return '<td class="center"><span class="cell cell-L">假</span></td>';
      if (!gapFilled && gap.originalStaffId === s.id && d === gap.date
          && !SHIFTS.some((x) => x.staffId === s.id && x.date === d)) {
        return '<td class="center"><span class="cell cell-G">缺班</span></td>';
      }
      const sh = SHIFTS.find((x) => x.staffId === s.id && x.date === d);
      const inner = sh
        ? `<span class="cell cell-${sh.shift}">${sh.shift}${sh.isReplacement ? '<sup>替</sup>' : sh.isSwap ? '<sup>換</sup>' : ''}</span>`
        : '<span style="color:var(--ink-faint)">·</span>';
      return `<td class="center td-edit" data-sid="${esc(s.id)}" data-d="${d}" tabindex="0" role="button"` +
        ` aria-label="${esc(s.id)} ${shortDate(d)}（${weekdayOf(d)}）目前${sh ? SHIFT_TYPES[sh.shift].name : '未排班'}，按 Enter 循環編輯"` +
        ` title="點擊編輯：無→白→小夜→大夜→清除">${inner}</td>`;
    }).join('');
    return `<tr><td><b>${esc(s.id)}</b></td><td>${esc(s.role)}</td>${cells}<td class="center">${engine.weeklyHours(s.id, ws)} 小時</td></tr>`;
  }).join('');

  $('#roster-table').innerHTML = head + `<tbody>${body}</tbody>`;
}

/** 格子循環編輯：無 → 白班 → 小夜 → 大夜 → 清除；每次變更留痕並保存 */
function cycleShiftCell(staffId, date) {
  const staff = STAFF.find((s) => s.id === staffId);
  if (!staff || engine.isOnLeave(staff, date)) return;
  const order = [null, 'D', 'E', 'N'];
  const idx = SHIFTS.findIndex((x) => x.staffId === staffId && x.date === date);
  const cur = idx >= 0 ? SHIFTS[idx].shift : null;
  const next = order[(order.indexOf(cur) + 1) % order.length];
  if (idx >= 0) SHIFTS.splice(idx, 1);
  if (next) SHIFTS.push({ staffId, date, shift: next, unit: staff.unit });
  saveSchedule();
  logAction('班表編輯',
    `${staffId} ${shortDate(date)}（${weekdayOf(date)}）：${cur ? SHIFT_TYPES[cur].name : '無'} → ${next ? SHIFT_TYPES[next].name : '清除'}`);
  refreshAfterScheduleChange();
  // 編輯回饋：重繪後彈一下剛改的格子，眼睛不用找
  MOTION.pop($(`#roster-table td[data-sid="${staffId}"][data-d="${date}"] .cell`));
}

/**
 * 從 Excel 貼上匯入目前顯示的週。
 * 每列：人員代號 + 最多七欄班別（週一～週日）。Tab 分隔保留空欄（Excel 直貼），
 * 空白分隔時以 -／休／X 表示休假日。整列有任何錯誤即整列不套用（逐列報告）。
 */
function handleRosterImport() {
  const text = $('#roster-paste').value || '';
  const dates = rosterDates();
  const CODE = { D: 'D', E: 'E', N: 'N' };
  const CJK = { '白': 'D', '小': 'E', '大': 'N', '夜': 'N' };
  const REST = new Set(['', '-', '·', '—', '休', 'X', '0', 'OFF']);

  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
  const entries = [];
  const errors = [];
  const staffIds = new Set();

  lines.forEach((line, li) => {
    const tokens = line.includes('\t')
      ? line.split('\t').map((t) => t.trim())
      : line.trim().split(/[\s,;，、]+/);
    const id = (tokens[0] || '').toUpperCase();
    const staff = STAFF.find((s) => s.id === id);
    if (!staff) {
      // 第一列容錯：像表頭（含日期／星期字樣）就靜默略過
      if (li === 0 && /代號|人員|星期|週|一|\d+\/\d+/.test(line)) return;
      errors.push(`第 ${li + 1} 列：查無人員代號「${tokens[0] || '(空白)'}」`);
      return;
    }
    const rowEntries = [];
    let rowBad = false;
    tokens.slice(1, 8).forEach((cellRaw, i) => {
      const v = (cellRaw || '').trim().toUpperCase();
      if (REST.has(v)) return;
      const code = CODE[v] || CJK[v[0]];
      if (!code) {
        errors.push(`第 ${li + 1} 列「${id}」第 ${i + 1} 天：無法辨識「${cellRaw}」`);
        rowBad = true;
        return;
      }
      rowEntries.push({ staffId: id, date: dates[i], shift: code, unit: staff.unit });
    });
    if (rowBad) return;   // 整列不套用——寧可少排，不套用可疑資料
    staffIds.add(id);
    entries.push(...rowEntries);
  });

  const resultEl = $('#roster-import-result');
  if (staffIds.size === 0) {
    resultEl.innerHTML = `<p class="fineprint" style="color:var(--danger)">未套用任何資料。${
      errors.length ? '問題：' + esc(errors.slice(0, 5).join('；')) : '請確認貼上內容格式。'}</p>`;
    return;
  }

  // 取代列出人員在本週的既有班次
  for (let i = SHIFTS.length - 1; i >= 0; i--) {
    if (staffIds.has(SHIFTS[i].staffId) && dates.includes(SHIFTS[i].date)) SHIFTS.splice(i, 1);
  }
  entries.forEach((e) => SHIFTS.push(e));
  saveSchedule();
  logAction('班表匯入',
    `${shortDate(dates[0])} 週：套用 ${staffIds.size} 人、${entries.length} 班次${
      errors.length ? `；${errors.length} 個項目因格式錯誤整列未套用` : ''}`);
  refreshAfterScheduleChange();

  resultEl.innerHTML = `
    <p class="fineprint">✓ 已套用 ${staffIds.size} 人、${entries.length} 班次（該週原班次已取代）。</p>
    ${errors.length ? `<p class="fineprint" style="color:var(--danger)">未套用的列：${esc(errors.slice(0, 8).join('；'))}${errors.length > 8 ? `…共 ${errors.length} 項` : ''}</p>` : ''}`;
  toast(`班表匯入完成：${staffIds.size} 人、${entries.length} 班次`,
    errors.length ? 'warn' : 'ok');
}

function renderStaffTable() {
  const head = `<thead><tr>
    <th>代號</th><th>職務</th><th>進階</th><th>所屬單位</th><th>資格與效期</th>
    <th>願意支援班別</th><th class="center">近 30 天代班</th><th>狀態</th>
  </tr></thead>`;

  // 效期判定基準：當前評估中事件的日期；尚無事件時以今天計（不再寫死初始示範日）
  const certRefDate = (state.gap && state.gap.date) || formatDate(new Date());

  const body = STAFF.map((s) => {
    const certs = Object.entries(s.certs).map(([k, exp]) => {
      const expired = exp < certRefDate;
      return `<span class="${expired ? 'expired' : ''}">${CERTS[k].replace(/\s.*/, '')}${expired ? `（已於 ${exp} 到期）` : ''}</span>`;
    }).join('、');
    const willing = s.willingShifts === null
      ? '<span style="color:var(--ink-faint)">未表態</span>'
      : s.willingShifts.map((c) => SHIFT_TYPES[c].name).join('、');
    const leave = s.leaves.map((l) => `${esc(l.type)} ${shortDate(l.from)}–${shortDate(l.to)}`).join('；');
    return `<tr>
      <td><b>${esc(s.id)}</b></td><td>${esc(s.role)}</td><td>${lvBadge(s.ladder)}</td><td>${esc(UNITS[s.unit])}</td>
      <td style="white-space:normal">${certs}</td>
      <td>${willing}</td>
      <td class="center">${s.standbyCount30d} 次</td>
      <td style="white-space:normal">${leave ? `<span class="tag tag-warn">${leave}</span>` : '—'}</td>
    </tr>`;
  }).join('');

  $('#staff-table').innerHTML = head + `<tbody>${body}</tbody>`;
}

/* ══ 畫面 7：多筆缺班（逐筆 vs 全局指派）═══════════════ */

function multiGapLabel(g) {
  return `${shortDate(g.date)}（${weekdayOf(g.date)}）${SHIFT_TYPES[g.shift].name} @ ${UNITS[g.unit]}`;
}

function renderMultiScenario() {
  $('#multi-scenario').innerHTML = MULTI_GAP_SCENARIO.map((g, i) => `
    <div class="excl">
      <div><div class="excl-id">缺班 ${i + 1}</div></div>
      <div>
        <div class="excl-reason"><b>${multiGapLabel(g)}</b></div>
        <div class="sc-evi">需求：${g.requiredRole}以上 ＋ ${g.requiredCerts.map((c) => CERTS[c]).join('、')}</div>
        <div class="sc-evi">${esc(g.reason)}</div>
      </div>
    </div>`).join('');
}

function handleMultiRun() {
  const gaps = MULTI_GAP_SCENARIO;
  const greedy = engine.assignGreedy(gaps);
  const joint = engine.assignJointly(gaps);
  const gFilled = greedy.filter((s) => s.staffId).length;

  const row = (label, staffId, score) => `
    <div class="fact">
      <span>${label}</span>
      <span>${staffId
        ? `${staffId}（${score} 分）`
        : '<span class="expired">✗ 無人可指派</span>'}</span>
    </div>`;

  const rescued = gaps.filter((g, i) => !greedy[i].staffId && joint.assignment[i]);

  $('#multi-result').innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <h2>逐筆指派（每筆取當下最高分）</h2>
          <span class="tag ${gFilled < gaps.length ? 'tag-danger' : 'tag-ok'}">填補 ${gFilled}／${gaps.length} 筆</span>
        </div>
        ${greedy.map((s, i) => row(multiGapLabel(gaps[i]), s.staffId, s.score)).join('')}
        ${gFilled < gaps.length ? `<p class="fineprint">第一筆把分數較高的人用掉了——但他是後面缺班唯一具備必要資格的人。逐筆看每一步都「對」，整體卻補不滿。</p>` : ''}
      </div>
      <div class="card${joint.filled > gFilled ? '' : ''}" style="border-color:var(--brand)">
        <div class="card-head">
          <h2>全局指派（所有缺班一起看）</h2>
          <span class="tag ${joint.filled < gaps.length ? 'tag-danger' : 'tag-ok'}">填補 ${joint.filled}／${gaps.length} 筆</span>
        </div>
        ${joint.details.map((d, i) => row(multiGapLabel(gaps[i]), d ? d.staffId : null, d ? d.score : null)).join('')}
        ${joint.filled > gFilled ? `<p class="fineprint">全局指派改讓次高分者補第一筆，把稀缺人力留給只有他能補的缺口——${rescued.map(multiGapLabel).join('、')} 因此補得上。目標順序：先填補筆數、再總分。</p>` : ''}
      </div>
    </div>
    <div class="card">
      <p class="fineprint" style="margin:0 0 ${joint.filled > 0 ? '12px' : '0'}">
        兩種結果皆由確定性引擎計算（枚舉全部可行組合，含同一人接多筆時的班距與工時交互檢查），
        數字可完整重現。指派建議仍需主管於「替補候選人」流程逐筆確認後才會寫回班表。
      </p>
      ${joint.filled > 0 ? `
      <div class="btn-row">
        <button class="btn btn-primary" id="btn-multi-apply" style="margin-top:0">將全局建議帶入主流程，逐筆確認</button>
      </div>
      <p class="fineprint">帶入後仍走完整的候選評估與主管確認；每筆確認寫回後，下一筆會以最新班表重新評估，建議人選以「全局建議」標示。</p>` : ''}
    </div>`;

  const applyBtn = $('#btn-multi-apply');
  if (applyBtn) applyBtn.addEventListener('click', () => startMultiQueue(gaps, joint));
  MOTION.enter($('#multi-result'), '.card');

  logAction('多筆缺班指派比較',
    `${gaps.length} 筆缺班：逐筆指派填補 ${gFilled} 筆，全局指派填補 ${joint.filled} 筆` +
    `（${joint.assignment.map((id, i) => `缺班${i + 1}→${id || '無'}`).join('、')}）`,
    '班守 ShiftGuard 規則引擎');
}

/**
 * 畫面 7 → 主流程：把全局指派建議排成佇列，逐筆走完整的評估與主管確認。
 * 佇列只是「帶路」：每一筆仍以最新班表即時重新評估，主管仍可改選他人；
 * 前一筆的確認寫回可能使後一筆的建議人選失效，此時標示自然消失。
 */
function startMultiQueue(gaps, joint) {
  state.multiQueue = gaps
    .map((g, i) => ({ gap: g, suggestedId: joint.assignment[i] }))
    .filter((q) => q.suggestedId);
  logAction('全局建議帶入主流程',
    `${state.multiQueue.length} 筆缺班將依全局指派建議逐筆確認（${state.multiQueue.map((q) => `${multiGapLabel(q.gap)}→${q.suggestedId}`).join('、')}）`);
  startQueuedGap();
}

function startQueuedGap() {
  const item = state.multiQueue.shift();
  if (!item) return;
  // 佇列缺班補上主流程需要的通報欄位；評估一律用最新班表即時計算
  state.gap = { raisedBy: '多筆缺班情境', raisedAt: nowStamp(), contextNote: '', ...item.gap };
  state.suggestedId = item.suggestedId;
  state.chosen = null;
  state.confirmed = false;
  state.result = engine.evaluateGap(state.gap);
  logAction('執行替補評估（佇列）',
    `${multiGapLabel(state.gap)}：評估 ${STAFF.length} 名人員，合格候選 ${state.result.candidates.length} 名；全局建議人選 ${state.suggestedId}`,
    '班守 ShiftGuard 規則引擎');
  renderCandidates();
  renderConfirmPlaceholder();
  renderRoster();
  renderStaffTable();
  switchScreen('candidates');
}

/* ── 畫面 7 第三層：任務重新分配（韌性模式）── */

function renderReallocScenario() {
  const sc = TASK_REALLOC_SCENARIO;
  $('#realloc-scenario').innerHTML = `
    <div class="excl">
      <div><div class="excl-id">情境</div></div>
      <div>
        <div class="excl-reason"><b>${esc(sc.gapLabel)}｜${esc(sc.absent.id)}（${esc(sc.absent.note)}）無法出勤且查無合格替補</b></div>
        <div class="sc-evi">缺班者任務 ${sc.tasks.length} 項（關鍵 ${sc.tasks.filter((t) => t.critical).length} 項）；
          在班人力 ${sc.onDuty.map((s) => esc(s.id)).join('、')} 共 ${sc.onDuty.length} 位；
          每人最多可多承接 ${sc.maxExtraLoad} 點工作量</div>
      </div>
    </div>`;
}

function handleReallocRun() {
  const sc = TASK_REALLOC_SCENARIO;
  const r = reallocateTasks(sc);

  const REASON = {
    no_qualified: '無人具必要資格',
    over_capacity: '在班人力量能不足',
  };

  const planHtml = r.plan.map((p) => `
    <div class="excl">
      <div>
        <div class="excl-id">${esc(p.staff.id)}</div>
        <div class="excl-role">${esc(p.staff.role)}</div>
      </div>
      <div>
        ${p.tasks.map((t) => `
          <div class="excl-reason">
            <span class="rule-code neutral">${t.critical ? '關鍵' : '一般'}</span>
            <span>${esc(t.name)}（${t.workload} 點${(t.requiredCerts || []).length ? '，需 ' + t.requiredCerts.map((c) => esc(CERTS[c] || c)).join('、') : ''}）</span>
          </div>`).join('') || '<div class="sc-evi">未承接額外任務</div>'}
        <div class="sc-evi">承接負荷 ${p.extraLoad}／${r.maxExtraLoad} 點${p.extraLoad >= r.maxExtraLoad ? '（已達上限，照護風險升高）' : ''}</div>
      </div>
    </div>`).join('');

  const uncoveredHtml = r.uncovered.map((u) => `
    <div class="excl">
      <div><span class="rule-code">缺口</span></div>
      <div>
        <div class="excl-reason"><b class="expired">${esc(u.task.name)}${u.task.critical ? '（關鍵任務）' : ''}</b></div>
        <div class="sc-evi">原因：${REASON[u.reason] || esc(u.reason)}${(u.task.requiredCerts || []).length ? '——需 ' + u.task.requiredCerts.map((c) => esc(CERTS[c] || c)).join('、') : ''}</div>
      </div>
    </div>`).join('');

  $('#realloc-result').innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="card-head">
        <h2>重分配結果</h2>
        <span class="tag ${r.uncovered.length ? 'tag-danger' : 'tag-ok'}">覆蓋 ${r.coveredCount}／${r.totalCount} 項${r.uncoveredCritical ? '，含 ' + r.uncoveredCritical + ' 項關鍵缺口' : ''}</span>
      </div>
      ${planHtml}
      ${r.uncovered.length ? `
        <h4 style="margin:14px 0 4px;font-size:13px;color:var(--ink-faint)">未覆蓋缺口——系統不粉飾，這是需要主管決策的訊號</h4>
        ${uncoveredHtml}
        <h4 style="margin:14px 0 4px;font-size:13px;color:var(--ink-faint)">建議的主管決策選項</h4>
        <ul style="margin:0;padding-left:18px;font-size:13.5px">
          <li>通報護理部調度中心，啟動院級人力調度（缺資格之關鍵任務的正解）</li>
          <li>申請鄰近院區具資格人員跨區支援，並同步加強交班</li>
          <li>評估非緊急任務延後至下一班，並於交班紀錄明確註記</li>
        </ul>` : ''}
      <p class="fineprint">
        分配由確定性引擎計算：資格為硬性條件、負荷上限嚴格遵守、關鍵任務優先；
        系統不自動刪任務、不假裝缺口不存在——第三層的價值是把「降級運作方案」與「殘餘缺口」同時攤開。
      </p>
    </div>`;

  MOTION.enter($('#realloc-result'), '.excl, .fact, .card-head');

  logAction('任務重分配試算（韌性模式）',
    `${sc.gapLabel}：${sc.onDuty.length} 位在班人員承接 ${r.coveredCount}／${r.totalCount} 項任務，` +
    `未覆蓋 ${r.uncovered.length} 項（關鍵 ${r.uncoveredCritical} 項）——由主管決定上報或調度`,
    '班守 ShiftGuard 規則引擎');
}

/* ══ 畫面 8：班表生成（第 0 層：源頭治理）═══════════════ */

function renderGenScenario() {
  const sc = GEN_SCENARIO;
  const pool = STAFF.filter((s) => s.unit === sc.unit);
  const onLeave = pool.filter((s) => s.leaves.some((lv) => lv.to >= sc.dates[0]));
  $('#gen-scenario').innerHTML = `
    <div class="excl">
      <div><div class="excl-id">情境</div></div>
      <div>
        <div class="excl-reason"><b>${esc(UNITS[sc.unit])}｜${esc(sc.label)}</b></div>
        <div class="sc-evi">每日需求：${sc.requirements.map((r) =>
          `${SHIFT_TYPES[r.shift].name}×${r.count}`).join('、')}
          ——共 ${sc.dates.length * sc.requirements.reduce((n, r) => n + r.count, 0)} 格；
          全部班別需 ${sc.requirements[0].requiredCerts.map((c) => esc(CERTS[c])).join('、')} 有效</div>
        <div class="sc-evi">可排人力：本單位 ${pool.length} 名${onLeave.length
          ? `（其中 ${onLeave.map((s) => `${esc(s.id)} ${esc(s.leaves[0].type)}至 ${shortDate(s.leaves[0].to)}`).join('、')}）` : ''}</div>
      </div>
    </div>`;
}

function handleGenRun() {
  const sc = GEN_SCENARIO;
  const r = engine.generateSchedule(sc);
  const pool = STAFF.filter((s) => s.unit === sc.unit);
  const hardName = (code) => {
    const rule = RULE_REGISTRY.hard.find((x) => x.code === code);
    return rule ? rule.name : code;
  };

  // 班表格子：列＝人員、欄＝日期，樣式沿用畫面 5 的班表
  const head = `<thead><tr><th>人員</th><th>職務</th>${
    sc.dates.map((d) => `<th class="center">${shortDate(d)}<br>（${weekdayOf(d)}）</th>`).join('')
  }<th class="center">班數</th><th class="center">工時</th></tr></thead>`;
  const body = pool.map((s) => {
    const stats = r.perStaff.find((p) => p.staffId === s.id);
    const cells = sc.dates.map((d) => {
      const a = r.assignments.find((x) => x.staffId === s.id && x.date === d);
      if (a) return `<td class="center"><span class="cell cell-${a.shift}">${a.shift}</span></td>`;
      if (engine.isOnLeave(s, d)) return '<td class="center"><span class="cell cell-L">假</span></td>';
      return '<td class="center" style="color:var(--ink-faint)">·</td>';
    }).join('');
    return `<tr><td><b>${esc(s.id)}</b></td><td>${esc(s.role)}</td>${cells}
      <td class="center">${stats.total}</td><td class="center">${stats.hours} 小時</td></tr>`;
  }).join('');

  const uncoveredHtml = r.uncovered.map((u) => `
    <div class="excl">
      <div><span class="rule-code">缺格</span></div>
      <div>
        <div class="excl-reason"><b class="expired">${shortDate(u.date)}（${weekdayOf(u.date)}）${SHIFT_TYPES[u.shift].name}</b></div>
        <div class="sc-evi">${u.blockers.map((b) =>
          `${b.code}${esc(hardName(b.code))} 擋下 ${b.count} 人`).join('；')}——需主管決策（跨單位支援、外部調度）</div>
      </div>
    </div>`).join('');

  const v = r.verification;
  const newSoft = v.newMedium.concat(v.newLow);
  const idle = pool.filter((s) => r.perStaff.find((p) => p.staffId === s.id).total === 0);

  $('#gen-result').innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="card-head">
        <h2>生成結果（草稿）</h2>
        <span class="tag ${r.uncovered.length ? 'tag-danger' : 'tag-ok'}">填滿 ${r.filled}／${r.slotCount} 格</span>
      </div>
      <div class="table-scroll"><table>${head}<tbody>${body}</tbody></table></div>
      <div class="legend">
        <span><i class="dot dot-d"></i>白班</span>
        <span><i class="dot dot-e"></i>小夜</span>
        <span><i class="dot dot-n"></i>大夜</span>
        <span><i class="dot dot-l"></i>請假</span>
      </div>
      ${idle.length ? `<p class="fineprint">${idle.map((s) => esc(s.id)).join('、')} 整週未被排入——${
        idle.map((s) => {
          const expired = Object.entries(s.certs).find(([, exp]) => exp < sc.dates[0]);
          return expired ? `${esc(s.id)} 的 ${esc(CERTS[expired[0]].replace(/\s.*/, ''))} 已於 ${expired[1]} 到期（H1，與替補同一份檢查）` : `${esc(s.id)} 受硬性約束限制`;
        }).join('；')}。</p>` : ''}
      ${r.uncovered.length ? `
        <h4 style="margin:14px 0 4px;font-size:13px;color:var(--ink-faint)">排不出的格子——系統不硬塞、不放寬，交主管決策</h4>
        ${uncoveredHtml}` : ''}
    </div>
    <div class="card">
      <div class="card-head">
        <h2>第二道驗證：疊上現有班表重新掃描</h2>
        <span class="tag ${v.newHigh.length ? 'tag-danger' : 'tag-ok'}">新增已違規 ${v.newHigh.length} 條</span>
      </div>
      <div class="fact"><span>把生成班表疊上 8/03–8/09 現有班表，用「主動預警」掃描器（畫面 4 同一套）整表重掃</span>
        <span>${v.newHigh.length === 0 ? '✓ 含跨週邊界，零新增違規' : '✗ 生成器有 bug，請回報'}</span></div>
      <div class="fact"><span>新增「達門檻」提醒</span><span>${v.newMedium.length} 條</span></div>
      <div class="fact"><span>新增「接近門檻」提醒</span><span>${v.newLow.length} 條</span></div>
      ${newSoft.length ? newSoft.map((w) => `
        <div class="sc-evi" style="margin-top:6px">（${w.level === 'medium' ? '達門檻' : '接近門檻'}）${esc(w.staffId)}：${esc(w.text)}</div>`).join('') : ''}
      <div class="fact"><span>班數分佈（公平輪值）</span><span>最多 ${r.spread.max} 班／最少 ${r.spread.min} 班（不計整週不合格者）</span></div>
      <p class="fineprint">
        逐格檢查與整表掃描是<b>兩條獨立的驗證路徑</b>，互相印證。
      </p>
      ${r.filled > 0 ? `
      <div class="btn-row">
        <button class="btn btn-primary" id="btn-gen-apply" style="margin-top:0">套用此草稿至班表（寫入 ${shortDate(sc.dates[0])}–${shortDate(sc.dates[6])} 並前往檢視）</button>
      </div>` : ''}
      <p class="fineprint">
        套用後可在「班表與人員」逐格調整（調整仍受同一套規則與預警檢查）；
        變更保存在本機瀏覽器並留痕。正式發布仍以院內排班系統為準。
      </p>
    </div>`;

  const applyGen = $('#btn-gen-apply');
  if (applyGen) applyGen.addEventListener('click', () => {
    // 覆蓋該單位在生成週的既有班次，寫入草稿
    for (let i = SHIFTS.length - 1; i >= 0; i--) {
      if (sc.dates.includes(SHIFTS[i].date) && SHIFTS[i].unit === sc.unit) SHIFTS.splice(i, 1);
    }
    r.assignments.forEach((a) => SHIFTS.push({ staffId: a.staffId, date: a.date, shift: a.shift, unit: a.unit }));
    saveSchedule();
    logAction('套用生成班表',
      `${UNITS[sc.unit]} ${sc.label}：寫入 ${r.assignments.length} 班次（由第 0 層生成器產出，主管可逐格調整）`);
    state.rosterWeekStart = sc.dates[0];
    refreshAfterScheduleChange();
    switchScreen('roster');
  });

  MOTION.enter($('#gen-result'), '.card');

  logAction('班表生成（第 0 層源頭治理）',
    `${UNITS[sc.unit]} ${sc.label}：填滿 ${r.filled}／${r.slotCount} 格，` +
    `疊上現有班表重掃新增違規 ${v.newHigh.length} 條、達門檻 ${v.newMedium.length} 條；` +
    `班數分佈最多 ${r.spread.max}／最少 ${r.spread.min}`,
    '班守 ShiftGuard 規則引擎');
}

/* ══ 畫面 換：換班簽核預檢 ══════════════════════════════
 * 缺班替補是「失火」，換班簽核才是排班日常的大宗。主管簽核的
 * 每一次互換都在賭：換完之後班距夠不夠、會不會連上七天、四週
 * 總量爆了沒有。這個畫面把互換後兩人各自的 H1–H9 交給引擎重算
 * ——規則把關，核准與否仍由主管決定。 */

function renderSwapPicker() {
  if (!$('#swap-a-staff')) return;
  ['a', 'b'].forEach((side, i) => {
    const sel = $(`#swap-${side}-staff`);
    const cur = sel.value || (STAFF[i] || STAFF[0]).id;
    sel.innerHTML = STAFF.map((s) =>
      `<option value="${s.id}"${s.id === cur ? ' selected' : ''}>${s.id}　${s.role}　${UNITS[s.unit]}</option>`).join('');
    renderSwapShifts(side);
  });
}

function renderSwapShifts(side) {
  const sid = $(`#swap-${side}-staff`).value;
  const picked = state.swap[side];
  // 換人或班表變動後，點選中的班次可能已失效——自動清掉，不留幽靈選擇
  if (picked && (picked.staffId !== sid
      || !SHIFTS.some((s) => s.staffId === sid && s.date === picked.date && s.shift === picked.shift))) {
    state.swap[side] = null;
  }
  const me = STAFF.find((x) => x.id === sid) || {};
  const rows = SHIFTS.filter((s) => s.staffId === sid)
    .slice().sort((a, b) => (a.date + a.shift < b.date + b.shift ? -1 : 1));
  $(`#swap-${side}-shifts`).innerHTML = rows.length ? rows.map((s) => {
    const on = state.swap[side] && state.swap[side].date === s.date && state.swap[side].shift === s.shift;
    return `<button class="chip${on ? ' active' : ''}" data-side="${side}" data-sid="${esc(sid)}"` +
      ` data-d="${s.date}" data-sh="${s.shift}" aria-pressed="${!!on}">` +
      `${shortDate(s.date)}（${weekdayOf(s.date)}）${SHIFT_TYPES[s.shift].name}` +
      `${s.unit !== me.unit ? ` @${esc(s.unit)}` : ''}</button>`;
  }).join('') : '<span class="qp-col-empty">此人員目前班表上沒有班次</span>';
}

const swapLabel = (q) => `${shortDate(q.date)}（${weekdayOf(q.date)}）${SHIFT_TYPES[q.shift].name}`;

function handleSwapCheck() {
  const { a, b } = state.swap;
  const out = $('#swap-result');
  if (!a || !b) { alert('請在甲、乙兩側各點選一個班次。'); return; }
  const requiredCerts = $$('#swap-certs .swap-cert').filter((c) => c.checked).map((c) => c.value);
  if (!requiredCerts.length) { alert('請至少勾選一項必要資格。'); return; }
  const r = engine.analyzeSwap(a, b, { requiredCerts, requiredRole: $('#swap-role').value });
  if (r.error) {
    out.innerHTML = `<p class="fineprint" style="color:var(--danger)">${esc(r.error)}</p>`;
    return;
  }

  const panel = (take) => `
    <div class="card" style="border-color:${take.violations.length ? 'var(--danger)' : 'var(--ok)'};margin-top:0">
      <div class="card-head">
        <h2>${esc(take.staff.id)} 承接 ${swapLabel(take.slot)} @ ${esc(UNITS[take.slot.unit] || take.slot.unit)}</h2>
        <span class="tag ${take.violations.length ? 'tag-danger' : 'tag-ok'}">${take.violations.length ? `✗ ${take.violations.length} 項違規` : '✓ 通過'}</span>
      </div>
      ${take.violations.map((v) => `
        <div class="excl-reason"><span class="rule-code${v.neutral ? ' neutral' : ''}">${v.code}</span><span>${esc(v.detail)}</span></div>`).join('')
    || '<p class="fineprint" style="margin:0">班距、連續天數、週工時、四週彈性工時、資格效期全部通過。</p>'}
    </div>`;

  out.innerHTML = `
    <div class="grid-2" style="margin-top:14px">${panel(r.aTake)}${panel(r.bTake)}</div>
    ${r.notices.length ? `<p class="fineprint">${r.notices.map(esc).join('；<br>')}</p>` : ''}
    <div class="btn-row">
      ${r.ok
    ? '<button class="btn btn-primary" id="btn-swap-approve" style="margin-top:0">核准互換並寫回班表</button>'
    : '<span class="tag tag-danger">存在硬性違規，不可核准——請同仁改談其他班次；門檻依據可於規則庫檢視</span>'}
    </div>`;

  logAction('換班互換預檢',
    `${a.staffId} ${swapLabel(a)} ⇄ ${b.staffId} ${swapLabel(b)}；必要資格 ${requiredCerts.join('、')}：` +
    (r.ok ? '雙向皆通過硬性約束'
      : [r.aTake, r.bTake].filter((t) => t.violations.length)
        .map((t) => `${t.staff.id} 違反 ${t.violations.map((v) => v.code).join('、')}`).join('；')),
    '班守 ShiftGuard 規則引擎');

  const approve = $('#btn-swap-approve');
  if (approve) approve.addEventListener('click', () => {
    // 預檢與核准之間班表可能被動過（另一視窗、匯入）——寫回前引擎再驗一次存在性
    if (!engine.applySwap(a, b)) {
      toast('寫回失敗：班次已變動，請重新執行預檢', 'danger');
      return;
    }
    saveSchedule();
    logAction('核准換班寫回',
      `${a.staffId} ${swapLabel(a)} ⇄ ${b.staffId} ${swapLabel(b)}；正式調班登錄由主管於院內系統執行`);
    toast(`已核准 ${a.staffId} ⇄ ${b.staffId} 互換，班表已更新`);
    state.swap.a = null;
    state.swap.b = null;
    out.innerHTML = '<p class="fineprint" style="color:var(--ok)">✓ 互換已寫回班表並留痕；班表工作區、缺口總覽與預警已同步重算。</p>';
    refreshAfterScheduleChange();
    renderStaffTable();
  });
  MOTION.enter(out, '.card, .btn-row, .fineprint');
}

/* ══ 畫面 6：規則庫 ═════════════════════════════════════ */

/**
 * 權重總和不等於 100 時提醒主管：排序仍然有效（分數以總和為滿分等比呈現），
 * 但「94／100」與「94／85」的溝通意義不同，主管應是有意為之而非沒注意到。
 */
function updateWeightSum() {
  const sum = totalSoftWeight();
  $('#weight-sum').textContent = sum;
  const tag = $('#weight-sum-tag');
  const note = $('#weight-sum-note');
  if (!tag || !note) return;
  tag.className = 'tag ' + (sum === 100 ? 'tag-neutral' : 'tag-warn');
  note.textContent = sum === 100 ? '' : '（非 100：評分將以此總和為滿分，排序仍有效）';
}

function renderRules() {
  $('#hard-rules').innerHTML = RULE_REGISTRY.hard.map((r) => `
    <div class="rule">
      <div><span class="rule-code">${r.code}</span></div>
      <div>
        <div class="rule-name">${esc(r.name)}</div>
        <div class="rule-desc">${esc(r.desc)}</div>
        <div class="rule-basis">依據：${esc(r.basis)}</div>
      </div>
      <div class="rule-ctrl">
        ${r.param ? `<label>${esc(r.param.label)}
          <input type="number" data-hard="${r.code}" value="${r.param.value}" min="0" step="1"> ${r.param.unit}</label>` : ''}
        <label><input type="checkbox" data-hard-enable="${r.code}" ${r.enabled ? 'checked' : ''}> 啟用</label>
      </div>
    </div>`).join('');

  $('#soft-rules').innerHTML = RULE_REGISTRY.soft.map((r) => `
    <div class="weight-row">
      <div class="weight-top">
        <span class="rule-code neutral">${r.code}</span>
        <span class="rule-name">${esc(r.name)}</span>
        <span class="weight-val" id="wv-${r.code}">${r.weight}</span>
      </div>
      <div class="rule-desc">${esc(r.desc)}</div>
      <div class="weight-why">為什麼要有這條：${esc(r.rationale)}</div>
      <input type="range" min="0" max="50" step="5" value="${r.weight}" data-soft="${r.code}">
      ${r.param ? `<div class="rule-ctrl" style="margin-top:6px"><label>${esc(r.param.label)}
        <input type="number" data-soft-param="${r.code}" value="${r.param.value}" min="1" step="1"> ${r.param.unit}</label></div>` : ''}
    </div>`).join('');

  updateWeightSum();

  $$('[data-soft]').forEach((el) => {
    el.addEventListener('input', () => {
      const rule = RULE_REGISTRY.soft.find((r) => r.code === el.dataset.soft);
      rule.weight = Number(el.value);
      $(`#wv-${rule.code}`).textContent = rule.weight;
      updateWeightSum();
      saveRules();
    });
  });
  $$('[data-soft-param]').forEach((el) => {
    el.addEventListener('change', () => {
      RULE_REGISTRY.soft.find((r) => r.code === el.dataset.softParam).param.value = Number(el.value);
      saveRules();
    });
  });
  $$('[data-hard]').forEach((el) => {
    el.addEventListener('change', () => {
      getHardRule(el.dataset.hard).param.value = Number(el.value);
      saveRules();
    });
  });
  $$('[data-hard-enable]').forEach((el) => {
    el.addEventListener('change', () => {
      getHardRule(el.dataset.hardEnable).enabled = el.checked;
      saveRules();
    });
  });
}

function handleRecalc() {
  if (!state.gap) {
    $('#recalc-result').innerHTML =
      '<div class="recalc-out">請先在「缺班事件」頁完成解析與確認，再回來調整規則。</div>';
    return;
  }
  // 生命週期鎖：已結案的事件不重算——替補班次已寫回班表，重算會把剛指派的人
  // 因 H2 排除，出現「已補完卻顯示缺口」的矛盾畫面。規則調整仍已生效，
  // 會套用在下一筆缺班評估。
  if (state.confirmed) {
    $('#recalc-result').innerHTML =
      '<div class="recalc-out"><b>本筆缺班事件已確認結案，不再重算。</b>' +
      '規則調整已儲存，將套用於下一筆缺班評估；' +
      '若要重新評估，請回「缺班事件」頁重新確認條件，建立新的評估。</div>';
    logAction('調整規則庫（事件已結案，未重算）',
      `軟性權重 ${RULE_REGISTRY.soft.map((r) => `${r.code}=${r.weight}`).join('、')}`,
      '護理部 排班規則管理員');
    return;
  }
  const before = state.result.candidates.map((c) => c.staff.id);
  state.result = engine.evaluateGap(state.gap);
  const after = state.result.candidates.map((c) => c.staff.id);

  $('#recalc-result').innerHTML = `
    <div class="recalc-out">
      <b>已套用新規則並重新計算。</b>
      合格候選 ${after.length} 位、排除 ${state.result.excluded.length} 位。
      <ol>${state.result.candidates.map((c, i) => {
        const moved = before[i] !== c.staff.id;
        return `<li${moved ? ' class="moved"' : ''}>${c.staff.id} — ${c.score.total} / ${c.score.maxTotal} 分${moved ? '（順位變動）' : ''}</li>`;
      }).join('')}</ol>
      <div style="margin-top:8px">調整前順位：${before.join(' → ')}</div>
    </div>`;

  logAction('調整規則庫並重算',
    `軟性權重 ${RULE_REGISTRY.soft.map((r) => `${r.code}=${r.weight}`).join('、')}；排序 ${before.join('>')} → ${after.join('>')}`,
    '護理部 排班規則管理員');
  toast(before.join() === after.join() ? '規則已套用重算，排序不變' : '規則已套用重算，排序已變動', 'ok');

  state.chosen = null;
  state.confirmed = false;
  renderConfirmPlaceholder();
  renderCandidates();
  renderFairness();
  renderWarnings();
  renderRoster();
  renderOverview();   // 門檻改變會影響缺口與吸收模擬
}

/* ══ 畫面 9：FHIR 介接 ═════════════════════════════════ */

/** FHIR 轉換使用與引擎同一份注入資料（同一份參照，寫回即時反映） */
function fhirDb() {
  return { staff: STAFF, shifts: SHIFTS, units: UNITS, shiftTypes: SHIFT_TYPES, certs: CERTS, ladderLevels: LADDER_LEVELS };
}

let fhirPendingImport = null;   // 「解析並驗證」通過、待主管按「套用」的班次

function renderFhirStats() {
  const el = $('#fhir-export-stats');
  if (!el) return;
  const stats = fhirBundleStats(fhirExportBundle(fhirDb()));
  el.textContent = Object.entries(stats).map(([t, n]) => `${t}×${n}`).join('　');
}

async function handleFhirPush() {
  const out = $('#fhir-push-result');
  const base = ($('#fhir-endpoint').value || '').trim().replace(/\/+$/, '');
  // 端點白名單：僅 https（本機測試放行 http://localhost）——班表不走明文外網
  if (!/^https:\/\/.+/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(base)) {
    out.innerHTML = '<p class="fineprint" style="color:var(--danger)">請填 https:// 開頭的 FHIR Base URL（本機測試允許 http://localhost）。</p>';
    return;
  }
  const btn = $('#btn-fhir-push');
  btn.disabled = true;
  btn.textContent = '推送中…';
  const bundle = fhirExportBundle(fhirDb(), { mode: 'batch', timestamp: new Date().toISOString() });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(bundle),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.resourceType === 'Bundle' && Array.isArray(body.entry)) {
        const codes = body.entry.map((e) => (e.response && e.response.status) || '?');
        detail += `；${codes.filter((c) => /^2/.test(c)).length}／${codes.length} 筆資源成功`;
      } else if (body.resourceType === 'OperationOutcome') {
        detail += `；OperationOutcome：${(body.issue || []).map((i) => i.diagnostics || i.code).slice(0, 3).join('；')}`;
      }
    } catch (e) { /* 非 JSON 回應，僅顯示狀態碼 */ }
    out.innerHTML = `<p class="fineprint" style="color:${res.ok ? 'var(--ok)' : 'var(--danger)'}">${res.ok ? '✓ 已送出' : '✗ 伺服器回應異常'}——${esc(detail)}</p>`;
    logAction('推送 FHIR Bundle', `batch → ${base}：${detail}`);
    toast(res.ok ? `FHIR 推送成功（${detail}）` : `FHIR 推送異常：${detail}`, res.ok ? 'ok' : 'danger');
  } catch (err) {
    const why = err && err.name === 'AbortError' ? '逾時（20 秒）' : String((err && err.message) || err);
    out.innerHTML = `<p class="fineprint" style="color:var(--danger)">✗ 推送失敗：${esc(why)}——請確認網址、CORS 設定與伺服器狀態。</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '推送 batch Bundle';
  }
}

function handleFhirImport() {
  const out = $('#fhir-import-result');
  fhirPendingImport = null;
  let bundle;
  try {
    bundle = JSON.parse($('#fhir-import-text').value);
  } catch (e) {
    out.innerHTML = '<p class="fineprint" style="color:var(--danger)">✗ 不是有效的 JSON，請確認貼上內容完整。</p>';
    return;
  }
  const r = fhirImportBundle(bundle, fhirDb());
  const list = r.shifts.slice(0, 10).map((s) => `
    <div class="fact">
      <span><b>${esc(s.staffId)}</b>　${shortDate(s.date)}（${weekdayOf(s.date)}）</span>
      <span>${SHIFT_TYPES[s.shift].name} @ ${esc(UNITS[s.unit])}</span>
    </div>`).join('');
  const errs = r.errors.slice(0, 8).map((x) => `<div class="sc-evi expired">${esc(x)}</div>`).join('');
  out.innerHTML = `
    <p class="fineprint">Slot 共 ${r.counts.slots} 筆：<b style="color:var(--ok)">${r.counts.imported} 筆通過白名單驗證</b>${r.counts.rejected ? `、<b style="color:var(--danger)">${r.counts.rejected} 筆拒絕</b>` : ''}。</p>
    ${list}${r.shifts.length > 10 ? `<p class="fineprint">…其餘 ${r.shifts.length - 10} 筆略。</p>` : ''}
    ${errs}${r.errors.length > 8 ? `<p class="fineprint">…其餘 ${r.errors.length - 8} 項錯誤略。</p>` : ''}
    ${r.shifts.length ? `<div class="btn-row"><button class="btn btn-primary" id="btn-fhir-apply" style="margin-top:0">套用 ${r.shifts.length} 班次到班表（取代涵蓋的人員×日期）</button></div>` : ''}`;
  if (r.shifts.length) {
    fhirPendingImport = r.shifts;
    $('#btn-fhir-apply').addEventListener('click', applyFhirImport);
  }
  logAction('FHIR Bundle 解析', `Slot ${r.counts.slots} 筆：通過 ${r.counts.imported}、拒絕 ${r.counts.rejected}${r.errors.length ? `（首項原因：${r.errors[0]}）` : ''}`);
}

function applyFhirImport() {
  if (!fhirPendingImport) return;
  const pairs = new Set(fhirPendingImport.map((s) => `${s.staffId}|${s.date}`));
  for (let i = SHIFTS.length - 1; i >= 0; i--) {
    if (pairs.has(`${SHIFTS[i].staffId}|${SHIFTS[i].date}`)) SHIFTS.splice(i, 1);
  }
  fhirPendingImport.forEach((s) => SHIFTS.push({ staffId: s.staffId, date: s.date, shift: s.shift, unit: s.unit }));
  const n = fhirPendingImport.length;
  fhirPendingImport = null;
  saveSchedule();
  logAction('FHIR Bundle 匯入套用', `寫入 ${n} 班次（涵蓋的人員×日期原班次已取代），經白名單驗證`);
  refreshAfterScheduleChange();
  renderStaffTable();
  $('#fhir-import-result').innerHTML =
    '<p class="fineprint" style="color:var(--ok)">✓ 已套用；可到「排班系統 → 班表工作區」檢視，變更已保存並留痕。</p>';
}

function initFhir() {
  const pre = $('#fhir-preview');

  $('#btn-fhir-download').addEventListener('click', () => {
    const bundle = fhirExportBundle(fhirDb(), { timestamp: new Date().toISOString() });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/fhir+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shiftguard-fhir-bundle-${nowStamp().replace(/[: ]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    logAction('匯出 FHIR Bundle', `collection：${Object.entries(fhirBundleStats(bundle)).map(([t, n]) => `${t}×${n}`).join('、')}`);
    toast('FHIR Bundle 已下載（collection）');
  });

  $('#btn-fhir-preview').addEventListener('click', () => {
    if (!pre.hidden) {
      pre.hidden = true;
      $('#btn-fhir-preview').textContent = '預覽 JSON';
      return;
    }
    const bundle = fhirExportBundle(fhirDb(), { timestamp: new Date().toISOString() });
    pre.textContent = JSON.stringify(bundle, null, 2);   // textContent：JSON 不進 HTML 解析器
    pre.hidden = false;
    $('#btn-fhir-preview').textContent = '收合預覽';
  });

  $('#btn-fhir-copy').addEventListener('click', () => {
    const bundle = fhirExportBundle(fhirDb(), { timestamp: new Date().toISOString() });
    copyToClipboard(JSON.stringify(bundle, null, 2)).then((ok) => {
      $('#btn-fhir-copy').textContent = ok ? '已複製 ✓' : '複製失敗';
      toast(ok ? 'FHIR Bundle JSON 已複製' : '複製失敗，請改用下載或預覽', ok ? 'ok' : 'danger');
      setTimeout(() => { $('#btn-fhir-copy').textContent = '複製到剪貼簿'; }, 1600);
    });
  });

  $('#btn-fhir-push').addEventListener('click', handleFhirPush);
  $('#btn-fhir-import').addEventListener('click', handleFhirImport);
}

/* ══ 啟動 ═══════════════════════════════════════════════ */

/**
 * DEMO DAY 保險：任何未攔截的錯誤都要看得見。
 * 沒有這層，畫面會停在原地而台上不知道發生了什麼事。
 */
function installErrorSurface() {
  const show = (msg) => {
    let bar = $('#error-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'error-bar';
      bar.className = 'error-bar';
      document.body.appendChild(bar);
    }
    bar.textContent = `發生錯誤，請重新整理頁面：${msg}`;
    bar.hidden = false;
  };
  window.addEventListener('error', (e) => show(e.message));
  window.addEventListener('unhandledrejection', (e) => show(e.reason && e.reason.message ? e.reason.message : String(e.reason)));
}

function init() {
  installErrorSurface();
  $('#llm-mode-badge').textContent = `LLM 模式：${LLM.modeLabel}`;
  $('#raw-message').value = RAW_MESSAGE;

  const rulesLoad = loadRules();
  if (rulesLoad) {
    logAction('載入本機保存的規則設定',
      `軟性權重 ${RULE_REGISTRY.soft.map((r) => `${r.code}=${r.weight}`).join('、')}（可按「還原預設規則」清除）`,
      '班守 ShiftGuard');
    if (rulesLoad.adjusted > 0) {
      logAction('⚠ 安全警示：規則載入異常',
        `${rulesLoad.adjusted} 項儲存值超出合法範圍、已強制夾限——本機儲存可能遭改動，請確認規則庫設定或按「還原預設規則」`,
        '班守 ShiftGuard 防護');
    }
  }
  const schedLoad = loadSchedule();
  if (schedLoad) {
    const badge = $('#roster-modified');
    if (badge) badge.hidden = false;
    logAction('載入本機保存的班表',
      `共 ${SHIFTS.length} 班次（排班工作區的變更；可按「還原示範班表」清除）`,
      '班守 ShiftGuard');
    if (schedLoad.dropped > 0) {
      logAction('⚠ 安全警示：班表載入異常',
        `${schedLoad.dropped} 筆不合法班次已剔除（代號／日期／班別／單位未通過白名單）——本機儲存可能遭改動，請核對班表或按「還原示範班表」`,
        '班守 ShiftGuard 防護');
    }
  }
  $('#btn-rules-reset').addEventListener('click', () => {
    if (confirm('確定要清除本機保存的規則調整，回到預設值嗎？頁面將重新載入。')) resetRules();
  });

  // 留痕匯出：勞檢或內部稽核時，決策依據要拿得出來
  $('#btn-export-audit').addEventListener('click', () => {
    const payload = {
      platform: '班守 ShiftGuard（DEMO）',
      exportedAt: nowStamp(),
      note: '本檔為前端演示版之決策留痕匯出。留痕採雜湊鏈結（每筆含前筆雜湊），修改任一筆即斷鏈；正式導入時由後端 append-only 儲存。',
      chainValid: verifyAuditChain(),
      rules: {
        hard: RULE_REGISTRY.hard.map((r) => ({ code: r.code, name: r.name, enabled: r.enabled, param: r.param ? r.param.value : null })),
        soft: RULE_REGISTRY.soft.map((r) => ({ code: r.code, name: r.name, weight: r.weight, param: r.param ? r.param.value : null })),
      },
      audit: state.audit,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shiftguard-audit-${nowStamp().replace(/[: ]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    logAction('匯出決策留痕', `共 ${state.audit.length} 筆紀錄，含當前規則設定快照`);
    toast(`決策留痕已匯出（${state.audit.length} 筆，含規則快照）`);
  });

  STAFF.forEach((s) => { BASELINE_STANDBY[s.id] = s.standbyCount30d; });
  $('#ans-reporter').innerHTML = '<option value="">（訊息未識別通報人員）</option>' +
    STAFF.map((s) => `<option value="${s.id}"${s.id === GAP_EVENT.originalStaffId ? ' selected' : ''}>` +
      `${s.id}　${s.role}　${UNITS[s.unit]}</option>`).join('');

  // 兩層導覽：事件委派（導覽列每次切換都重繪，委派在容器上不掉監聽）
  $('#nav').addEventListener('click', (ev) => {
    const gp = ev.target.closest('.np');
    if (gp) {
      const g = NAV_GROUPS.find((x) => x.key === gp.dataset.group);
      if (g) switchScreen(g.screens[0][0]);
      return;
    }
    const t = ev.target.closest('.tab');
    if (t) switchScreen(t.dataset.screen);
  });
  initPortal();
  initFhir();
  // 支援 #hash 直達（home.html 的「排班系統／替班系統」按鈕、書籤、返回鍵）
  window.addEventListener('hashchange', () => {
    const name = screenFromHash();
    const cur = document.querySelector('.screen.active');
    if (!cur || cur.id !== `screen-${name}`) switchScreen(name);
  });
  $('#btn-parse').addEventListener('click', handleParse);

  // 範例訊息一鍵帶入並解析
  $('#sample-chips').innerHTML = SAMPLE_MESSAGES.map((m, i) =>
    `<button class="chip" data-sample="${i}">${esc(m.label)}</button>`).join('');
  $$('#sample-chips .chip').forEach((b) => b.addEventListener('click', () => {
    $('#raw-message').value = SAMPLE_MESSAGES[Number(b.dataset.sample)].text;
    handleParse();
  }));

  // 從 LINE 貼上訊息即自動解析（貼上內容於事件後才進入 value，延後一拍）
  $('#raw-message').addEventListener('paste', () => setTimeout(handleParse, 0));
  $('#btn-evaluate').addEventListener('click', handleEvaluate);

  // 快速通報：週切換、日期與人員點選、清單編輯、執行（事件委派，重繪不掉監聽）
  $('#qp-week-prev').addEventListener('click', () => {
    state.qpWeekStart = addDays(state.qpWeekStart, -7);
    state.qpDay = addDays(state.qpDay, -7);
    renderQuickPick();
  });
  $('#qp-week-next').addEventListener('click', () => {
    state.qpWeekStart = addDays(state.qpWeekStart, 7);
    state.qpDay = addDays(state.qpDay, 7);
    renderQuickPick();
  });
  $('#qp-days').addEventListener('click', (ev) => {
    const c = ev.target.closest('.chip');
    if (!c) return;
    state.qpDay = c.dataset.day;
    renderQuickPick();
    MOTION.enter($('#qp-board'), '.qp-person');
  });
  $('#qp-board').addEventListener('click', (ev) => {
    const p = ev.target.closest('.qp-person');
    if (p) qpTogglePerson(p);
  });
  $('#qp-selected').addEventListener('change', (ev) => {
    const rowEl = ev.target.closest('.qp-sel-row');
    if (!rowEl) return;
    const sel = state.quickSel.get(rowEl.dataset.key);
    if (!sel) return;
    if (ev.target.classList.contains('qp-cert')) {
      sel.certs = Array.from(rowEl.querySelectorAll('.qp-cert'))
        .filter((c) => c.checked).map((c) => c.value);
    }
    if (ev.target.classList.contains('qp-role')) sel.role = ev.target.value;
  });
  $('#qp-selected').addEventListener('click', (ev) => {
    const rm = ev.target.closest('.qp-remove');
    if (!rm) return;
    state.quickSel.delete(rm.closest('.qp-sel-row').dataset.key);
    $('#qp-result').innerHTML = '';
    renderQuickPick();
  });
  $('#btn-qp-run').addEventListener('click', handleQuickRun);

  // 換班簽核：人員切換、班次點選（事件委派）、預檢執行
  $('#swap-certs').innerHTML = Object.entries(CERTS).map(([k, nm]) =>
    `<label><input type="checkbox" class="swap-cert" value="${k}"${k === 'ACLS' ? ' checked' : ''}> ${esc(nm)}</label>`).join('');
  ['a', 'b'].forEach((side) => {
    $(`#swap-${side}-staff`).addEventListener('change', () => {
      $('#swap-result').innerHTML = '';
      renderSwapShifts(side);
    });
    $(`#swap-${side}-shifts`).addEventListener('click', (ev) => {
      const c = ev.target.closest('.chip');
      if (!c) return;
      const cur = state.swap[side];
      state.swap[side] = (cur && cur.date === c.dataset.d && cur.shift === c.dataset.sh)
        ? null   // 點同一顆＝取消選擇
        : { staffId: c.dataset.sid, date: c.dataset.d, shift: c.dataset.sh };
      $('#swap-result').innerHTML = '';
      renderSwapShifts(side);
      MOTION.pop($(`#swap-${side}-shifts .chip.active`));
    });
  });
  $('#btn-swap-check').addEventListener('click', handleSwapCheck);

  // 今日戰情：基準日切換
  $('#btn-today-prev').addEventListener('click', () => {
    state.todayDate = addDays(state.todayDate, -1); renderToday();
  });
  $('#btn-today-next').addEventListener('click', () => {
    state.todayDate = addDays(state.todayDate, 1); renderToday();
  });
  $('#btn-today-demo').addEventListener('click', () => {
    state.todayDate = DEMO_TODAY; renderToday();
  });
  $('#btn-recalc').addEventListener('click', handleRecalc);
  $('#btn-multi-run').addEventListener('click', handleMultiRun);
  $('#btn-realloc-run').addEventListener('click', handleReallocRun);
  $('#btn-gen-run').addEventListener('click', handleGenRun);

  // 排班工作區：週切換、格子編輯（事件委派，表格重繪不掉監聽）、匯入、還原
  $('#btn-week-prev').addEventListener('click', () => {
    state.rosterWeekStart = addDays(state.rosterWeekStart, -7); renderRoster();
  });
  $('#btn-week-next').addEventListener('click', () => {
    state.rosterWeekStart = addDays(state.rosterWeekStart, 7); renderRoster();
  });
  $('#btn-week-demo').addEventListener('click', () => {
    state.rosterWeekStart = WEEK.start; renderRoster();
  });
  $('#roster-table').addEventListener('click', (ev) => {
    const td = ev.target.closest('td.td-edit');
    if (td) cycleShiftCell(td.dataset.sid, td.dataset.d);
  });
  // 鍵盤編輯班表：Enter／空白鍵循環班別；表格重繪後把焦點放回同一格，連續編輯不中斷
  $('#roster-table').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const td = ev.target.closest('td.td-edit');
    if (!td) return;
    ev.preventDefault();
    const { sid, d } = td.dataset;
    cycleShiftCell(sid, d);
    const again = $(`#roster-table td[data-sid="${sid}"][data-d="${d}"]`);
    if (again) again.focus();
  });
  $('#btn-roster-import').addEventListener('click', handleRosterImport);
  $('#btn-roster-reset').addEventListener('click', () => {
    if (confirm('確定要清除本機保存的班表變更，回到示範資料嗎？頁面將重新載入。')) resetSchedule();
  });

  // 跨視窗即時同步：另一個分頁改了班表／規則，本頁立即重算（瀏覽器原生 storage 事件，零後端）
  window.addEventListener('storage', (ev) => {
    if (ev.key === SCHEDULE_STORE_KEY) {
      if (ev.newValue === null) {
        logAction('另一視窗還原了示範班表', '請重新整理本頁以載入出廠資料', '班守 ShiftGuard');
        return;
      }
      if (loadSchedule()) {
        const badge = $('#roster-modified');
        if (badge) badge.hidden = false;
        refreshAfterScheduleChange();
        renderStaffTable();
        renderFairness();
        logAction('跨視窗即時同步', '偵測到另一視窗的班表變更，缺口與儀表板已重算', '班守 ShiftGuard');
      }
      return;
    }
    if (ev.key === RULES_STORE_KEY && ev.newValue !== null) {
      if (loadRules()) {
        renderRules();
        updateWeightSum();
        refreshAfterScheduleChange();
        logAction('跨視窗即時同步', '偵測到另一視窗的規則調整，決策結果已重算', '班守 ShiftGuard');
      }
    }
  });

  // 靜態按鈕的圖示注入：HTML 只標 data-ico，圖示唯一來源是 ICONS（改一處全站生效）
  $$('[data-ico]').forEach((el) => el.insertAdjacentHTML('afterbegin', icon(el.dataset.ico)));

  renderRoster();
  renderQuickPick();
  renderSwapPicker();
  renderToday();
  renderStaffTable();
  renderRules();
  renderFairness();
  renderWarnings();
  renderAuditLog();
  renderMultiScenario();
  renderReallocScenario();
  renderGenScenario();
  renderOverview();
  renderCapability();
  renderPortalStatus();
  renderFhirStats();
  switchScreen(screenFromHash());
}

document.addEventListener('DOMContentLoaded', init);
