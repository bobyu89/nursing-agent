/**
 * competence.test.js — 能力判定核心（src/competence.js，班守與特護共用）
 *
 * 釘住七態與「只有 valid／expiring 計入」、無法判讀的效期 fail closed、true＝持有無效期、
 * 候選人補位差異與後備深度（只篩不排）、特護形狀測資、與引擎能力徽章同判，
 * 以及 competence.d.ts 的型別契約。Node 與 tests.html 跑同一份，兩邊都是 8 項。
 */

/* 與內科 3A 預設設定檔同義的能力與病房崗位需求（docs/CONTEXT.md「共用核心」）：
 * 每位在班者須具 ACLS，每班至少一位 N3 以上帶班；ladder 為全院臨床進階序列 */
const K_CAT = {
  competences: {
    ACLS: { label: 'ACLS', cert: 'ACLS' },
    SENIOR: { label: 'N3 以上帶班', ladderAtLeast: 'N3' },
  },
  ladder: ['N1', 'N2', 'N3', 'N4', 'AHN'],
};
const K_WARD_NEEDS = { allMust: ['ACLS'], atLeast: [{ competence: 'SENIOR', min: 1 }] };
const K_PERSON = { id: 'T-1', ladder: 'N2', certs: { ACLS: '2026-08-31' } };
const kStaff = (id) => {
  const s = STAFF.find((x) => x.id === id);
  assert(s, `示範資料查無 ${id}`);
  return s;
};

/* K1 */
test('能力判定核心：效期邊界——到期當日仍有效、隔日過期、提醒視窗內為即將到期；基準日非 ISO 直接拋錯', () => {
  const pick = (b) => [b.kind, b.status, b.counts, b.expiry, b.daysLeft, b.text];
  assertEqual(pick(badgeOf(K_CAT, K_PERSON, 'ACLS', '2026-08-31')), ['cert', 'valid', true, '2026-08-31', 0, '']);
  assertEqual(pick(badgeOf(K_CAT, K_PERSON, 'ACLS', '2026-09-01')),
    ['cert', 'expired', false, '2026-08-31', -1, 'ACLS已於 2026-08-31 過期']);
  assertEqual(pick(badgeOf(K_CAT, K_PERSON, 'ACLS', '2026-08-03', { expiringDays: 30 })),
    ['cert', 'expiring', true, '2026-08-31', 28, 'ACLS將於 2026-08-31 到期（剩 28 天）'], '即將到期仍計入');
  assertEqual(badgeOf(K_CAT, K_PERSON, 'ACLS', '2026-08-03').status, 'valid', '不給提醒視窗就不區分即將到期');
  let err = null;
  try { badgeOf(K_CAT, K_PERSON, 'ACLS', '2026/08/31'); } catch (e) { err = e; }
  assert(err instanceof TypeError, '基準日不是 YYYY-MM-DD 應拋 TypeError，不得靜默比較字串');
});

/* K2 */
test('能力判定核心：無法判讀的效期 fail closed——寫出原值、視同未具備，不猜格式', () => {
  const as = (v) => badgeOf(K_CAT, { id: 'T-2', certs: { ACLS: v } }, 'ACLS', '2026-11-02');
  const slash = as('2026/1/5');
  assertEqual([slash.status, slash.counts, slash.expiry, slash.daysLeft, slash.text],
    ['invalid', false, '2026/1/5', null, 'ACLS效期「2026/1/5」無法判讀，視同未具備']);
  assertEqual(as(46023).status, 'invalid', 'Excel 日期序號不換算');
  assertEqual(as('2027-02-30').status, 'invalid', '不存在的日曆日');
  const blank = as('');
  assertEqual([blank.status, blank.counts, blank.text], ['missing', false, '未持有ACLS']);
  assertEqual(['2028-02-29', '2027-02-29', '2027-5-31', '2027/05/31', 46023, null].map((v) => isIsoDate(v)),
    [true, false, false, false, false, false], '只認真實存在的 YYYY-MM-DD');
});

/* K3 */
test('能力判定核心：true＝持有無效期；未定義的能力代碼與查無此人皆為「無法確認」，不拋錯', () => {
  const held = badgeOf(K_CAT, { id: 'T-3', certs: { ACLS: true } }, 'ACLS', '2026-08-03');
  assertEqual([held.status, held.counts, held.noExpiry, held.expiry, held.daysLeft], ['valid', true, true, null, null]);
  const pals = badgeOf(K_CAT, K_PERSON, 'PALS', '2026-08-03');
  assertEqual([pals.kind, pals.status, pals.counts, pals.text], ['unknown', 'missing', false, '無法確認']);
  const nobody = badgeOf(K_CAT, null, 'ACLS', '2026-08-03');
  assertEqual([nobody.kind, nobody.status, nobody.counts, nobody.text], ['unknown', 'missing', false, '無法確認']);
  const proto = { competences: { X: { label: 'X', cert: 'constructor' } }, ladder: [] };
  assertEqual(badgeOf(proto, { id: 'T-3', certs: {} }, 'X', '2026-08-03').status, 'missing', '原型鍵不算持有');
});

