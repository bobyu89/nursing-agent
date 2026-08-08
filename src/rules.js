/**
 * rules.js — 規則庫 Rule Registry
 *
 * 這是整個平台「制度化」的核心：
 * 排班規則是「可維護的資料」，不是寫死在程式裡的邏輯。
 * 護理部主管可在規則庫設定頁調整門檻與權重，決策結果即時重算。
 *
 * 硬性約束（HARD）：違反即排除，並顯示排除原因與規則代碼。
 * 軟性偏好（SOFT）：不排除，以加權評分呈現優先順序。
 * 風險標記（FLAG）：不排除，但主管必須知情。
 */

const RULE_REGISTRY = {
  /* ── 硬性約束 ────────────────────────────────────────── */
  hard: [
    {
      code: 'H1',
      name: '職務與資格符合',
      desc: '須具備缺班所需之職務層級，且所有必要證照在效期內',
      basis: '院內護理人員資格管理辦法',
      relax: { allowed: false, note: '涉及病人安全，不得放寬。應改為調整當班任務分工' },
      enabled: true,
    },
    {
      code: 'H2',
      name: '當日未排其他班別',
      desc: '同一日期不得重複排班',
      basis: '院內排班作業規範',
      relax: { allowed: false, note: '同日連上兩班等同 16 小時工時，不得放寬' },
      enabled: true,
    },
    {
      code: 'H3',
      name: '非請假／不可排班狀態',
      desc: '請假期間、進修或已標記不可排班者不得列入',
      basis: '院內請假管理規定',
      relax: { allowed: true, note: '可由主管個別徵詢當事人意願，銷假支援須本人同意' },
      enabled: true,
    },
    {
      code: 'H4',
      name: '班間休息時間充足',
      desc: '與前後班次之間隔須達門檻時數（含大夜接白班之情形）',
      basis: '勞動基準法第 34 條（輪班制更換班次之休息時間）',
      param: { key: 'minRestHours', label: '最低班間休息時數', value: 11, unit: '小時' },
      relax: { allowed: false, note: '法定下限，放寬將構成違法並提高給藥錯誤風險' },
      enabled: true,
    },
    {
      code: 'H5',
      name: '連續上班天數上限',
      desc: '替補後連續上班天數不得超過門檻',
      basis: '勞動基準法第 36 條（例假）',
      param: { key: 'maxConsecutiveDays', label: '連續上班天數上限', value: 6, unit: '天' },
      relax: { allowed: false, note: '法定下限，七日內必須有一日例假' },
      enabled: true,
    },
    {
      code: 'H6',
      name: '週工時絕對上限',
      desc: '替補後單週工時不得超過門檻',
      basis: '勞動基準法第 32 條（延長工時上限）',
      param: { key: 'hardWeeklyHourCap', label: '週工時絕對上限', value: 60, unit: '小時' },
      relax: { allowed: false, note: '法定上限，不得放寬' },
      enabled: true,
    },
  ],

  /* ── 軟性偏好（加權評分，權重總和 = 100）─────────────── */
  soft: [
    {
      code: 'S1',
      name: '班別分配公平性',
      desc: '近 30 天被叫班替補次數越少，分數越高',
      weight: 30,
      param: { key: 'fairnessSaturation', label: '公平性飽和次數（達此次數得 0 分）', value: 5, unit: '次' },
      rationale: '避免「誰好講話就一直找誰」，是本平台最重要的治理訊號',
    },
    {
      code: 'S2',
      name: '工時餘裕',
      desc: '替補後週工時距軟性上限的餘裕越大，分數越高',
      weight: 25,
      param: { key: 'softWeeklyHourCap', label: '週工時軟性上限（超過需額外核准）', value: 48, unit: '小時' },
      rationale: '優先分配給工時仍有空間者，降低過勞風險',
    },
    {
      code: 'S3',
      name: '班別型態相符',
      desc: '本週既有班別與缺班班別相符的比例越高，分數越高',
      weight: 20,
      rationale: '避免打亂人員既有的生理作息節奏',
    },
    {
      code: 'S4',
      name: '可支援意願',
      desc: '人員自填願意支援此班別者最高分；未表態者給中間分；明確排除者 0 分',
      weight: 15,
      rationale: '尊重人員意願，提高實際應允率',
    },
    {
      code: 'S5',
      name: '單位熟悉度',
      desc: '本單位人員最高分，曾支援過該單位者次之，完全陌生者 0 分',
      weight: 10,
      rationale: '降低跨單位支援的照護交接風險',
    },
  ],

  /* ── 風險標記（不排除，但需主管知情）──────────────────── */
  flags: [
    { code: 'F1', name: '替補後週工時超過軟性上限', level: 'high', needsApproval: true },
    { code: 'F2', name: '替補後連續上班達 5 天以上', level: 'medium', needsApproval: false },
    { code: 'F3', name: '跨單位支援', level: 'medium', needsApproval: false },
    { code: 'F4', name: '近 30 天替補次數偏高，公平性受影響', level: 'low', needsApproval: false },
  ],
};

/* ── 參數存取（引擎與設定頁共用同一份可變資料）─────────── */
function getHardParam(code, fallback) {
  const rule = RULE_REGISTRY.hard.find((r) => r.code === code);
  return rule && rule.param ? rule.param.value : fallback;
}

function getSoftParam(code, fallback) {
  const rule = RULE_REGISTRY.soft.find((r) => r.code === code);
  return rule && rule.param ? rule.param.value : fallback;
}

function getSoftWeight(code) {
  const rule = RULE_REGISTRY.soft.find((r) => r.code === code);
  return rule ? rule.weight : 0;
}

function getHardRule(code) {
  return RULE_REGISTRY.hard.find((r) => r.code === code);
}

function totalSoftWeight() {
  return RULE_REGISTRY.soft.reduce((sum, r) => sum + r.weight, 0);
}
