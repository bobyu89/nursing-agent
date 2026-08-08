/**
 * llm.js — 語言模型轉接層（LLM Adapter）
 *
 * 【誠實原則 — DEMO 必讀】
 * 本轉接層有兩種模式，畫面右上角永遠會標示目前跑在哪一種：
 *
 *   mock  預設模式。回應為本檔內建的決定性樣板，現場斷網也能跑。
 *         ★ 不是即時模型推論，簡報時必須主動說明。
 *   api   接真實模型（AWS Bedrock 或相容端點）。需設定端點與金鑰。
 *
 * 不論哪種模式，模型都「只負責語言」：
 *   1. 解析自然語言通報訊息 → 結構化缺班事件
 *   2. 條件不完整時主動追問
 *   3. 把 engine.js 算出的數字寫成人話的推薦／不推薦理由
 *   4. 生成主管確認摘要與通知草稿
 *
 * 所有數字（工時、班距、連續天數、分數）一律來自 engine.js，
 * 模型不得改寫、不得自行計算、不得補完缺漏欄位。
 */

const LLM = {
  mode: 'mock',                       // 'mock' | 'api'
  endpoint: '',                       // api 模式：模型端點
  modelId: 'claude-sonnet-5',         // api 模式：模型 ID（架構圖對應 AWS Bedrock）

  get modeLabel() {
    return this.mode === 'mock' ? '模擬（離線）' : `即時推論（${this.modelId}）`;
  },
};

/* ── 1. 解析通報訊息 ────────────────────────────────────── */

