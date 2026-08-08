/**
 * engine.test.js — 確定性引擎的邊界條件測試
 *
 * 這些測試釘住的是「合規事故等級」的計算：
 * 班間休息 11 小時、連續上班 6 天、週工時上限、大夜跨日、自然週歸屬。
 * 引擎的任何修改若動搖這些邊界，測試會立刻變紅。
 */

/* ── 測試用資料工廠 ── */

function mkStaff(id, over = {}) {
  return Object.assign({
    id, role: '護理師', unit: 'MED-3A',
    certs: { ACLS: '2030-12-31', CHEMO: '2030-12-31' },
    willingShifts: ['D'], familiarUnits: ['MED-3A'],
    standbyCount30d: 0, leaves: [],
  }, over);
}

function mkGap(over = {}) {
  return Object.assign({
    date: '2026-08-09', shift: 'D', unit: 'MED-3A',
    requiredRole: '護理師', requiredCerts: ['ACLS', 'CHEMO'],
    originalStaffId: null,
  }, over);
}

function mkEngine(staff, shifts, over = {}) {
  return createEngine(Object.assign({
    staff, shifts,
    shiftTypes: SHIFT_TYPES, roleLevels: ROLE_LEVELS,
    certs: CERTS, units: UNITS,
    registry: structuredClone(RULE_REGISTRY),
  }, over));
}

function d(staffId, date, shift = 'D', unit = 'MED-3A') {
  return { staffId, date, shift, unit };
}

/* ── 自然週 ── */

test('自然週：週日歸屬其所在週（週一起算），跨週日期歸屬下一週', () => {
  const w1 = weekDatesOf('2026-08-09');            // 週日
  assertEqual(w1[0], '2026-08-03', '8/09（日）的週應從 8/03（一）起算');
  assertEqual(w1[6], '2026-08-09');
  assertEqual(w1.length, 7);
  const w2 = weekDatesOf('2026-08-19');            // 下下週三
  assertEqual(w2[0], '2026-08-17', '8/19（三）的週應從 8/17（一）起算');
  assertEqual(w2[6], '2026-08-23');
});

test('週工時以缺班日所在自然週計，不綁定示範資料那一週（跨週回歸測試）', () => {
  const A = mkStaff('A');
  const shifts = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
    .map((day) => d('A', day));
  const e = mkEngine([A], shifts);
  assertEqual(e.weeklyHours('A', '2026-08-09'), 40, '本週已排 5 班應為 40 小時');
  assertEqual(e.weeklyHours('A', '2026-08-19'), 0, '下下週缺班時，本週的 40 小時不得被計入');
});

test('H6 週工時：只看缺班日當週——同樣的人，本週缺班超標、下週缺班就不超標', () => {
  const A = mkStaff('A');
  const shifts = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
    .map((day) => d('A', day));
  const reg = structuredClone(RULE_REGISTRY);
  reg.hard.find((r) => r.code === 'H6').param.value = 45;   // 壓低上限以觸發邊界

  const e = mkEngine([A], shifts, { registry: reg });
  const thisWeek = e.checkHardConstraints(A, mkGap({ date: '2026-08-09' }));
  assertEqual(thisWeek.map((v) => v.code), ['H6'], '本週缺班：40+8=48 > 45，應觸發 H6');
  const nextWeek = e.checkHardConstraints(A, mkGap({ date: '2026-08-19' }));
  assertEqual(nextWeek, [], '下下週缺班：當週工時 0+8=8，不應觸發任何違規');
});

/* ── H4 班間休息 ── */

test('H4 大夜接白班（N-07 情境）：前日大夜 07:00 下班、白班 07:00 開始 → 間隔 0 小時', () => {
  const A = mkStaff('A', { willingShifts: ['N'] });
  const e = mkEngine([A], [d('A', '2026-08-08', 'N')]);
  assertEqual(e.minRestAfterGap('A', '2026-08-09', 'D').hours, 0);
  const codes = e.checkHardConstraints(A, mkGap()).map((v) => v.code);
  assert(codes.includes('H4'), `應觸發 H4，實際：${codes.join(',') || '（無）'}`);
});

test('H4 邊界：班間休息剛好 11 小時應通過，10.5 小時應排除', () => {
  const types = {
    D: SHIFT_TYPES.D,
    L8: { code: 'L8', name: '測試班（20:00 下班）', start: '12:00', end: '20:00', hours: 8, overnight: false },
    L9: { code: 'L9', name: '測試班（20:30 下班）', start: '12:30', end: '20:30', hours: 8, overnight: false },
  };
  const A = mkStaff('A');
  const exact = mkEngine([A], [d('A', '2026-08-03', 'L8')], { shiftTypes: types });
  assertEqual(exact.checkHardConstraints(A, mkGap({ date: '2026-08-04' })), [],
    '20:00 下班 → 隔日 07:00 上班 = 11 小時整，法規門檻為「≥ 11」，應通過');
  const under = mkEngine([A], [d('A', '2026-08-03', 'L9')], { shiftTypes: types });
  assertEqual(under.checkHardConstraints(A, mkGap({ date: '2026-08-04' })).map((v) => v.code), ['H4'],
    '20:30 下班 → 10.5 小時，應觸發 H4');
});

