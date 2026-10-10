/**
 * nursing-core.test.js — 護理知識核心三模組：設定檔編譯、照護需求換算、能力覆蓋
 *
 * 測試只經過模組介面（compileProfile／careDemand／assessCoverage／diffCoverage），
 * 情境為血液透析室與急診兩種相反的配置型態。
 */

const HD_DRAFT = {
  unit: 'HD-1', kind: 'hemodialysis', label: '血液透析室',
  competences: {
    HD: { label: '透析護理資格', cert: 'HD' },
    SENIOR: { label: 'N3 以上', ladderAtLeast: 'N3' },
  },
  demand: {
    patientsPerNurse: 4,
    sessions: [
      { id: 'AM', label: '早場', start: '07:00', end: '12:00' },
      { id: 'PM', label: '午場', start: '12:30', end: '17:30' },
    ],
    areas: [
      { id: 'GEN', label: '一般區', stations: 20, allMust: ['HD'], atLeast: [{ competence: 'SENIOR', min: 1 }] },
      { id: 'HBV', label: 'B 肝隔離區', stations: 2, allMust: ['HD'] },
    ],
  },
  constraints: { minRestHours: 12 },
  accountability: { approveSubstitution: 'head', publishRoster: 'head', grantException: 'exec' },
};

const ER_DRAFT = {
  unit: 'ER', kind: 'emergency', label: '急診',
  competences: {
    TRIAGE: { label: '五級檢傷訓練', cert: 'TTAS' },
    ACLS: { label: '高級心臟救命術', cert: 'ACLS' },
  },
  demand: {
    shifts: [
      { id: 'D', label: '白班', start: '08:00', end: '20:00' },
      { id: 'N', label: '夜班', start: '20:00', end: '08:00' },
    ],
    posts: [
      { id: 'TRIAGE', label: '檢傷', min: 1, allMust: ['TRIAGE'] },
      { id: 'RESUS', label: '急救區', min: 2, atLeast: [{ competence: 'ACLS', min: 2 }] },
      { id: 'MED', label: '內科區', min: 2, visitsPerNurse: 6 },
    ],
  },
};

const NURSES = [
  { id: 'H-01', ladder: 'N3', certs: { HD: '2027-12-31' } },
  { id: 'H-02', ladder: 'N2', certs: { HD: '2027-06-30' } },
  { id: 'H-03', ladder: 'N2', certs: { HD: '2026-09-30' } },   // 透析資格已過期
  { id: 'H-04', ladder: 'N1', certs: { HD: '2028-01-31' } },
  { id: 'H-05', ladder: 'N2', certs: { HD: '2027-03-31' } },
  { id: 'H-06', ladder: 'N2', certs: { HD: '2027-08-31' } },
  { id: 'E-01', ladder: 'N3', certs: { TTAS: '2027-05-31', ACLS: '2027-05-31' } },
  { id: 'E-02', ladder: 'N2', certs: { ACLS: '2027-01-31' } },
  { id: 'E-03', ladder: 'N2', certs: { ACLS: '2026-08-31' } },   // ACLS 已過期
  { id: 'E-04', ladder: 'N1', certs: {} },
];

const MON = '2026-10-12';   // 週一
const SUN = '2026-10-11';   // 週日
const ok = (draft) => {
  const r = compileProfile(draft);
  assert(r.ok, `設定檔應通過：${JSON.stringify(r.problems)}`);
  return r.profile;
};
const codesOf = (r) => r.problems.map((p) => `${p.path}:${p.code}`);

/* ── compileProfile ── */

test('設定檔：透析室與急診皆可編譯，未填限制沿用全院底線', () => {
  const hd = ok(HD_DRAFT);
  const er = ok(ER_DRAFT);
  assertEqual(hd.constraints, { minRestHours: 12, maxConsecutiveDays: 6, maxWeeklyHours: 48 });
  assertEqual(er.constraints.minRestHours, 11);
  assert(Object.isFrozen(hd) && Object.isFrozen(hd.demand.areas[0]), '設定檔應深度凍結，下游不能偷改');
});