/* 關鍵詞表：mock 模式的解析依據，改寫訊息後結果會跟著變 */
const KW_SHIFT = [
  { re: /小夜|晚班/, code: 'E' },
  { re: /大夜/, code: 'N' },
  { re: /早班|白班|日班/, code: 'D' },
  { re: /夜班/, code: 'N' },
];
const KW_REASON = [
  { re: /發燒|不舒服|身體不適|生病|感冒|就醫|看醫生|急診|腸胃炎/, value: '病假' },
  { re: /開刀|手術|住院/, value: '病假' },
  { re: /進修|研習|上課|受訓|訓練|考試|研討會/, value: '進修' },
  { re: /家裡|家人|小孩|孩子|長輩|喪|婚/, value: '事假' },
  { re: /特休|排休|休假/, value: '特休' },
];
const KW_UNIT = [
  { re: /內科|3A/i, code: 'MED-3A' },
  { re: /外科|5B/i, code: 'SUR-5B' },
  { re: /加護|ICU/i, code: 'ICU' },
];
const KW_CERT = [
  { re: /化療|化學治療/, code: 'CHEMO' },
  { re: /ACLS|急救|心肺/i, code: 'ACLS' },
  { re: /呼吸器|插管|呼吸治療/, code: 'VENT' },
  { re: /靜脈|IV|打針|注射/i, code: 'IV' },
];
const KW_WEEKDAY = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** 從訊息推算日期；ref 為通報日（YYYY-MM-DD） */
function parseDateFromText(text, ref) {
  const md = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (md) {
    const y = Number(ref.slice(0, 4));
    const iso = `${y}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
    return { value: iso, source: `訊息中「${md[0]}」` };
  }
  if (/後天/.test(text)) return { value: addDays(ref, 2), source: `訊息中「後天」，以通報日 ${ref} 推算` };
  if (/明天|明日/.test(text)) return { value: addDays(ref, 1), source: `訊息中「明天」，以通報日 ${ref} 推算` };
  if (/今天|今日/.test(text)) return { value: ref, source: `訊息中「今天」，以通報日 ${ref} 推算` };

  const wd = text.match(/(下*)\s*(?:禮拜|週|星期)\s*([日天一二三四五六])/);
  if (wd) {
    const target = KW_WEEKDAY[wd[2]];
    const refDow = parseDate(ref).getDay();
    let delta = (target - refDow + 7) % 7;
    if (delta === 0) delta = 7;               // 「禮拜X」指的是下一個，不是今天
    delta += 7 * wd[1].length;                // 每一個「下」再往後一週（下下禮拜X = +14）
    return { value: addDays(ref, delta), source: `訊息中「${wd[0].replace(/\s/g, '')}」，以通報日 ${ref}（${weekdayOf(ref)}）推算` };
  }
  return null;
}

function matchFirst(list, text) {
  for (const item of list) if (item.re.test(text)) return item;
  return null;
}

/**
 * 把護理長轉貼的訊息解析為結構化缺班事件。
 * mock 模式使用上方關鍵詞表實際比對輸入文字——改寫訊息，解析結果會跟著改變。
 * 訊息中沒寫的欄位一律留空並轉為追問，Agent 不臆測。
 */
async function llmParseGapMessage(rawText) {
  if (LLM.mode === 'api') return llmCallApi('parse_gap', { rawText });

  await tick(600);
  const text = String(rawText || '');
  const refDate = GAP_EVENT.raisedAt.slice(0, 10);

  const d = parseDateFromText(text, refDate);
  const sh = matchFirst(KW_SHIFT, text);
  const rs = matchFirst(KW_REASON, text);
  const un = matchFirst(KW_UNIT, text);
  const certs = KW_CERT.filter((c) => c.re.test(text)).map((c) => c.code);

  const extracted = {
    date: d
      ? { value: d.value, label: `${d.value}（${weekdayOf(d.value)}）`, source: d.source }
      : { value: null, label: null, source: null },
    shift: sh
      ? { value: sh.code, label: `${SHIFT_TYPES[sh.code].name} ${SHIFT_TYPES[sh.code].start}–${SHIFT_TYPES[sh.code].end}`,
          source: `訊息中「${text.match(sh.re)[0]}」` }
      : { value: null, label: null, source: null },
    reason: rs
      ? { value: rs.value, label: `${rs.value}（依訊息內容「${text.match(rs.re)[0]}」判定）`, source: `訊息中「${text.match(rs.re)[0]}」` }
      : { value: null, label: '未載明，以「臨時請假」記錄', source: '訊息未提及具體事由' },
    unit: un
      ? { value: un.code, label: `${UNITS[un.code]}（${un.code}）`, source: `訊息中「${text.match(un.re)[0]}」` }
      : { value: null, label: null, source: null },
    requiredCerts: certs.length
      ? { value: certs, label: certs.map((c) => CERTS[c]).join('、'), source: '訊息中提及之治療項目' }
      : { value: null, label: null, source: null },
  };

  const QUESTIONS = {
    date: { question: '這筆缺班是哪一天？', hint: '訊息中的時間說法無法明確換算，請主管指定日期' },
    shift: { question: '缺的是哪一個班別？', hint: '訊息未指明班別，需確認才能計算班間休息時間' },
    unit: { question: '這筆缺班是哪一個照護單位？', hint: '訊息未提及單位，需確認以套用該單位的資格要求' },
    requiredCerts: { question: '當班需要哪些必要資格？', hint: '不同單位、不同日期的治療排程，必要資格會不同' },
  };
  const missing = ['date', 'shift', 'unit', 'requiredCerts']
    .filter((f) => !extracted[f].value)
    .map((f) => ({ field: f, ...QUESTIONS[f] }));

  return { extracted, missing };
}

/* ── 2. 追問後的補全（僅組裝，不推論）──────────────────── */

function completeGapEvent(extracted, answers) {
  const date = answers.date || extracted.date.value;
  const shift = answers.shift || extracted.shift.value;
  const unit = answers.unit || extracted.unit.value;
  const requiredCerts = answers.requiredCerts || extracted.requiredCerts.value || [];
  const reason = extracted.reason.value || '臨時請假';
  return {
    ...GAP_EVENT,
    id: `GAP-${date.replace(/-/g, '')}-${shift}-${unit}`,
    date, shift, unit, requiredCerts,
    requiredRole: answers.requiredRole || GAP_EVENT.requiredRole,
    originalStaffId: answers.reporterStaffId || null,
    reason: answers.reporterStaffId
      ? `原班人員 ${answers.reporterStaffId} 因${reason}無法出勤`
      : `原班人員因${reason}無法出勤`,
  };
}

/* ── 3. 推薦／不推薦理由（把數字寫成人話）──────────────── */

/**
 * 注意：本函式只讀取 engine.js 已算好的欄位並組成句子，
 * 不做任何數值判斷或推估。
 */
async function llmExplainCandidate(candidate, gap) {
  if (LLM.mode === 'api') return llmCallApi('explain_candidate', { candidate, gap });

  await tick(200);
  const s = candidate.staff;
  const bd = Object.fromEntries(candidate.score.breakdown.map((b) => [b.code, b]));
  const strengths = [];
  const concerns = [];

  if (bd.S2.ratio >= 0.75) strengths.push(`缺班當週僅排 ${candidate.score.base} 小時，替補後 ${candidate.score.projected} 小時，工時餘裕充足`);
  else if (bd.S2.ratio <= 0.4) concerns.push(`替補後當週工時將達 ${candidate.score.projected} 小時，餘裕有限`);

  if (bd.S1.ratio >= 0.75) strengths.push(`近 30 天僅被叫班 ${s.standbyCount30d} 次，指派他有助於平衡班別分配`);
  else if (bd.S1.ratio <= 0.4) concerns.push(`近 30 天已被叫班 ${s.standbyCount30d} 次，再次指派會加深分配不均`);

  if (bd.S3.ratio >= 0.75) strengths.push(`缺班當週固定上${SHIFT_TYPES[gap.shift].name}，作息銜接自然`);
  if (bd.S4.ratio === 1) strengths.push('本人已自填願意支援此班別');
  else if (bd.S4.ratio === 0) concerns.push('本人未將此班別列入願意支援範圍');
  if (bd.S5.ratio === 1) strengths.push('本單位人員，熟悉病人與流程');
  else if (bd.S5.ratio > 0) concerns.push('需跨單位支援，交班成本較高');

  candidate.flags.forEach((f) => concerns.push(f.text));

  const verdict = candidate.rank === 1
    ? '建議列為優先替補人選'
    : candidate.rank === 2
      ? '建議列為第二替代方案'
      : '可列入備選，但非優先';

  return { verdict, strengths, concerns };
}

/* ── 4. 主管確認摘要與通知草稿 ─────────────────────────── */

async function llmSupervisorSummary(result, chosen, delta) {
  if (LLM.mode === 'api') return llmCallApi('supervisor_summary', { result, chosen, delta });

  await tick(400);
  const gap = result.gap;
  const s = chosen.staff;
  const checklist = [
    `確認 ${s.id} 本人可配合並完成口頭應允`,
    `確認 ${UNITS[gap.unit]} 當日 ${SHIFT_TYPES[gap.shift].name}人力配置無其他缺口`,
  ];
  chosen.flags.forEach((f) => {
    if (f.needsApproval) checklist.push(`取得單位主管加簽：${f.text}`);
    else checklist.push(`知悉並評估：${f.text}`);
  });
  checklist.push('於院內排班系統完成正式調班登錄（本平台不代為寫入）');

  return {
    headline: `建議由 ${s.id}（${s.role}）替補 ${shortDate(gap.date)}（${weekdayOf(gap.date)}）${SHIFT_TYPES[gap.shift].name}`,
    facts: [
      { label: '缺班單位', value: UNITS[gap.unit] },
      { label: '缺班時段', value: `${gap.date}（${weekdayOf(gap.date)}）${SHIFT_TYPES[gap.shift].start}–${SHIFT_TYPES[gap.shift].end}` },
      { label: '缺班原因', value: gap.reason },
      { label: '必要資格', value: gap.requiredCerts.map((c) => CERTS[c]).join('、') },
      { label: '評估人數', value: `${STAFF.length} 名，排除 ${result.excluded.length} 名，合格候選 ${result.candidates.length} 名` },
      { label: '替補後週工時', value: `${chosen.score.base} → ${chosen.score.projected} 小時` },
      { label: '替補後連續上班', value: `${chosen.consecutiveDays} 天` },
      { label: '班間休息', value: chosen.restHours === Infinity ? '本週無鄰近班次' : `最短 ${chosen.restHours} 小時` },
    ],
    checklist,
  };
}

async function llmNotificationDraft(gap, chosen) {
  if (LLM.mode === 'api') return llmCallApi('notification_draft', { gap, chosen });

  await tick(300);
  // 誠實原則：引擎標記需額外核准（F1）時，草稿不得聲稱「均在規範內」
  const needsApproval = chosen.flags.some((f) => f.needsApproval);
  const hoursLine = `系統試算您該週工時為 ${chosen.score.base} 小時，支援後為 ${chosen.score.projected} 小時，` +
    `連續上班 ${chosen.consecutiveDays} 天，` +
    (needsApproval
      ? '因超過院內軟性工時上限，本次支援將先取得單位主管核准後才會確定。'
      : '均在規範內。');
  return [
    `${chosen.staff.id} 您好，我是 ${UNITS[gap.unit]} 護理長。`,
    '',
    `${shortDate(gap.date)}（${weekdayOf(gap.date)}）${SHIFT_TYPES[gap.shift].name}（${SHIFT_TYPES[gap.shift].start}–${SHIFT_TYPES[gap.shift].end}）` +
      `因原班同仁臨時病假出現人力缺口，想請問您當天是否方便支援？`,
    '',
    hoursLine,
    '',
    '若您有困難請直接回覆，我會再安排其他同仁，不用勉強。謝謝您 🙏',
  ].join('\n');
}

/* ── api 模式的呼叫骨架 ─────────────────────────────────── */

/**
 * 架構對應：前端 → API Gateway → Lambda → Amazon Bedrock。
 * DEMO 預設不啟用；若要現場接真實模型，設定 LLM.endpoint 後把 LLM.mode 改為 'api'。
 */
async function llmCallApi(task, payload) {
  if (!LLM.endpoint) throw new Error('LLM api 模式未設定 endpoint');
  const res = await fetch(LLM.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, modelId: LLM.modelId, payload }),
  });
  if (!res.ok) throw new Error(`LLM 端點回應 ${res.status}`);
  return res.json();
}

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LLM, parseDateFromText, completeGapEvent, llmParseGapMessage };
}
