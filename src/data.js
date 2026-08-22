/**
 * data.js — 模擬資料層
 *
 * 【重要聲明】
 * 本檔所有人員、班表、請假、資格資料皆為虛構，僅用於 DEMO DAY 演示。
 * 人員一律以代號呈現（N-01 ~ N-11），不使用任何真實或虛構姓名。
 * 不含任何病患資料、病歷或可識別個人之內容。
 */

/* ── 班別定義 ───────────────────────────────────────────── */
const SHIFT_TYPES = {
  D: { code: 'D', name: '白班', start: '07:00', end: '15:00', hours: 8, overnight: false },
  E: { code: 'E', name: '小夜', start: '15:00', end: '23:00', hours: 8, overnight: false },
  N: { code: 'N', name: '大夜', start: '23:00', end: '07:00', hours: 8, overnight: true },
};

/* ── 照護單位 ───────────────────────────────────────────── */
const UNITS = {
  'MED-3A': '內科病房 3A',
  'SUR-5B': '外科病房 5B',
  'ICU': '加護病房',
};

/**
 * 各單位每班別的最低配置人力。
 * 本 demo 的班表只是單位的「部分名單」（命題要求 8–12 名），
 * 故以 1 計，用來呈現「缺班＝當班人力低於配置」的判定機制；
 * 正式導入時應對接院內護病比與實際最低配置人數。
 */
const UNIT_MIN_STAFF = {
  'MED-3A': { D: 1, E: 1, N: 1 },
  'SUR-5B': { D: 1, E: 1, N: 1 },
  'ICU':    { D: 1, E: 1, N: 1 },
};

/* ── 三班護病比（需求模型）───────────────────────────────
 * 台灣三班護病比自 2024 年入法並連動獎勵金；下表為公告標準之「示意」
 * （一般病房，1 護理師：X 病人），正式導入以院方適用層級與最新公告為準。
 * ICU 以評鑑基準 1:2 示意（icuRatio）。占床數為模擬資料。
 */
const HOSPITAL_LEVELS = {
  MC: { name: '醫學中心', ratios: { D: 6, E: 9, N: 11 } },
  RH: { name: '區域醫院', ratios: { D: 7, E: 11, N: 13 } },
  DH: { name: '地區醫院', ratios: { D: 10, E: 13, N: 15 } },
};
const ICU_RATIO = { D: 2, E: 2, N: 2 };

/** 各單位占床（模擬；MED-3A 的量級對齊示範班表的部分名單） */
const UNIT_CENSUS = {
  'MED-3A': { beds: 14, occupied: 10 },
  'SUR-5B': { beds: 30, occupied: 24 },
  'ICU':    { beds: 10, occupied: 6 },
};

/* ── 資格／證照定義 ─────────────────────────────────────── */
const CERTS = {
  ACLS: '高級心臟救命術 ACLS',
  CHEMO: '化學治療給藥資格',
  IV: '靜脈注射技術',
  VENT: '呼吸器照護',
};

/* ── 職務層級（數字越大層級越高）───────────────────────── */
const ROLE_LEVELS = {
  '護佐': 0,
  '護理師': 1,
  '資深護理師': 2,
};

/* ── 護理進階制度（臨床專業能力階層，與職務並行）─────────
 * 依台灣護理人員進階制度：N1 基礎照護 → N2 重症照護 → N3 整體照護與教學
 * → N4 專案改善與研究；AHN 副護理長（行政職，臨床上視同 N4 以上帶班能力）。
 * 「帶班資深」的預設門檻為 N3 以上（院內政策，可依單位調整）。
 */
const LADDER_LEVELS = {
  N1: { level: 1, name: 'N1 基礎照護' },
  N2: { level: 2, name: 'N2 重症照護' },
  N3: { level: 3, name: 'N3 整體照護與教學' },
  N4: { level: 4, name: 'N4 專案與研究' },
  AHN: { level: 5, name: 'AHN 副護理長' },
};

/* ── 本週範圍（用於週工時計算）─────────────────────────── */
const WEEK = { start: '2026-08-03', end: '2026-08-09', label: '2026 年 8 月第 1 週（8/03 一 – 8/09 日）' };
const WEEK_DATES = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];

/* ── 四週彈性工時週期錨點（勞基法第 30 條之 1）─────────────
 * 醫療保健服務業為勞動部指定得實施四週彈性工時之行業。
 * 週期為「固定劃分」：自此日（須為週一）起每 28 天為一個四週週期、
 * 對半為二週週期；H7（雙週例假）、H8（四週工時總量）、
 * H9（四週休息日總量）皆以此劃分計算，勞檢亦以固定週期核對。
 * 正式導入時應改為院方行事曆公告之週期起始日。 */