test('設定檔：指紋與鍵順序無關，內容一改就變', () => {
  const a = ok(HD_DRAFT).fingerprint;
  const reordered = { accountability: HD_DRAFT.accountability, constraints: HD_DRAFT.constraints, demand: HD_DRAFT.demand,
    competences: HD_DRAFT.competences, label: HD_DRAFT.label, kind: HD_DRAFT.kind, unit: HD_DRAFT.unit };
  assertEqual(ok(reordered).fingerprint, a);
  const tighter = { ...HD_DRAFT, demand: { ...HD_DRAFT.demand, patientsPerNurse: 3 } };
  assert(ok(tighter).fingerprint !== a, '每人床數改變，指紋應改變');
});

test('設定檔：單位只能比全院底線嚴，放寬即退件並指出欄位', () => {
  const loose = {
    ...HD_DRAFT,
    demand: { ...HD_DRAFT.demand, patientsPerNurse: 5 },
    constraints: { minRestHours: 8, maxConsecutiveDays: 7 },
  };
  const r = compileProfile(loose);
  assertEqual(r.ok, false);
  assertEqual(r.profile, null, '未通過的草稿不產生設定檔');
  assertEqual(codesOf(r), [
    'constraints.minRestHours:P-LOOSER',
    'constraints.maxConsecutiveDays:P-LOOSER',
    'demand.patientsPerNurse:P-LOOSER',
  ]);
});

test('設定檔：未定義的能力、一般護理人員核准、重複代碼皆退件', () => {
  const r = compileProfile({
    ...ER_DRAFT,
    demand: {
      ...ER_DRAFT.demand,
      posts: [...ER_DRAFT.demand.posts, { id: 'TRIAGE', label: '重複', min: 1, allMust: ['PALS'] }],
    },
    accountability: { approveSubstitution: 'nurse' },
  });
  assertEqual(codesOf(r), [
    'accountability.approveSubstitution:P-ROLE',
    'demand.posts.3.id:P-DUP',
    'demand.posts.3.allMust.0:P-UNKNOWN-COMPETENCE',
  ]);
});

/* ── careDemand ── */

test('照護需求：透析依預約換算，未提供預約以床數上限估並標為假設', () => {
  const hd = ok(HD_DRAFT);
  const slots = careDemand(hd, {
    dates: [SUN, MON],
    bookings: { [MON]: { AM: { GEN: 18, HBV: 2 }, PM: { HBV: 0 } } },
  });
  assertEqual(slots.map((s) => s.id), [`${MON}|AM|GEN`, `${MON}|AM|HBV`, `${MON}|PM|GEN`], '週日不開場；午場隔離區 0 人不需人力');
  const [amGen, amHbv, pmGen] = slots;
  assertEqual([amGen.headcount.min, amGen.headcount.source], [5, 'known'], '18 人 ÷ 4 = 5 人');
  assertEqual([amHbv.headcount.min, amHbv.headcount.source], [1, 'known']);
  assertEqual([pmGen.headcount.min, pmGen.headcount.source], [5, 'assumed'], '缺預約以 20 床估');
  assertEqual(amGen.allMust, ['HD']);
  assertEqual(amGen.profile, hd.fingerprint, '每格記得自己依據哪一版設定檔');
});

test('照護需求：急診預測高於保底時採預測，夜班跨日', () => {
  const er = ok(ER_DRAFT);
  const slots = careDemand(er, { dates: [MON], forecast: { [MON]: { D: { MED: 20 }, N: { MED: 9 } } } });
  const get = (id) => slots.find((s) => s.id === `${MON}|${id}`);
  assertEqual([get('D|MED').headcount.min, get('D|MED').headcount.source], [4, 'forecast'], '20 ÷ 6 → 4 人，高於保底 2');
  assertEqual([get('N|MED').headcount.min, get('N|MED').headcount.source], [2, 'baseline'], '9 ÷ 6 → 2 人，不高於保底');
  assertEqual(get('N|TRIAGE').end, '2026-10-13T08:00');
  assertEqual(slots.length, 6);
});

/* ── assessCoverage／diffCoverage ── */