/* ── H5 連續上班 ── */

test('H5 邊界：替補後連 6 天應通過，連 7 天應排除', () => {
  const A = mkStaff('A');
  const five = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'].map((day) => d('A', day));
  assertEqual(mkEngine([A], five).checkHardConstraints(A, mkGap()), [],
    '連 5 天 + 缺班日 = 6 天，恰在上限內，應通過');
  const six = [d('A', '2026-08-03'), ...five];
  assertEqual(mkEngine([A], six).checkHardConstraints(A, mkGap()).map((v) => v.code), ['H5'],
    '連 6 天 + 缺班日 = 7 天（N-09 情境），應觸發 H5');
});

/* ── 軟性評分 ── */

test('S1 公平性：0 次代班得滿分，達飽和門檻（5 次）得 0 分', () => {
  const gap = mkGap();
  const fresh = mkEngine([mkStaff('A')], []);
  const s1a = fresh.scoreCandidate(mkStaff('A'), gap).breakdown.find((b) => b.code === 'S1');
  assertEqual(s1a.points, s1a.weight, '0 次代班應得 S1 滿分');
  const s1b = fresh.scoreCandidate(mkStaff('B', { standbyCount30d: 5 }), gap).breakdown.find((b) => b.code === 'S1');
  assertEqual(s1b.points, 0, '5 次代班（飽和）應得 0 分');
});

/* ── 完整 demo 情境（守住上場那一幕）── */

test('Demo 資料集：4 位合格候選（N-02 > N-08 > N-10 > N-01）、7 位排除且原因正確', () => {
  const e = mkEngine(STAFF, SHIFTS.slice());
  const ev = e.evaluateGap(GAP_EVENT);
  assertEqual(ev.candidates.map((c) => c.staff.id), ['N-02', 'N-08', 'N-10', 'N-01'],
    '合格候選人與排序');
  assertEqual(ev.excluded.length, 7);
  const why = Object.fromEntries(ev.excluded.map((x) => [x.staff.id, x.violations.map((v) => v.code)]));
  assert(why['N-07'].includes('H4'), 'N-07 應因班間休息不足（H4）被排除');
  assert(why['N-09'].includes('H5'), 'N-09 應因連續上班（H5）被排除');
  assert(why['N-04'].includes('H1'), 'N-04 應因 ACLS 過期（H1）被排除');
  assert(why['N-03'].includes('H1'), 'N-03 應因缺化療資格（H1）被排除');
  assert(why['N-06'].includes('H2'), 'N-06 應因當日已排班（H2）被排除');
  assert(why['N-11'].includes('H3'), 'N-11 應因特休（H3）被排除');
  assertEqual(why['N-05'][0], '—', 'N-05 為原班人員');
});

/* ── 寫回與治理迴路 ── */

test('applyReplacement 寫回：替補次數 +1，且同日第二筆缺班會被 H2 自動排除', () => {
  const A = mkStaff('A');
  const e = mkEngine([A], []);
  const gap = mkGap();
  assertEqual(e.evaluateGap(gap).candidates.length, 1, '寫回前應為合格候選');
  e.applyReplacement(gap, 'A');
  assertEqual(A.standbyCount30d, 1, '替補次數應累計');
  const again = e.evaluateGap(mkGap({ shift: 'E' }));
  assertEqual(again.candidates.length, 0);
  assert(again.excluded[0].violations.some((v) => v.code === 'H2'),
    '同日第二筆缺班應因「當日已排班」（H2）被排除');
});

test('relaxationAnalysis：只試算、不改動規則庫，並正確找出鬆綁後可多出的人', () => {
  const A = mkStaff('A', { leaves: [{ from: '2026-08-09', to: '2026-08-10', type: '事假' }] });
  const e = mkEngine([A], []);
  const gap = mkGap();
  const opts = e.relaxationAnalysis(gap);
  const h3 = opts.find((o) => o.code === 'H3');
  assert(h3, '應提出「放寬 H3 請假限制」的選項');
  assertEqual(h3.unlocked, ['A']);
  assertEqual(h3.relax.allowed, true, 'H3 屬可由主管徵詢意願的選項');
  assertEqual(e.evaluateGap(gap).candidates.length, 0, '試算結束後規則應復原，A 仍被排除');
});

/* ── 多筆缺班指派 ── */

