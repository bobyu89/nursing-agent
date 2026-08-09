/**
 * app.js — 畫面渲染與流程控制
 *
 * 七個畫面：缺班事件 → 替補候選人 → 主管確認 → 公平性與留痕 → 班表與人員 → 規則庫 → 多筆缺班
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
  certs: CERTS,
  units: UNITS,
  registry: RULE_REGISTRY,
  staffingMin: UNIT_MIN_STAFF,
});

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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
    if (!raw) return false;
    const saved = JSON.parse(raw);
    (saved.hard || []).forEach((s) => {
      const r = getHardRule(s.code);
      if (!r) return;
      if (typeof s.enabled === 'boolean') r.enabled = s.enabled;
      if (r.param && Number.isFinite(s.param)) {
        r.param.value = clampTo(s.param, PARAM_RANGE[r.code] || [0, 999]);
      }
    });
    (saved.soft || []).forEach((s) => {
      const r = RULE_REGISTRY.soft.find((x) => x.code === s.code);
      if (!r) return;
      if (Number.isFinite(s.weight)) r.weight = clampTo(s.weight, WEIGHT_RANGE);
      if (r.param && Number.isFinite(s.param)) {
        r.param.value = clampTo(s.param, PARAM_RANGE[r.code] || [0, 999]);
      }
    });
    return true;
  } catch (e) { return false; }
}

function resetRules() {
  try { localStorage.removeItem(RULES_STORE_KEY); } catch (e) {}
  location.reload();
}

/* ══ 分頁切換 ═══════════════════════════════════════════ */

function switchScreen(name) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.screen === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ══ 畫面 1：缺班事件建立 ═══════════════════════════════ */

let parsing = false;

async function handleParse() {
  // 重入保護：貼上事件與按鈕點擊可能重疊觸發，同時跑兩次會互相覆蓋畫面
  if (parsing) return;
  parsing = true;
  const btn = $('#btn-parse');
  btn.disabled = true;
  btn.textContent = '解析中…';
  try {
    await doParse();
  } finally {
    // 不論成功失敗，按鈕都要回復可用——解析失敗時畫面不能卡在「解析中」
    parsing = false;
    btn.disabled = false;
    btn.textContent = '重新解析';
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

      ${soft.length ? `<h4 style="margin:0 0 4px;font-size:13px;color:var(--ink-faint)">可評估的鬆綁選項</h4>${soft.map(optionRow).join('')}` : ''}
      ${legal.length ? `<h4 style="margin:14px 0 4px;font-size:13px;color:var(--ink-faint)">以下條件涉及法規或病安下限，列出僅供了解缺口成因</h4>${legal.map(optionRow).join('')}` : ''}
      ${opts.length === 0 ? '<div class="sc-evi">放寬任何單一條件都無法產生新的候選人，缺口屬結構性人力不足。</div>' : ''}

      <h4 style="margin:16px 0 4px;font-size:13px;color:var(--ink-faint)">不涉及鬆綁規則的其他處理方式</h4>
      <ul style="margin:0;padding-left:18px;font-size:13.5px">
        <li>擴大至鄰近單位支援池，並同步提高交班與 orientation 的時間</li>
        <li>評估拆班（兩人各分擔半班），降低單一人員的工時衝擊</li>
        <li>檢視當班任務是否可重新分工，讓不具特定資格者仍可承擔其餘照護工作</li>
        <li>通報護理部調度中心，啟動院級人力調度或約用人力</li>
      </ul>
      <p class="fineprint">若本情境反覆出現，代表該單位在此時段的人力配置需要結構性檢討，而非每次靠替補補洞。</p>
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
    renderFairness();
    renderWarnings();
    renderRoster();

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

function renderRoster() {
  $('#week-label').textContent = WEEK.label;

  const head = `<thead><tr><th>人員</th><th>職務</th>${
    WEEK_DATES.map((d) => `<th class="center">${shortDate(d)}<br>（${weekdayOf(d)}）</th>`).join('')
  }<th class="center">週工時</th></tr></thead>`;

  const gap = state.gap || GAP_EVENT;
  const gapFilled = state.confirmed && state.chosen;

  const body = STAFF.map((s) => {
    const cells = WEEK_DATES.map((d) => {
      const sh = SHIFTS.find((x) => x.staffId === s.id && x.date === d);
      if (sh) {
        return `<td class="center"><span class="cell cell-${sh.shift}">${sh.shift}${sh.isReplacement ? '<sup>替</sup>' : ''}</span></td>`;
      }
      if (!gapFilled && gap.originalStaffId === s.id && d === gap.date) {
        return '<td class="center"><span class="cell cell-G">缺班</span></td>';
      }
      if (engine.isOnLeave(s, d)) return '<td class="center"><span class="cell cell-L">假</span></td>';
      return '<td class="center" style="color:var(--ink-faint)">·</td>';
    }).join('');
    return `<tr><td><b>${esc(s.id)}</b></td><td>${esc(s.role)}</td>${cells}<td class="center">${engine.weeklyHours(s.id, WEEK.start)} 小時</td></tr>`;
  }).join('');

  $('#roster-table').innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderStaffTable() {
  const head = `<thead><tr>
    <th>代號</th><th>職務</th><th>所屬單位</th><th>資格與效期</th>
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
      <td><b>${esc(s.id)}</b></td><td>${esc(s.role)}</td><td>${esc(UNITS[s.unit])}</td>
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

  logAction('任務重分配試算（韌性模式）',
    `${sc.gapLabel}：${sc.onDuty.length} 位在班人員承接 ${r.coveredCount}／${r.totalCount} 項任務，` +
    `未覆蓋 ${r.uncovered.length} 項（關鍵 ${r.uncoveredCritical} 項）——由主管決定上報或調度`,
    '班守 ShiftGuard 規則引擎');
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

  state.chosen = null;
  state.confirmed = false;
  renderConfirmPlaceholder();
  renderCandidates();
  renderFairness();
  renderWarnings();
  renderRoster();
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

  if (loadRules()) {
    logAction('載入本機保存的規則設定',
      `軟性權重 ${RULE_REGISTRY.soft.map((r) => `${r.code}=${r.weight}`).join('、')}（可按「還原預設規則」清除）`,
      '班守 ShiftGuard');
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
  });

  STAFF.forEach((s) => { BASELINE_STANDBY[s.id] = s.standbyCount30d; });
  $('#ans-reporter').innerHTML = '<option value="">（訊息未識別通報人員）</option>' +
    STAFF.map((s) => `<option value="${s.id}"${s.id === GAP_EVENT.originalStaffId ? ' selected' : ''}>` +
      `${s.id}　${s.role}　${UNITS[s.unit]}</option>`).join('');

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchScreen(t.dataset.screen)));
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
  $('#btn-recalc').addEventListener('click', handleRecalc);
  $('#btn-multi-run').addEventListener('click', handleMultiRun);
  $('#btn-realloc-run').addEventListener('click', handleReallocRun);

  renderRoster();
  renderStaffTable();
  renderRules();
  renderFairness();
  renderWarnings();
  renderAuditLog();
  renderMultiScenario();
  renderReallocScenario();
}

document.addEventListener('DOMContentLoaded', init);
