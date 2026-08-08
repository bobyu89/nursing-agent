/**
 * data.js — 模擬資料層
 *
 * 【重要聲明】
 * 本檔所有人員、班表、請假、資格資料皆為虛構，僅用於 DEMO DAY 演示。
 * 人員一律以代號呈現（N-01 ~ N-10），不使用任何真實或虛構姓名。
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

/* ── 本週範圍（用於週工時計算）─────────────────────────── */
const WEEK = { start: '2026-08-03', end: '2026-08-09', label: '2026 年 8 月第 1 週（8/03 一 – 8/09 日）' };
const WEEK_DATES = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];

/* ── 人員主檔 ───────────────────────────────────────────── */
/**
 * certs        資格代碼 → 效期（YYYY-MM-DD），過期即視為不具備
 * willingShifts  人員自填之願意支援班別；null 代表未表態
 * familiarUnits  熟悉／曾支援過的單位
 * standbyCount30d 近 30 天被叫班替補次數 ← 公平性訊號的來源
 */
const STAFF = [
  {
    id: 'N-01', role: '資深護理師', unit: 'MED-3A',
    certs: { ACLS: '2027-05-31', CHEMO: '2027-01-31', IV: '2028-12-31' },
    willingShifts: ['D'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 4,
    leaves: [],
    note: '資深、資格完整，但近一個月已被叫班 4 次',
  },
  {
    id: 'N-02', role: '護理師', unit: 'MED-3A',
    certs: { ACLS: '2027-03-31', CHEMO: '2026-12-31', IV: '2028-06-30' },
    willingShifts: ['D', 'E'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 1,
    leaves: [],
    note: '',
  },
  {
    id: 'N-03', role: '護理師', unit: 'MED-3A',
    certs: { ACLS: '2027-06-30', IV: '2027-12-31' },
    willingShifts: ['D', 'E'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 2,
    leaves: [],
    note: '未取得化學治療給藥資格',
  },
  {
    id: 'N-04', role: '資深護理師', unit: 'MED-3A',
    certs: { ACLS: '2026-06-30', CHEMO: '2027-08-31', IV: '2028-03-31' },
    willingShifts: ['D'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 0,
    leaves: [],
    note: 'ACLS 證照已於 2026-06-30 到期，尚未完成回訓',
  },
  {
    id: 'N-05', role: '護理師', unit: 'MED-3A',
    certs: { ACLS: '2027-02-28', CHEMO: '2027-04-30', IV: '2028-01-31' },
    willingShifts: ['D'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 1,
    leaves: [{ from: '2026-08-07', to: '2026-08-11', type: '病假' }],
    note: '本次缺班事件的原班人員',
  },
  {
    id: 'N-06', role: '護理師', unit: 'MED-3A',
    certs: { ACLS: '2027-09-30', CHEMO: '2027-05-31', IV: '2028-08-31' },
    willingShifts: ['E'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 3,
    leaves: [],
    note: '',
  },
  {
    id: 'N-07', role: '護理師', unit: 'MED-3A',
    certs: { ACLS: '2027-04-30', CHEMO: '2027-07-31', IV: '2028-05-31' },
    willingShifts: ['N'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 2,
    leaves: [],
    note: '帳面上 8/09 無班，但 8/08 大夜要到 8/09 早上 07:00 才下班',
  },
  {
    id: 'N-08', role: '護理師', unit: 'SUR-5B',
    certs: { ACLS: '2027-11-30', CHEMO: '2027-03-31', IV: '2028-09-30' },
    willingShifts: null,
    familiarUnits: ['SUR-5B', 'MED-3A'],
    standbyCount30d: 0,
    leaves: [],
    note: '外科病房人員，過去曾支援內科病房 3A',
  },
  {
    id: 'N-09', role: '護理師', unit: 'MED-3A',
    certs: { ACLS: '2027-08-31', CHEMO: '2027-06-30', IV: '2028-11-30' },
    willingShifts: ['D'],
    familiarUnits: ['MED-3A'],
    standbyCount30d: 3,
    leaves: [],
    note: '帳面上 8/09 無班，但已連續上班 6 天',
  },
  {
    id: 'N-10', role: '資深護理師', unit: 'MED-3A',
    certs: { ACLS: '2027-10-31', CHEMO: '2027-09-30', IV: '2028-10-31', VENT: '2027-12-31' },
    willingShifts: ['D'],
    familiarUnits: ['MED-3A', 'ICU'],
    standbyCount30d: 3,
    leaves: [],
    note: '',
  },
  {
    id: 'N-11', role: '護理師', unit: 'MED-3A',
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

/* ── 缺班事件的原始通報訊息（護理長轉貼）─────────────────
 * 刻意缺少「單位」與「必要資格」，用來演示 Agent 主動追問。
 */
const RAW_MESSAGE =
  '護理長不好意思，我從昨天開始發燒到 38.5 度，剛剛看完醫生說要休息，' +
  '禮拜天的早班我真的沒辦法上了，很抱歉造成大家困擾 🙏';

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

/* ── 中文星期 ───────────────────────────────────────────── */
const WEEKDAY_TW = ['日', '一', '二', '三', '四', '五', '六'];