test('多筆缺班：逐筆貪心把稀缺人力用掉，全局指派兩筆都補得上', () => {
  const e = mkEngine(STAFF, SHIFTS.slice(), { staffingMin: UNIT_MIN_STAFF });
  const greedy = e.assignGreedy(MULTI_GAP_SCENARIO);
  assertEqual(greedy[0].staffId, 'N-10',
    '逐筆指派第一筆選當下分數較高的 N-10（69.5 > N-01 的 63.5）');
  assertEqual(greedy[1].staffId, null,
    'N-10 是全院唯一具呼吸器資格者，被第一筆用掉後 ICU 缺班無人可派');
  const joint = e.assignJointly(MULTI_GAP_SCENARIO);
  assertEqual(joint.filled, 2, '全局指派應兩筆都補得上');
  assertEqual(joint.assignment, ['N-01', 'N-10'],
    '第一筆改用 N-01，把 N-10 留給只有他能補的 ICU');
});

test('多筆缺班：同一人接兩筆的班距／同日衝突在模擬中被正確擋下', () => {
  const A = mkStaff('A');
  const gaps = [mkGap({ shift: 'D' }), mkGap({ shift: 'E' })];  // 同日白班＋小夜
  const e = mkEngine([A], []);
  const joint = e.assignJointly(gaps);
  assertEqual(joint.filled, 1,
    '只有一個人時，同日兩班（H2）不可同時指派，最多補一筆');
  const greedy = e.assignGreedy(gaps);
  assertEqual(greedy.filter((s) => s.staffId).length, 1);
});

/* ── 主動預警 ── */

test('主動預警：demo 班表掃出 N-09 連六天達上限與 48 小時軟性上限，且無「已違規」項', () => {
  const e = mkEngine(STAFF, SHIFTS.slice(), { staffingMin: UNIT_MIN_STAFF });
  const ws = e.rosterWarnings();
  const n09 = ws.filter((w) => w.staffId === 'N-09').map((w) => w.code).sort();
  assert(n09.includes('H5'), 'N-09 已排連續 6 天，應出現 H5 達上限預警');
  assert(n09.includes('F1'), 'N-09 當週已排 48 小時，應出現軟性上限預警');
  assert(ws.some((w) => w.staffId === 'N-01' && w.code === 'S1'),
    'N-01 已被叫班 4 次，應出現接近公平性飽和預警');
  assertEqual(ws.filter((w) => w.level === 'high').length, 0,
    'demo 班表本身合法，不應有「已違規」等級的預警');
});

test('主動預警：排出小夜接白班的班表時，H4 違規要在掃描中現形', () => {
  const A = mkStaff('A');
  const e = mkEngine([A], [d('A', '2026-08-03', 'E'), d('A', '2026-08-04', 'D')]);
  const ws = e.rosterWarnings();
  const h4 = ws.find((w) => w.code === 'H4');
  assert(h4 && h4.level === 'high', '23:00 下班接翌日 07:00 上班（8 小時）應為已違規等級');
});

test('配置缺口掃描：低於最低配置的時段被列出，無資料單位回報 noData', () => {
  const A = mkStaff('A');
  const shifts = [d('A', '2026-08-03', 'D')];
  const e = mkEngine([A], shifts, {
    staffingMin: { 'MED-3A': { D: 1 }, 'ICU': { D: 1 } },
  });
  const gaps = e.coverageGaps(['2026-08-03', '2026-08-04']);
  assert(gaps.some((g) => g.unit === 'ICU' && g.noData), 'ICU 無排班資料應回報 noData');
  const med = gaps.filter((g) => g.unit === 'MED-3A' && !g.noData);
  assertEqual(med.map((g) => g.date), ['2026-08-04'],
    '8/03 白班有 1 人達配置；8/04 無人在班應列為缺口');
});

/* ── 訊息日期解析（mock 模式）── */

test('日期解析：以通報日 2026-08-08（六）推算「禮拜天／明天／下禮拜三／8/9」', () => {
  const ref = '2026-08-08';
  assertEqual(parseDateFromText('禮拜天的早班沒辦法上', ref).value, '2026-08-09');
  assertEqual(parseDateFromText('明天不能來', ref).value, '2026-08-09');
  assertEqual(parseDateFromText('我下禮拜三大夜要去進修', ref).value, '2026-08-19',
    'README 的示範句「下週三」必須解析為 8/19');
  assertEqual(parseDateFromText('下下禮拜三要考試', ref).value, '2026-08-26',
    '「下下禮拜三」是再往後一週，不得被解析成下禮拜三');
  assertEqual(parseDateFromText('8/9 的班', ref).value, '2026-08-09');
  assertEqual(parseDateFromText('我不能上班了', ref), null, '沒有時間線索時不得臆測日期');
});