test('能力覆蓋：人數到齊但有人資格過期，仍判定不足並說明原因', () => {
  const hd = ok(HD_DRAFT);
  const slots = careDemand(hd, { dates: [MON], bookings: { [MON]: { AM: { GEN: 18, HBV: 2 }, PM: { GEN: 0, HBV: 0 } } } });
  const assignments = [
    ...['H-01', 'H-02', 'H-03', 'H-04', 'H-05'].map((id) => ({ slotId: `${MON}|AM|GEN`, staffId: id })),
    { slotId: `${MON}|AM|HBV`, staffId: 'H-06' },
  ];
  const r = assessCoverage(hd, slots, assignments, NURSES);
  const gen = r.slots.find((s) => s.slotId === `${MON}|AM|GEN`);
  assertEqual(gen.status, 'short');
  assertEqual(gen.issues.map((i) => i.code), ['C-ALL'], '5 人到齊，人數不缺');
  assert(gen.issues[0].text.includes('2026-09-30 過期'), gen.issues[0].text);
  assertEqual(gen.fragile, [{ competence: 'SENIOR', staffId: 'H-01' }], '只有 H-01 是 N3，屬單點');
  const hbv = r.slots.find((s) => s.slotId === `${MON}|AM|HBV`);
  assertEqual(hbv.status, 'met');
  assertEqual(hbv.fragile, [{ competence: 'HD', staffId: 'H-06' }]);
  assertEqual(r.summary.short, 1);
});

test('能力覆蓋：重疊時段與休息不足各自標出', () => {
  const er = ok(ER_DRAFT);
  const slots = careDemand(er, { dates: [MON, '2026-10-13'] });
  const r = assessCoverage(er, slots, [
    { slotId: `${MON}|D|TRIAGE`, staffId: 'E-01' },
    { slotId: `${MON}|D|RESUS`, staffId: 'E-01' },          // 同一時段兩個崗位
    { slotId: `${MON}|N|MED`, staffId: 'E-02' },
    { slotId: '2026-10-13|D|MED', staffId: 'E-02' },        // 夜班下班直接上白班
    { slotId: `${MON}|D|MED`, staffId: 'X-99' },            // 名單外代號
  ], NURSES);
  const codes = (id) => r.slots.find((s) => s.slotId === id).issues.map((i) => i.code);
  assert(codes(`${MON}|D|RESUS`).includes('C-DOUBLE'), '重疊時段應標在較晚的格');
  assert(codes('2026-10-13|D|MED').includes('C-REST'), '休息 0 小時應標出');
  assert(codes(`${MON}|D|MED`).includes('C-STAFF'));
  assertEqual(r.slots.find((s) => s.slotId === `${MON}|D|RESUS`).status, 'conflict');
});

test('能力覆蓋：缺口依需求來源分類，預測缺口與確定缺口分開計', () => {
  const er = ok(ER_DRAFT);
  const slots = careDemand(er, { dates: [MON], forecast: { [MON]: { D: { MED: 20 } } } });
  const r = assessCoverage(er, slots, [
    { slotId: `${MON}|D|TRIAGE`, staffId: 'E-04' },          // 無檢傷訓練
    { slotId: `${MON}|D|RESUS`, staffId: 'E-02' },
    { slotId: `${MON}|D|RESUS`, staffId: 'E-03' },          // ACLS 過期，只算 1 位
    { slotId: `${MON}|D|MED`, staffId: 'E-01' },
    { slotId: `${MON}|D|MED`, staffId: 'H-02' },
  ], NURSES);
  const resus = r.slots.find((s) => s.slotId === `${MON}|D|RESUS`);
  assertEqual(resus.issues.map((i) => [i.code, i.short]), [['C-ATLEAST', 1]]);
  const med = r.slots.find((s) => s.slotId === `${MON}|D|MED`);
  assertEqual(med.issues.map((i) => [i.code, i.source]), [['C-HEAD', 'forecast']], '依預測需 4 人、在班 2 人');
  assertEqual(r.summary.shortBySource, { baseline: 5, forecast: 1 }, '白班檢傷、急救區加上夜班三格無人，皆為保底缺口');
});

test('變更漣漪：把隔離區唯一的人借去一般區，一般區補好、隔離區破線', () => {
  const hd = ok(HD_DRAFT);
  const slots = careDemand(hd, { dates: [MON], bookings: { [MON]: { AM: { GEN: 18, HBV: 2 }, PM: { GEN: 0, HBV: 0 } } } });
  const base = ['H-01', 'H-02', 'H-04', 'H-05'].map((id) => ({ slotId: `${MON}|AM|GEN`, staffId: id }));
  const before = assessCoverage(hd, slots, [...base, { slotId: `${MON}|AM|HBV`, staffId: 'H-06' }], NURSES);
  const after = assessCoverage(hd, slots, [...base, { slotId: `${MON}|AM|GEN`, staffId: 'H-06' }], NURSES);
  assertEqual(diffCoverage(before, after), { broke: [`${MON}|AM|HBV`], fixed: [`${MON}|AM|GEN`] });
});