const FLEX_CYCLE_ANCHOR = '2026-08-03';

/* ── 人員主檔 ───────────────────────────────────────────── */
/**
 * certs        資格代碼 → 效期（YYYY-MM-DD），過期即視為不具備
 * willingShifts  人員自填之願意支援班別；null 代表未表態
 * familiarUnits  熟悉／曾支援過的單位
 * standbyCount30d 近 30 天被叫班替補次數 ← 公平性訊號的來源
 */
const STAFF = [
  {
    id: 'N-01', role: '資深護理師', ladder: 'AHN', unit: 'MED-3A',
    certs: { ACLS: '2027-05-31', CHEMO: '2027-01-31', IV: '2028-12-31' },
    willingShifts: ['D'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 4,
    leaves: [],
    note: '資深、資格完整，但近一個月已被叫班 4 次',
  },
  {
    id: 'N-02', role: '護理師', ladder: 'N2', unit: 'MED-3A',
    certs: { ACLS: '2027-03-31', CHEMO: '2026-12-31', IV: '2028-06-30' },
    willingShifts: ['D', 'E'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 1,
    leaves: [],
    note: '',
  },
  {
    id: 'N-03', role: '護理師', ladder: 'N1', unit: 'MED-3A',
    certs: { ACLS: '2027-06-30', IV: '2027-12-31' },
    willingShifts: ['D', 'E'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 2,
    leaves: [],
    /* H10 個人限制：妊娠期間依勞基法第 49 條不得於夜間工作。
     * 示範以班別為粒度標示大夜；法定禁止時段實為 22:00 起，
     * 正式導入應以時段判定（小夜 15–23 亦跨入禁止時段）。 */
    restrictions: [{
      from: '2026-07-01', to: '2027-01-31', shifts: ['N'],
      reason: '妊娠期間（勞基法第 49 條，醫囑登錄）',
    }],
    note: '未取得化學治療給藥資格；妊娠期間不得排大夜（H10）',
  },
  {
    id: 'N-04', role: '資深護理師', ladder: 'N3', unit: 'MED-3A',
    certs: { ACLS: '2026-06-30', CHEMO: '2027-08-31', IV: '2028-03-31' },
    willingShifts: ['D'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 0,
    leaves: [],
    note: 'ACLS 證照已於 2026-06-30 到期，尚未完成回訓',
  },
  {
    id: 'N-05', role: '護理師', ladder: 'N1', unit: 'MED-3A',
    certs: { ACLS: '2027-02-28', CHEMO: '2027-04-30', IV: '2028-01-31' },
    willingShifts: ['D'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 1,
    leaves: [{ from: '2026-08-07', to: '2026-08-11', type: '病假' }],
    note: '本次缺班事件的原班人員',
  },
  {
    id: 'N-06', role: '護理師', ladder: 'N2', unit: 'MED-3A',
    certs: { ACLS: '2027-09-30', CHEMO: '2027-05-31', IV: '2028-08-31' },
    willingShifts: ['E'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 3,
    leaves: [],
    note: '',
  },
  {
    id: 'N-07', role: '護理師', ladder: 'N2', unit: 'MED-3A',
    certs: { ACLS: '2027-04-30', CHEMO: '2027-07-31', IV: '2028-05-31' },
    willingShifts: ['N'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 2,
    leaves: [],
    note: '帳面上 8/09 無班，但 8/08 大夜要到 8/09 早上 07:00 才下班',
  },
  {
    id: 'N-08', role: '護理師', ladder: 'N2', unit: 'SUR-5B',
    certs: { ACLS: '2027-11-30', CHEMO: '2027-03-31', IV: '2028-09-30' },
    willingShifts: null,
    familiarUnits: ['SUR-5B', 'MED-3A'],
    standbyCount30d: 0,
    leaves: [],
    note: '外科病房人員，過去曾支援內科病房 3A',
  },
  {
    id: 'N-09', role: '護理師', ladder: 'N1', unit: 'MED-3A',
    certs: { ACLS: '2027-08-31', CHEMO: '2027-06-30', IV: '2028-11-30' },
    willingShifts: ['D'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 3,
    leaves: [],
    note: '帳面上 8/09 無班，但已連續上班 6 天',
  },
  {
    id: 'N-10', role: '資深護理師', ladder: 'N4', unit: 'MED-3A',
    certs: { ACLS: '2027-10-31', CHEMO: '2027-09-30', IV: '2028-10-31', VENT: '2027-12-31' },
    willingShifts: ['D'],
    familiarUnits: ['MED-3A', 'ICU'],
    standbyCount30d: 3,
    leaves: [],
    note: '',
  },
  {
    id: 'N-11', role: '護理師', ladder: 'N1', unit: 'MED-3A',
    certs: { ACLS: '2027-07-31', CHEMO: '2027-02-28', IV: '2028-04-30' },
    willingShifts: ['D', 'E'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 1,
    leaves: [{ from: '2026-08-08', to: '2026-08-10', type: '特休' }],
    note: '資格與工時都符合，但缺班當日已排定特休',
  },
];

/* ── 現有班表（1 週）─────────────────────────────────────
 * 註：N-05 原排定 2026-08-09 白班，因病假取消 → 即為本次缺班事件。
 */
const SHIFTS = [
  // N-01
  { staffId: 'N-01', date: '2026-08-03', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-01', date: '2026-08-04', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-01', date: '2026-08-06', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-01', date: '2026-08-07', shift: 'D', unit: 'MED-3A' },
  // N-02
  { staffId: 'N-02', date: '2026-08-04', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-02', date: '2026-08-05', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-02', date: '2026-08-07', shift: 'D', unit: 'MED-3A' },
  // N-03
  { staffId: 'N-03', date: '2026-08-03', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-03', date: '2026-08-04', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-03', date: '2026-08-06', shift: 'E', unit: 'MED-3A' },
  { staffId: 'N-03', date: '2026-08-07', shift: 'E', unit: 'MED-3A' },
  // N-04
  { staffId: 'N-04', date: '2026-08-04', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-04', date: '2026-08-05', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-04', date: '2026-08-06', shift: 'D', unit: 'MED-3A' },
  // N-05（8/07 起病假，後續班次已取消）
  { staffId: 'N-05', date: '2026-08-03', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-05', date: '2026-08-04', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-05', date: '2026-08-05', shift: 'D', unit: 'MED-3A' },
  // N-06
  { staffId: 'N-06', date: '2026-08-04', shift: 'E', unit: 'MED-3A' },
  { staffId: 'N-06', date: '2026-08-05', shift: 'E', unit: 'MED-3A' },
  { staffId: 'N-06', date: '2026-08-07', shift: 'E', unit: 'MED-3A' },
  { staffId: 'N-06', date: '2026-08-08', shift: 'E', unit: 'MED-3A' },
  { staffId: 'N-06', date: '2026-08-09', shift: 'E', unit: 'MED-3A' },
  // N-07
  { staffId: 'N-07', date: '2026-08-04', shift: 'N', unit: 'MED-3A' },
  { staffId: 'N-07', date: '2026-08-05', shift: 'N', unit: 'MED-3A' },
  { staffId: 'N-07', date: '2026-08-07', shift: 'N', unit: 'MED-3A' },
  { staffId: 'N-07', date: '2026-08-08', shift: 'N', unit: 'MED-3A' },
  // N-08
  { staffId: 'N-08', date: '2026-08-03', shift: 'D', unit: 'SUR-5B' },
  { staffId: 'N-08', date: '2026-08-04', shift: 'E', unit: 'SUR-5B' },
  { staffId: 'N-08', date: '2026-08-06', shift: 'D', unit: 'SUR-5B' },
  // N-09（連續上班 8/03 – 8/08）
  { staffId: 'N-09', date: '2026-08-03', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-09', date: '2026-08-04', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-09', date: '2026-08-05', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-09', date: '2026-08-06', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-09', date: '2026-08-07', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-09', date: '2026-08-08', shift: 'D', unit: 'MED-3A' },
  // N-10（連續上班 8/05 – 8/08）
  { staffId: 'N-10', date: '2026-08-05', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-10', date: '2026-08-06', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-10', date: '2026-08-07', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-10', date: '2026-08-08', shift: 'D', unit: 'MED-3A' },
  // N-11（8/08 起特休，後續班次已取消）
  { staffId: 'N-11', date: '2026-08-03', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-11', date: '2026-08-04', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-11', date: '2026-08-06', shift: 'D', unit: 'MED-3A' },
  { staffId: 'N-11', date: '2026-08-07', shift: 'D', unit: 'MED-3A' },
];

/* ── 多筆缺班演示情境 ─────────────────────────────────────
 * 同一晚兩筆缺班：第一筆需要資深護理師帶化療；第二筆在 ICU、
 * 需要呼吸器照護資格——全院只有 N-10 具備。
 * N-10 同時是第一筆的最高分候選：逐筆指派會把他用掉，
 * 第二筆就無人可派；全局指派會把他留給只有他能補的缺口。
 */
const MULTI_GAP_SCENARIO = [
  {
    id: 'GAP-MULTI-1', date: '2026-08-09', shift: 'D', unit: 'MED-3A',
    requiredRole: '資深護理師', requiredCerts: ['ACLS', 'CHEMO'],
    originalStaffId: null, reason: '臨時病假，當班需資深人員督導化療給藥',
  },
  {
    id: 'GAP-MULTI-2', date: '2026-08-09', shift: 'E', unit: 'ICU',
    requiredRole: '護理師', requiredCerts: ['ACLS', 'VENT'],
    originalStaffId: null, reason: '臨時事假，當班有使用呼吸器之病人',
  },
];

/* ── 任務重分配演示情境（第三層：韌性模式）─────────────────
 * 假設情境：畫面 7 的 ICU 缺班連唯一具呼吸器資格的 N-10 也請假——
 * 全院無人可替補。此時缺的不再是「一個人」，而是「一班的任務」：
 * 把缺班者的任務拆解，重分配給在班人力，無人可承接的誠實標示為缺口。
 * onDuty 為該班別在班人員（獨立情境資料，不與 STAFF 合併，certs 為代碼陣列）。
 */
const TASK_REALLOC_SCENARIO = {
  gapLabel: '2026-08-09（日）小夜 @ 加護病房',
  absent: { id: 'N-10', role: '資深護理師', note: '唯一具呼吸器照護資格者' },
  maxExtraLoad: 3,   // 每位在班人員最多可多承接的工作量點數
  tasks: [
    { id: 'T1', name: '呼吸器參數監測與抽痰（2 床）', requiredCerts: ['VENT'], workload: 3, critical: true },
    { id: 'T2', name: '中央靜脈導管給藥', requiredCerts: ['IV'], workload: 2, critical: true },
    { id: 'T3', name: '生命徵象與意識評估（每 2 小時）', requiredCerts: [], workload: 2, critical: true },
    { id: 'T4', name: '常規口服與管灌給藥', requiredCerts: [], workload: 2, critical: true },
    { id: 'T5', name: '護理紀錄與交班準備', requiredCerts: [], workload: 1, critical: false },
    { id: 'T6', name: '家屬溝通與衛教', requiredCerts: [], workload: 1, critical: false },
  ],
  onDuty: [
    { id: 'I-01', role: '護理師', certs: ['ACLS', 'IV'] },
    { id: 'I-02', role: '護理師', certs: ['ACLS'] },
  ],
};

/* ── 督導調度演示情境（值班夜：跨單位借調的守恆律）────────
 * 22:40，值班督導的手機響：ICU 小夜倒一人（需 ACLS＋VENT）。
 * 全院三單位當班——SUR-5B 有餘裕（3 在班／需 2），但其中一人無 VENT、
 * 一人近期已被頻繁借調；MED-3A 恰好貼線（1 在班／需 1），借走即破線。
 * 考驗調度的守恆律：借調不能讓支援單位自己變成缺口。
 * 獨立情境資料（同 TASK_REALLOC_SCENARIO 模式），不與全域 STAFF 合併。
 */
const DISPATCH_SCENARIO = {
  label: '2026-08-08（六）小夜 22:40｜ICU 通報缺 1 人',
  date: '2026-08-08', shift: 'E', toUnit: 'ICU',
  requiredCerts: ['ACLS', 'VENT'], requiredRole: '護理師',
  demand: {
    'MED-3A': { D: 2, E: 1, N: 1 },
    'SUR-5B': { D: 3, E: 2, N: 2 },
    'ICU':    { D: 3, E: 2, N: 2 },
  },
  staff: [
    { id: 'S-01', role: '護理師', ladder: 'N2', unit: 'SUR-5B',
      certs: { ACLS: '2027-12-31', VENT: '2027-06-30', IV: '2028-01-31' },
      willingShifts: ['D', 'E'], familiarUnits: ['SUR-5B', 'ICU'], standbyCount30d: 1, leaves: [] },
    { id: 'S-02', role: '護理師', ladder: 'N1', unit: 'SUR-5B',
      certs: { ACLS: '2027-10-31', IV: '2027-08-31' },
      willingShifts: ['E'], familiarUnits: ['SUR-5B'], standbyCount30d: 0, leaves: [] },
    { id: 'S-03', role: '資深護理師', ladder: 'N3', unit: 'SUR-5B',
      certs: { ACLS: '2028-03-31', VENT: '2027-09-30', IV: '2028-06-30' },
      willingShifts: ['D', 'E', 'N'], familiarUnits: ['SUR-5B'], standbyCount30d: 5, leaves: [] },
    { id: 'M-01', role: '護理師', ladder: 'N2', unit: 'MED-3A',
      certs: { ACLS: '2027-11-30', VENT: '2027-05-31', IV: '2027-12-31' },
      willingShifts: ['E'], familiarUnits: ['MED-3A', 'ICU'], standbyCount30d: 2, leaves: [] },
    { id: 'I-01', role: '護理師', ladder: 'N2', unit: 'ICU',
      certs: { ACLS: '2027-07-31', VENT: '2027-04-30', IV: '2028-02-28' },
      willingShifts: ['E', 'N'], familiarUnits: ['ICU'], standbyCount30d: 3, leaves: [] },
  ],
  shifts: [
    { staffId: 'S-01', date: '2026-08-08', shift: 'E', unit: 'SUR-5B' },
    { staffId: 'S-02', date: '2026-08-08', shift: 'E', unit: 'SUR-5B' },
    { staffId: 'S-03', date: '2026-08-08', shift: 'E', unit: 'SUR-5B' },
    { staffId: 'M-01', date: '2026-08-08', shift: 'E', unit: 'MED-3A' },
    { staffId: 'I-01', date: '2026-08-08', shift: 'E', unit: 'ICU' },
  ],
};

/* ── 班表生成演示情境（第 0 層：源頭治理）─────────────────
 * 為內科病房 3A 生成「下一週」班表：每日白班 2 人、小夜 1 人、大夜 1 人，
 * 全部需 ACLS 有效（病房安全政策）。現有班表（8/03–8/09）作為邊界條件：
 * 8/09 的小夜與跨週的連續上班天數會約束 8/10 起的生成。
 */
const GEN_SCENARIO = {
  unit: 'MED-3A',
  label: '2026 年 8 月第 2 週（8/10 一 – 8/16 日）',
  dates: ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'],
  requirements: [
    { shift: 'D', count: 2, requiredRole: '護理師', requiredCerts: ['ACLS'] },
    { shift: 'E', count: 1, requiredRole: '護理師', requiredCerts: ['ACLS'] },
    { shift: 'N', count: 1, requiredRole: '護理師', requiredCerts: ['ACLS'] },
  ],
};

/* ── 缺班事件的原始通報訊息（護理長轉貼）─────────────────
 * 刻意缺少「單位」與「必要資格」，用來演示 Agent 主動追問。
 */
const RAW_MESSAGE =
  '護理長不好意思，我從昨天開始發燒到 38.5 度，剛剛看完醫生說要休息，' +
  '禮拜天的早班我真的沒辦法上了，很抱歉造成大家困擾 🙏';

/* ── 範例訊息（一鍵帶入並解析，降低輸入摩擦）─────────────
 * 四種刻意設計的情境：欄位齊全度不同，展示解析與追問的各種行為。
 */
const SAMPLE_MESSAGES = [
  { label: '典型病假', text: RAW_MESSAGE },
  { label: '下週進修', text: '護理長，我下週三大夜要去進修，那天沒辦法上班，麻煩您了' },
  { label: '日期模糊', text: '護理長，我從今天開始發燒，禮拜天的早班沒辦法上了，很抱歉' },
  { label: '什麼都沒說', text: '護理長不好意思，我臨時有事，班沒辦法上了 🙏' },
];

/* ── 缺班事件（Agent 解析 + 主管補充後的完整版）─────────── */
const GAP_EVENT = {
  id: 'GAP-20260809-D-MED3A',
  date: '2026-08-09',
  shift: 'D',
  unit: 'MED-3A',
  requiredRole: '護理師',      // 需達此職務層級以上
  requiredCerts: ['ACLS', 'CHEMO'],
  originalStaffId: 'N-05',
  reason: '原班人員 N-05 因病假無法出勤',
  raisedBy: '內科病房 3A 護理長',
  raisedAt: '2026-08-08 20:14',
  contextNote: '當日排定 2 名化學治療病人給藥，故需具備化療給藥資格。',
};

/* 中文星期常數（WEEKDAY_TW）已移至 src/engine.js 的日期工具區 */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SHIFT_TYPES, UNITS, CERTS, ROLE_LEVELS, LADDER_LEVELS, WEEK, WEEK_DATES,
    STAFF, SHIFTS, RAW_MESSAGE, GAP_EVENT, UNIT_MIN_STAFF, MULTI_GAP_SCENARIO,
    SAMPLE_MESSAGES, TASK_REALLOC_SCENARIO, GEN_SCENARIO, FLEX_CYCLE_ANCHOR,
    HOSPITAL_LEVELS, ICU_RATIO, UNIT_CENSUS, DISPATCH_SCENARIO,
  };
}