test('日期解析：多個時間線索指向不同日期時不臆測，標記為模糊並轉為追問', async () => {
  const ref = '2026-08-08';
  const amb = parseDateFromText('我從今天開始發燒，禮拜天的早班沒辦法上', ref);
  assert(amb && amb.ambiguous === true,
    '「今天」（8/08）與「禮拜天」（8/09）並存，Agent 不得自行挑一個');
  assertEqual(parseDateFromText('今天的班沒辦法上', ref).value, '2026-08-08',
    '單一線索「今天」仍正常解析');
  assertEqual(parseDateFromText('明天，也就是禮拜天的班沒辦法上', ref).value, '2026-08-09',
    '多個線索指向同一天時不算模糊');

  const parsed = await llmParseGapMessage('我從今天開始發燒，禮拜天的早班沒辦法上了');
  assertEqual(parsed.extracted.date.value, null, '模糊日期不得填入解析結果');
  assert(parsed.missing.some((m) => m.field === 'date'), '模糊日期應轉為追問');
});

test('S3 遇到自訂班別代碼不得產生 NaN', () => {
  const types = Object.assign({}, SHIFT_TYPES, {
    X: { code: 'X', name: '自訂班', start: '08:00', end: '16:00', hours: 8, overnight: false },
  });
  const A = mkStaff('A');
  const e = mkEngine([A], [d('A', '2026-08-05', 'X')], { shiftTypes: types });
  const s3 = e.scoreCandidate(A, mkGap()).breakdown.find((b) => b.code === 'S3');
  assert(Number.isFinite(s3.points), `S3 分數應為有限數字，實際：${s3.points}`);
  assertEqual(s3.points, 0, '當週僅有自訂班、無白班，S3 相符度應為 0 分');
});

test('訊息解析（async）：「我不能上班了」四項關鍵欄位全數轉為追問', async () => {
  const parsed = await llmParseGapMessage('我不能上班了');
  assertEqual(parsed.missing.map((m) => m.field).sort(),
    ['date', 'requiredCerts', 'shift', 'unit'],
    '日期／班別／單位／資格皆未載明，應全部追問而非臆測');
});

test('unitCoverage：計算缺班班別的單位當班人力與最低配置比對', () => {
  const A = mkStaff('A');
  const shifts = [
    d('B', '2026-08-09', 'E'),            // 同單位同日小夜 1 人
    d('C', '2026-08-09', 'D', 'SUR-5B'),  // 他單位，不得計入
  ];
  const e = mkEngine([A], shifts, {
    staffingMin: { 'MED-3A': { D: 1, E: 2, N: 1 } },
  });
  const dCov = e.unitCoverage(mkGap());
  assertEqual([dCov.current, dCov.afterReplacement, dCov.min], [0, 1, 1],
    '白班目前 0 人、替補後 1 人，達最低配置 1 人');
  const eCov = e.unitCoverage(mkGap({ shift: 'E' }));
  assertEqual([eCov.current, eCov.afterReplacement, eCov.min], [1, 2, 2],
    '小夜已有 1 人、替補後 2 人，恰達配置 2 人');
  const noMin = mkEngine([A], [], {}).unitCoverage(mkGap());
  assertEqual(noMin.min, null, '未設定最低配置時不做判定');
});

test('api 回應不符合約格式時視同失敗，退回 mock', async () => {
  const origFetch = globalThis.fetch;
  const origMode = LLM.mode, origEndpoint = LLM.endpoint;
  try {
    LLM.mode = 'api';
    LLM.endpoint = 'https://example.invalid/llm';
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ 不是合約形狀: true }) });
    const parsed = await llmParseGapMessage('明天的白班沒辦法上');
    assertEqual(LLM.mode, 'mock', '合約驗證失敗應自動退回 mock');
    assertEqual(parsed.extracted.date.value, '2026-08-09', '退回後仍以 mock 完成解析');
  } finally {
    globalThis.fetch = origFetch;
    LLM.mode = origMode;
    LLM.endpoint = origEndpoint;
    delete LLM.fallbackReason;
  }
});

test('api 模式呼叫失敗時自動退回 mock，演示不中斷', async () => {
  const origFetch = globalThis.fetch;
  const origMode = LLM.mode, origEndpoint = LLM.endpoint;
  try {
    LLM.mode = 'api';
    LLM.endpoint = 'https://example.invalid/llm';
    globalThis.fetch = () => { throw new Error('網路中斷'); };
    const parsed = await llmParseGapMessage('明天的白班沒辦法上');
    assertEqual(LLM.mode, 'mock', 'api 失敗後應自動切回 mock');
    assertEqual(parsed.extracted.shift.value, 'D', '退回後應以 mock 規則完成解析，不留空白畫面');
    assertEqual(parsed.extracted.date.value, '2026-08-09');
  } finally {
    globalThis.fetch = origFetch;
    LLM.mode = origMode;
    LLM.endpoint = origEndpoint;
    delete LLM.fallbackReason;
  }
});