/* K4 */
test('能力判定核心：臨床進階與通用分級——未達、未登錄、無法辨識都不算帶班，且各有說明', () => {
  const lad = (v) => badgeOf(K_CAT, { id: 'T-4', ladder: v, certs: {} }, 'SENIOR', '2026-08-03');
  const pick = (b) => [b.kind, b.status, b.counts, b.text];
  assertEqual(pick(lad('N3')), ['ladder', 'valid', true, '']);
  assertEqual(pick(lad('N2')), ['ladder', 'below', false, '臨床進階 N2 未達N3 以上帶班']);
  assertEqual(pick(lad(null)), ['ladder', 'unrated', false, '臨床進階未登錄']);
  assertEqual(pick(lad('n3')), ['ladder', 'invalid', false, '臨床進階登錄值「n3」無法辨識，視同未達N3 以上帶班'], '不轉大小寫');
  const scale = ['Lv1', 'Lv2', 'Lv3'];
  assertEqual([
    rankStatus('Lv2', scale, 'Lv2'), rankStatus('Lv1', scale, 'Lv2'), rankStatus(undefined, scale, 'Lv2'),
    rankStatus('Lv9', scale, 'Lv2'), rankStatus('Lv1', scale),
  ], ['meets', 'below', 'unrated', 'invalid', 'meets']);
  assertEqual(rankStatus('Lv3', scale, 'Lv9'), 'below', '門檻不在序列內：無人達標，不猜');
});

/* K5 */
test('能力判定核心：補位差異與後備深度——只篩不排；N-04 補得上帶班卻缺有效 ACLS', () => {
  const date = '2026-08-09';   // 與 LINE 缺班情境 GAP_P 同一格：8/09 白班，引擎前五名依序如下
  const ward = compileProfile(UNIT_PROFILE_DRAFTS['MED-3A']).profile;   // 編譯後的設定檔本身就是 catalog
  const needs = ward.demand.posts[0];                                     // 病房崗位＝一格的需求
  const people = ['N-04', 'N-02', 'N-08', 'N-10', 'N-01'].map(kStaff);
  const b = benchFor(ward, needs, [], people, date);
  assertEqual([b.depth, b.bench], [2, ['N-10', 'N-01']]);
  assertEqual(b.rows.map((r) => r.staffId), ['N-04', 'N-02', 'N-08', 'N-10', 'N-01'], 'rows 與輸入一一對應');
  const row = (id) => b.rows.find((r) => r.staffId === id);
  const n04 = row('N-04');
  assertEqual([n04.fills, n04.still, n04.lacks.map((x) => x.text), n04.restores],
    [['SENIOR'], [], ['ACLS已於 2026-06-30 過期'], false], 'N3 補得上帶班，但 ACLS 過期');
  ['N-02', 'N-08'].forEach((id) => {
    const r = row(id);
    assertEqual([r.fills, r.still, r.lacks, r.restores], [[], ['SENIOR'], [], false], `${id} 是 N2，補上後仍缺帶班`);
  });
  ['N-10', 'N-01'].forEach((id) => assertEqual(row(id).restores, true, `${id} 可完整補回`));
  assertEqual(benchFor(ward, needs, [], people.slice().reverse(), date).bench, ['N-01', 'N-10'],
    '只篩不排：輸入反轉，輸出跟著反轉');
  const covered = candidateDelta(ward, needs, [kStaff('N-10')], kStaff('N-02'), date);
  assertEqual([covered.fills, covered.still, covered.restores], [[], [], true], '班上已有 N4 帶班，N-02 補進即完整');
  assertEqual([0, 1, 2, 5].map((n) => benchLevel(n)), ['broken', 'thin', 'ok', 'ok']);
});

/* K6 */
test('能力判定核心：特護形狀測資——技術標籤 true 不算缺；nurse-tsai 的 ACLS 已過期，後備只剩 nurse-b', () => {
  const cat = {
    competences: {
      '呼吸器': { label: '呼吸器', cert: '呼吸器' },
      ACLS: { label: 'ACLS 高級心臟救命術', cert: 'ACLS 高級心臟救命術' },
    },
    ladder: [],
  };
  const tsai = { id: 'nurse-tsai', certs: { '呼吸器': true, '抽痰': true, '氧療照護': true, 'ACLS 高級心臟救命術': '2026-09-30' } };
  const nurseB = { id: 'nurse-b', certs: { '呼吸器': true, 'ACLS 高級心臟救命術': '2027-06-30' } };
  const b = benchFor(cat, { allMust: ['呼吸器', 'ACLS'], atLeast: [] }, [], [tsai, nurseB], '2026-10-05');
  assertEqual([b.depth, b.bench], [1, ['nurse-b']]);
  assertEqual(b.rows[0].lacks.map((x) => x.text), ['ACLS 高級心臟救命術已於 2026-09-30 過期']);
  assertEqual(b.rows[1].lacks, [], '呼吸器為 true（持有無效期），不列為缺');
});

