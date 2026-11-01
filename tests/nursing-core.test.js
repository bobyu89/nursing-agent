/**
 * nursing-core.test.js — 護理知識核心三模組：設定檔編譯、照護需求換算、能力覆蓋
 *
 * 測試只經過模組介面（compileProfile／careDemand／assessCoverage／diffCoverage／
 * rosterAssignments／rosterCoverage），情境為血液透析室與急診兩種相反的配置型態，
 * 加上內科 3A 一般病房（ward，data.js 的 UNIT_PROFILE_DRAFTS）對示範班表的帶班與資格覆蓋。
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

/* ── 一般病房（ward）：內科 3A 預設設定檔對示範班表的帶班與資格覆蓋 ── */

const wardProfile = () => ok(UNIT_PROFILE_DRAFTS['MED-3A']);
const wardWeek = (staff) => {
  const ward = wardProfile();
  return rosterCoverage(ward, careDemand(ward, { dates: WEEK_DATES }), SHIFTS, staff);
};

test('設定檔：內科 3A 一般病房（ward）走班別 × 崗位、指紋穩定；未知類型與 0 人保底皆退件', () => {
  const draft = UNIT_PROFILE_DRAFTS['MED-3A'];
  const r = compileProfile(draft);
  assertEqual([r.ok, r.profile.kind], [true, 'ward']);
  const ward = r.profile;
  assertEqual(ward.demand.shifts, [
    { id: 'D', label: '白班', start: '07:00', end: '15:00' },
    { id: 'E', label: '小夜', start: '15:00', end: '23:00' },
    { id: 'N', label: '大夜', start: '23:00', end: '07:00' },
  ], '班別取 SHIFT_TYPES');
  assertEqual(ward.demand.posts[0], {
    id: 'WARD', label: '病房', min: 1, visitsPerNurse: null,
    allMust: ['ACLS'], atLeast: [{ competence: 'SENIOR', min: 1 }],
  });
  assertEqual(ward.constraints.minRestHours, 11);
  assert(/^p-[0-9a-f]{8}$/.test(ward.fingerprint), ward.fingerprint);
  assertEqual(compileProfile(draft).profile.fingerprint, ward.fingerprint, '重新編譯，指紋不變');
  const kind = compileProfile({ ...draft, kind: 'homecare' });
  assertEqual([kind.problems[0].path, kind.problems[0].code], ['kind', 'P-KIND']);
  assert(kind.problems[0].message.includes('ward'), kind.problems[0].message);
  const zero = compileProfile({ ...draft, demand: { ...draft.demand, posts: [{ ...draft.demand.posts[0], min: 0 }] } });
  assert(codesOf(zero).includes('demand.posts.0.min:P-NUM'), JSON.stringify(zero.problems));
});

test('照護需求：一般病房每日三班各一格，大夜跨日，人數取設定檔保底', () => {
  const slots = careDemand(wardProfile(), { dates: WEEK_DATES });
  assertEqual(slots.length, 21, '7 天 × 3 班 × 1 崗位');
  const night = slots[2];
  assertEqual([night.id, night.start, night.end], ['2026-08-03|N|WARD', '2026-08-03T23:00', '2026-08-04T07:00']);
  assertEqual(night.headcount, { min: 1, source: 'baseline', basis: '設定檔保底 1 人' });
  assertEqual([night.allMust, night.atLeast], [['ACLS'], [{ competence: 'SENIOR', min: 1 }]]);
});

test('班表對應：他單位與範圍外日期略過；對不上設定檔的列附原因列出，不默默丟棄', () => {
  const ward = wardProfile();
  const odd = { staffId: 'N-03', date: '2026-08-03', shift: 'X', unit: 'MED-3A' };
  const r = rosterAssignments(ward, careDemand(ward, { dates: WEEK_DATES }), [
    { staffId: 'N-01', date: '2026-08-03', shift: 'D', unit: 'MED-3A' },
    { staffId: 'N-08', date: '2026-08-03', shift: 'D', unit: 'SUR-5B' },   // 他單位：不在本次範圍
    { staffId: 'N-02', date: '2026-09-01', shift: 'D', unit: 'MED-3A' },   // 範圍外日期
    odd,
  ]);
  assertEqual(r.assignments, [{ slotId: '2026-08-03|D|WARD', staffId: 'N-01' }], '單一崗位單位，列不必指明崗位');
  assertEqual(r.unmapped, [{ row: odd, reason: '設定檔無此班別' }]);
  assert(r.unmapped[0].row === odd, '列出原列本身');

  const er = ok(ER_DRAFT);
  const erSlots = careDemand(er, { dates: [MON] });
  const resus = { staffId: 'E-01', date: MON, shift: 'D', unit: 'ER', post: 'RESUS' };
  assertEqual(rosterAssignments(er, erSlots, [resus]).assignments, [{ slotId: `${MON}|D|RESUS`, staffId: 'E-01' }]);
  const noPost = { staffId: 'E-01', date: MON, shift: 'D', unit: 'ER' };
  assertEqual(rosterAssignments(er, erSlots, [noPost]), { assignments: [], unmapped: [{ row: noPost, reason: '多崗位單位須指明崗位' }] });
  const badPost = { ...resus, post: 'ICU' };
  assertEqual(rosterAssignments(er, erSlots, [badPost]).unmapped, [{ row: badPost, reason: '設定檔無此崗位' }]);
  const hd = ok(HD_DRAFT);
  const pm = { staffId: 'H-01', date: MON, shift: 'PM', unit: 'HD-1', post: 'GEN' };
  const hdSlots = careDemand(hd, { dates: [MON], bookings: { [MON]: { PM: { GEN: 0, HBV: 0 } } } });
  assertEqual(rosterAssignments(hd, hdSlots, [pm]).unmapped, [{ row: pm, reason: '該日此格無照護需求' }], '午場無病人，不需人力');
});