/* K7 */
test('能力判定核心：與引擎能力徽章逐筆同判——示範週內科 3A 30 筆證照零差異', () => {
  const cap = platformEngine(null).capabilityAnalysis({ dates: WEEK_DATES, unit: 'MED-3A' });
  const mismatches = [];
  let compared = 0;
  cap.badges.forEach((bd) => {
    const person = kStaff(bd.id);
    bd.certs.forEach((c) => {
      compared += 1;
      const one = { competences: { [c.code]: { label: c.code, cert: c.code } }, ladder: [] };
      const st = badgeOf(one, person, c.code, '2026-08-03', { expiringDays: 90 }).status;
      if (st !== c.status) mismatches.push(`${bd.id} ${c.code}：核心 ${st}／引擎 ${c.status}`);
    });
  });
  assertEqual(compared, 30, '內科 3A 十人共 30 張證照');
  assertEqual(mismatches, []);
  const n04 = cap.badges.find((x) => x.id === 'N-04').certs.find((c) => c.code === 'ACLS');
  assertEqual(n04.status, 'expired', 'N-04 的 ACLS 於 2026-06-30 過期');
});

/* K8 */
test('能力判定核心：型別宣告契約——匯出名稱、版本字串、結果形狀與 competence.d.ts 一致（瀏覽器檢查全域介面）', () => {
  const surface = {
    COMPETENCE_KERNEL_VERSION: typeof COMPETENCE_KERNEL_VERSION,
    isIsoDate: typeof isIsoDate, rankStatus: typeof rankStatus, badgeOf: typeof badgeOf,
    candidateDelta: typeof candidateDelta, benchFor: typeof benchFor, benchLevel: typeof benchLevel,
  };
  assertEqual(surface, {
    COMPETENCE_KERNEL_VERSION: 'string',
    isIsoDate: 'function', rankStatus: 'function', badgeOf: 'function',
    candidateDelta: 'function', benchFor: 'function', benchLevel: 'function',
  }, '全域介面');
  assert(/^1[.][0-9]+[.][0-9]+$/.test(COMPETENCE_KERNEL_VERSION), `版本須為 1.x.y：${COMPETENCE_KERNEL_VERSION}`);
  if (typeof require !== 'function') return;   // 瀏覽器讀不到 .d.ts，全域介面檢查到此為止

  const kernel = require('../src/competence.js');
  const dts = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'competence.d.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const block = (re, what) => {
    const m = re.exec(dts);
    assert(m, `competence.d.ts 找不到 ${what}`);
    return m[1];
  };
  const members = (body) => body.split(/[;\n]/)
    .map((s) => /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*([(:])/.exec(s)).filter(Boolean)
    .map((m) => ({ name: m[1], fn: m[2] === '(' }));
  const names = (list) => list.map((x) => x.name).sort();
  const shape = (name) => names(members(block(new RegExp(`interface\\s+${name}\\s*\\{([^{}]*)\\}`), `interface ${name}`)));

  const declared = members(block(/declare\s+const\s+kernel\s*:\s*\{([^{}]*)\}/, 'declare const kernel'));
  assert(/export\s*=\s*kernel\s*;/.test(dts), 'competence.d.ts 須以 export = kernel 匯出');
  assertEqual(names(declared), Object.keys(kernel).sort(), '.d.ts 宣告與 module.exports 名稱一致');
  declared.forEach((x) => assertEqual(typeof kernel[x.name] === 'function', x.fn, `${x.name} 的宣告種類`));
  assertEqual(block(/COMPETENCE_KERNEL_VERSION\s*:\s*'([^']+)'/, '版本字串'), kernel.COMPETENCE_KERNEL_VERSION, '.d.ts 版本字串');

  const badgeKeys = shape('Badge');
  assertEqual(badgeKeys.length, 9, 'Badge 介面應有 9 個成員（防空跑）');
  const on = '2026-08-03';
  [
    kernel.badgeOf(K_CAT, K_PERSON, 'ACLS', on),
    kernel.badgeOf(K_CAT, K_PERSON, 'ACLS', '2026-09-01'),
    kernel.badgeOf(K_CAT, { id: 'T-8', certs: { ACLS: true } }, 'ACLS', on),
    kernel.badgeOf(K_CAT, { id: 'T-8', certs: { ACLS: '2026/1/5' } }, 'ACLS', on),
    kernel.badgeOf(K_CAT, K_PERSON, 'SENIOR', on),
    kernel.badgeOf(K_CAT, K_PERSON, 'PALS', on),
  ].forEach((b) => assertEqual(Object.keys(b).sort(), badgeKeys, `badgeOf（${b.kind}／${b.status}）的結果形狀`));
  const delta = kernel.candidateDelta(K_CAT, K_WARD_NEEDS, [], kStaff('N-04'), on);
  assertEqual(Object.keys(delta).sort(), shape('CandidateDelta'), 'candidateDelta 的結果形狀');
  assertEqual(Object.keys(delta.lacks[0]).sort(), badgeKeys, 'lacks 的每一筆是 Badge');
  const bench = kernel.benchFor(K_CAT, K_WARD_NEEDS, [], [kStaff('N-04')], on);
  assertEqual(Object.keys(bench).sort(), shape('Bench'), 'benchFor 的結果形狀');
});