test('班表覆蓋：示範週內科 3A 只計有排人的 16 班——11 班缺 N3 以上帶班，8/04 白班 N-04 的 ACLS 已過期', () => {
  const r = wardWeek(STAFF);
  assertEqual(r.unmapped, []);
  const t = r.tally;
  assertEqual([t.profile, t.slots, t.staffed, t.empty, t.conflict, t.unrated], [wardProfile().fingerprint, 21, 16, 5, 0, []]);
  assertEqual(t.atLeast.SENIOR, [
    '2026-08-04|E|WARD', '2026-08-04|N|WARD', '2026-08-05|D|WARD', '2026-08-05|E|WARD', '2026-08-05|N|WARD',
    '2026-08-06|E|WARD', '2026-08-07|E|WARD', '2026-08-07|N|WARD', '2026-08-08|E|WARD', '2026-08-08|N|WARD',
    '2026-08-09|E|WARD',
  ]);
  assertEqual(t.allMust.ACLS, [{ slotId: '2026-08-04|D|WARD', staffId: 'N-04' }]);
  assertEqual(r.summary, { met: 4, short: 17, conflict: 0, shortBySource: { baseline: 17 }, fragile: 15 },
    'summary 照舊逐格計（空班的人數缺口也在內）；帶班計數另看 tally');
  const empty = r.slots.filter((s) => !s.assigned.length).map((s) => s.slotId);
  assertEqual(empty, ['2026-08-03|E|WARD', '2026-08-03|N|WARD', '2026-08-06|N|WARD', '2026-08-09|D|WARD', '2026-08-09|N|WARD']);
  assert(empty.every((id) => !t.atLeast.SENIOR.includes(id)), '空班（如 8/06 大夜）是人數缺口，不算帶班缺口');
});

test('班表覆蓋：帶班缺口與引擎能力分析逐班同判——示範週 11 班、8 月整月 54 班（有排人 85 班）', () => {
  const ward = wardProfile();
  const aug = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
  const counts = [WEEK_DATES, aug].map((dates) => {
    const t = rosterCoverage(ward, careDemand(ward, { dates }), SHIFTS, STAFF).tally;
    const mine = t.atLeast.SENIOR.map((id) => id.split('|').slice(0, 2).join('|'));
    const engine = platformEngine(null).capabilityAnalysis({ dates, unit: 'MED-3A' }).shiftMix
      .filter((m) => !m.empty && !m.hasSenior)
      .map((m) => `${m.date}|${m.shift}`);
    assertEqual(mine, engine, `${dates[0]} 起 ${dates.length} 天：覆蓋檢核與引擎 shiftMix 應逐班一致`);
    return [mine.length, t.staffed];
  });
  assertEqual(counts, [[11, 16], [54, 85]]);
});

test('能力覆蓋：效期無法判讀 fail closed——寫出原值、視同未具備，不再以字串比較放行', () => {
  const ward = wardProfile();
  const x1 = { id: 'X-01', ladder: 'N2', certs: { ACLS: '2026/1/5' } };
  const r = assessCoverage(ward, careDemand(ward, { dates: ['2026-08-03'] }), [
    { slotId: '2026-08-03|D|WARD', staffId: 'N-01' },
    { slotId: '2026-08-03|D|WARD', staffId: 'X-01' },
  ], STAFF.concat([x1]));
  const day = r.slots.find((s) => s.slotId === '2026-08-03|D|WARD');
  assertEqual(day.status, 'short', '舊版以字串比較，「2026/1/5」排在「2026-08-03」之後而被判為 met');
  const all = day.issues.filter((i) => i.code === 'C-ALL');
  assertEqual(all.map((i) => i.staffId), ['X-01']);
  assert(all[0].text.includes('ACLS效期「2026/1/5」無法判讀，視同未具備'), all[0].text);

  const er = ok(ER_DRAFT);
  const x2 = { id: 'X-02', ladder: 'N2', certs: { ACLS: '2027/5/31' } };
  const er2 = assessCoverage(er, careDemand(er, { dates: [MON] }), [
    { slotId: `${MON}|D|RESUS`, staffId: 'E-01' },
    { slotId: `${MON}|D|RESUS`, staffId: 'X-02' },
  ], NURSES.concat([x2]));
  const resus = er2.slots.find((s) => s.slotId === `${MON}|D|RESUS`);
  assertEqual(resus.issues.map((i) => [i.code, i.short]), [['C-ATLEAST', 1]], 'X-02 的 ACLS 無法判讀，不算在具備者內');
});

test('班表覆蓋：臨床進階未登錄者不計為帶班且被點名——N-10 未登錄時，示範週缺口由 11 班變 13 班', () => {
  const staff = STAFF.map((s) => (s.id === 'N-10' ? { ...s, ladder: null } : s));
  const t = wardWeek(staff).tally;
  assertEqual(t.unrated, ['N-10']);
  assertEqual(t.atLeast.SENIOR.length, 13);
  assert(['2026-08-07|D|WARD', '2026-08-08|D|WARD'].every((id) => t.atLeast.SENIOR.includes(id)),
    'N-10 在 8/07、8/08 白班，未登錄即不算帶班');
  assertEqual(STAFF.find((s) => s.id === 'N-10').ladder, 'N4', '測試用副本，不改示範資料');
});
