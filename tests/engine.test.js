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

/* ── 輸入驗證與消毒（資安補強的邊界，改壞任何一條會直接變紅）── */

test('isValidDateStr：格式看似正確但不存在的日期一律拒絕', () => {
  assert(isValidDateStr('2026-08-09'), '真實日期應通過');
  assert(isValidDateStr('2028-02-29'), '閏年 2/29 應通過');
  assert(!isValidDateStr('2026-02-31'), '2026-02-31 不存在，應拒絕（JS Date 會無聲進位成 3/3）');
  assert(!isValidDateStr('2026-13-01'), '13 月不存在，應拒絕');
  assert(!isValidDateStr('2026-02-29'), '2026 非閏年，2/29 應拒絕');
  assert(!isValidDateStr('abc'), '非日期字串應拒絕');
  assert(!isValidDateStr(null), 'null 應拒絕');
});

test('mock 解析：訊息中的「13/45」不是真日期，不得當成線索（轉為追問）', async () => {
  const parsed = await llmParseGapMessage('護理長，13/45 的白班我沒辦法上');
  assertEqual(parsed.extracted.date.value, null, '無效的月日組合不得產生日期');
  assert(parsed.missing.some((m) => m.field === 'date'), '日期應轉為追問');
});

test('sanitizeParsed：api 模式的模型輸出必須通過白名單，不合法值降級為追問', () => {
  const dirty = {
    extracted: {
      date: { value: '2026-02-31', label: 'x', source: 'x' },              // 不存在的日期
      shift: { value: '"><script>', label: 'x', source: 'x' },             // 非法班別代碼（注入嘗試）
      reason: { value: '病假', label: '病假', source: 'ok' },
      unit: { value: 'HACK', label: 'x', source: 'x' },                    // 非白名單單位
      requiredCerts: { value: ['ACLS', 'EVIL'], label: 'x', source: 'x' }, // 混入非白名單資格
    },
    missing: [],
  };
  const clean = sanitizeParsed(dirty);
  assertEqual(clean.extracted.date.value, null, '不存在的日期應被消毒為 null');
  assertEqual(clean.extracted.shift.value, null, '非法班別代碼應被消毒為 null');
  assertEqual(clean.extracted.unit.value, null, '非白名單單位應被消毒為 null');
  assertEqual(clean.extracted.requiredCerts.value, null, '含非白名單資格的清單應整組拒絕');
  assertEqual(clean.missing.map((m) => m.field).sort(),
    ['date', 'requiredCerts', 'shift', 'unit'], '被消毒的欄位應全數轉為追問');
});

test('sanitizeParsed：合法值放行，label／source 截斷至 200 字', () => {
  const clean = sanitizeParsed({
    extracted: {
      date: { value: '2026-08-09', label: 'L'.repeat(500), source: 's' },
      shift: { value: 'D', label: '白班', source: 's' },
      reason: { value: '病假', label: '病假', source: 's' },
      unit: { value: 'MED-3A', label: 'u', source: 's' },
      requiredCerts: { value: ['ACLS'], label: 'c', source: 's' },
    },
  });
  assertEqual(clean.extracted.date.value, '2026-08-09', '合法日期應原樣通過');
  assertEqual(clean.extracted.date.label.length, 200, '超長 label 應截斷至 200 字');
  assertEqual(clean.missing, [], '欄位齊全時不應產生追問');
});

/* ── 任務重分配（第三層：韌性模式）── */

test('任務重分配：資格是硬性條件——需 VENT 的任務絕不指派給無資格者', () => {
  const r = reallocateTasks(TASK_REALLOC_SCENARIO);
  r.plan.forEach((p) => {
    p.tasks.forEach((t) => {
      (t.requiredCerts || []).forEach((c) =>
        assert(p.staff.certs.includes(c), `${p.staff.id} 無 ${c} 資格卻被指派 ${t.name}`));
    });
  });
  const t1 = r.uncovered.find((u) => u.task.id === 'T1');
  assert(t1, '無人具 VENT 資格，T1 應為未覆蓋');
  assertEqual(t1.reason, 'no_qualified', 'T1 未覆蓋原因應為「無人具資格」');
});

test('任務重分配：負荷上限被嚴格遵守，量能不足以 over_capacity 標示', () => {
  const r = reallocateTasks(TASK_REALLOC_SCENARIO);
  r.plan.forEach((p) =>
    assert(p.extraLoad <= r.maxExtraLoad, `${p.staff.id} 負荷 ${p.extraLoad} 超過上限 ${r.maxExtraLoad}`));
  const overCap = r.uncovered.filter((u) => u.reason === 'over_capacity');
  assert(overCap.length >= 1, '情境總量能 6 點 < 非 VENT 任務 8 點，應有任務因量能不足未覆蓋');
  // 只能由 I-01 承接的中央靜脈導管給藥（IV）必須被覆蓋
  const t2Holder = r.plan.find((p) => p.tasks.some((t) => t.id === 'T2'));
  assert(t2Holder && t2Holder.staff.id === 'I-01', 'T2 需 IV 資格，應由 I-01 承接');
});

test('任務重分配：關鍵任務優先於非關鍵任務——不會為了覆蓋衛教而犧牲給藥', () => {
  // 量能充足時全部覆蓋；量能極度受限時，未覆蓋的應盡量是非關鍵任務
  const tight = reallocateTasks({
    tasks: [
      { id: 'A', name: '給藥', requiredCerts: [], workload: 2, critical: true },
      { id: 'B', name: '衛教', requiredCerts: [], workload: 2, critical: false },
    ],
    onDuty: [{ id: 'X', role: '護理師', certs: [] }],
    maxExtraLoad: 2,
  });
  assertEqual(tight.uncovered.map((u) => u.task.id), ['B'], '量能只夠一項時，應保關鍵任務、捨非關鍵');
  const ample = reallocateTasks({
    tasks: [
      { id: 'A', name: '給藥', requiredCerts: [], workload: 2, critical: true },
      { id: 'B', name: '衛教', requiredCerts: [], workload: 2, critical: false },
    ],
    onDuty: [{ id: 'X', role: '護理師', certs: [] }, { id: 'Y', role: '護理師', certs: [] }],
    maxExtraLoad: 2,
  });
  assertEqual(ample.uncovered, [], '量能充足時應全數覆蓋');
});

test('任務重分配：結果確定性且誠實——缺口數量與覆蓋數相加等於任務總數', () => {
  const r1 = reallocateTasks(TASK_REALLOC_SCENARIO);
  const r2 = reallocateTasks(TASK_REALLOC_SCENARIO);
  assertEqual(
    r1.plan.map((p) => p.tasks.map((t) => t.id)),
    r2.plan.map((p) => p.tasks.map((t) => t.id)),
    '同輸入必得同結果');
  assertEqual(r1.coveredCount + r1.uncovered.length, r1.totalCount, '覆蓋＋缺口必須交代全部任務');
});

test('completeGapEvent：不合法的缺班條件不得進入引擎（最後一道閘門）', () => {
  const noneExtracted = {
    date: { value: null }, shift: { value: null }, unit: { value: null },
    requiredCerts: { value: null }, reason: { value: '病假' },
  };
  let threw = false;
  try {
    completeGapEvent(noneExtracted, { date: '2026-02-31', shift: 'D', unit: 'MED-3A', requiredCerts: ['ACLS'] });
  } catch (e) { threw = true; }
  assert(threw, '不存在的日期應在最後閘門被擋下');

  threw = false;
  try {
    completeGapEvent(noneExtracted, { date: '2026-08-10', shift: 'X', unit: 'MED-3A', requiredCerts: ['ACLS'] });
  } catch (e) { threw = true; }
  assert(threw, '非法班別代碼應在最後閘門被擋下');

  const gap = completeGapEvent(noneExtracted, { date: '2026-08-10', shift: 'D', unit: 'MED-3A', requiredCerts: ['ACLS'] });
  assertEqual(gap.date, '2026-08-10', '合法條件應正常組裝');
  assertEqual(gap.shift, 'D');
});

/* ── 班表生成（第 0 層：源頭治理）── */

test('班表生成：示範情境全填滿、疊上現有班表重掃後零新增風險', () => {
  const e = mkEngine(STAFF, SHIFTS);
  const r = e.generateSchedule(GEN_SCENARIO);
  assertEqual(r.uncovered, [], '示範情境人力充足，應無未覆蓋格子');
  assertEqual(r.filled, r.slotCount, '28 格應全數填滿');
  assertEqual(r.verification.newHigh, [], '生成不得引入任何新的「已違規」');
  assertEqual(r.verification.newMedium, [], '示範情境亦不應引入新的「達門檻」');
  // 誠實邊界：ACLS 已過期的 N-04 一班都不得被排入（H1 與替補同一份程式碼）
  assert(r.assignments.every((a) => a.staffId !== 'N-04'), 'ACLS 過期者不得被排入需 ACLS 的班');
  // 請假期間不得排班（H3）
  r.assignments.forEach((a) => {
    const st = STAFF.find((s) => s.id === a.staffId);
    assert(!st.leaves.some((lv) => a.date >= lv.from && a.date <= lv.to),
      `${a.staffId} 於請假日 ${a.date} 被排班`);
  });
  // 每一格都符合需求定義的班別與數量
  GEN_SCENARIO.dates.forEach((date) => {
    GEN_SCENARIO.requirements.forEach((req) => {
      const n = r.assignments.filter((a) => a.date === date && a.shift === req.shift).length;
      assertEqual(n, req.count, `${date} ${req.shift} 應排入 ${req.count} 人`);
    });
  });
});

test('班表生成：跨週邊界——上週日大夜的殘影會擋掉本週一的白班（H4）', () => {
  const A = mkStaff('A', { willingShifts: ['N'] });
  const shifts = [d('A', '2026-08-09', 'N')];   // 週日大夜，8/10 07:00 才下班
  const gen = (shift) => mkEngine([A], shifts.map((s) => Object.assign({}, s))).generateSchedule({
    unit: 'MED-3A', dates: ['2026-08-10'],
    requirements: [{ shift, count: 1, requiredRole: '護理師', requiredCerts: [] }],
  });
  const dayR = gen('D');
  assertEqual(dayR.assignments, [], '8/10 白班 07:00 開始，與大夜下班間隔 0 小時，不得排入');
  assert(dayR.uncovered[0].blockers.some((b) => b.code === 'H4'), '缺口原因應標示 H4');
  const nightR = gen('N');
  assertEqual(nightR.assignments.length, 1, '8/10 大夜 23:00 開始，間隔 16 小時，可排入');
});

test('班表生成：跨週邊界——連續上班天數跨週累計（H5）', () => {
  const A = mkStaff('A');
  const shifts = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09']
    .map((day) => d('A', day));                 // 上週已連上 6 天，至週日
  const r = mkEngine([A], shifts).generateSchedule({
    unit: 'MED-3A', dates: ['2026-08-10'],
    requirements: [{ shift: 'D', count: 1, requiredRole: '護理師', requiredCerts: [] }],
  });
  assertEqual(r.assignments, [], '排入 8/10 將連上第 7 天，不得排入');
  assert(r.uncovered[0].blockers.some((b) => b.code === 'H5'), '缺口原因應標示 H5');
});

test('班表生成：誠實缺口——無人具必要資格時不硬塞、不放寬，逐格標示原因', () => {
  const A = mkStaff('A');                        // 無 VENT 資格
  const r = mkEngine([A], []).generateSchedule({
    unit: 'MED-3A', dates: ['2026-08-10', '2026-08-11'],
    requirements: [{ shift: 'D', count: 1, requiredRole: '護理師', requiredCerts: ['VENT'] }],
  });
  assertEqual(r.assignments, [], '無資格者不得被排入');
  assertEqual(r.uncovered.length, 2, '每一個排不出的格子都要標示');
  r.uncovered.forEach((u) =>
    assert(u.blockers.some((b) => b.code === 'H1'), '缺口原因應標示 H1 資格'));
});

test('班表生成：結果確定性——同輸入同班表', () => {
  const e = mkEngine(STAFF, SHIFTS);
  assertEqual(e.generateSchedule(GEN_SCENARIO).assignments,
    e.generateSchedule(GEN_SCENARIO).assignments, '同輸入必得同班表');
});

/* ── 能力與帶班平衡分析 ── */

test('能力分析：單點依賴——VENT 有效持有 1 人，過期證照不計入戰力', () => {
  const e = mkEngine(STAFF, SHIFTS, { ladderLevels: LADDER_LEVELS });
  const r = e.capabilityAnalysis({ dates: WEEK_DATES, unit: 'MED-3A' });
  const vent = r.certSinglePoints.find((c) => c.code === 'VENT');
  assertEqual(vent.holders, ['N-10'], 'VENT 唯一有效持有者應為 N-10（單點依賴）');
  const acls = r.certSinglePoints.find((c) => c.code === 'ACLS');
  assert(!acls.holders.includes('N-04'), 'N-04 的 ACLS 已過期，不得計入有效持有人');
});

test('能力分析：帶班平衡——大夜整週無 N3 以上、白班有資深帶班', () => {
  const e = mkEngine(STAFF, SHIFTS, { ladderLevels: LADDER_LEVELS });
  const r = e.capabilityAnalysis({ dates: WEEK_DATES, unit: 'MED-3A' });
  const nights = r.shiftMix.filter((m) => m.shift === 'N' && !m.empty);
  assert(nights.length >= 4, '示範週應有大夜排班');
  assert(nights.every((m) => !m.hasSenior), '大夜由 N2 獨撐，整週無 N3 以上帶班（實力失衡情境）');
  const day84 = r.shiftMix.find((m) => m.date === '2026-08-04' && m.shift === 'D');
  assert(day84.hasSenior, '8/4 白班有 AHN／N3 以上，應判定有資深帶班');
});

test('能力分析：到期雷達——過期、90 天內到期、90 天外三種狀態分明', () => {
  const A = mkStaff('A', {
    certs: { ACLS: '2026-08-01', CHEMO: '2026-09-30', IV: '2027-08-01' },
  });
  const r = mkEngine([A], []).capabilityAnalysis({ dates: ['2026-08-03'], unit: 'MED-3A' });
  const byCode = Object.fromEntries(r.expiring.map((x) => [x.code, x.status]));
  assertEqual(byCode.ACLS, 'expired', '8/1 到期、基準日 8/3 → 已過期');
  assertEqual(byCode.CHEMO, 'expiring', '9/30 到期在 90 天視窗內 → 即將到期');
  assert(!('IV' in byCode), '一年後到期不應出現在雷達');
  const badgeA = r.badges[0].certs.find((c) => c.code === 'IV');
  assertEqual(badgeA.status, 'valid');
});

test('能力分析：資格×班別覆蓋——大夜化療 4/4 天有人、呼吸器 0/4 天', () => {
  const e = mkEngine(STAFF, SHIFTS, { ladderLevels: LADDER_LEVELS });
  const r = e.capabilityAnalysis({ dates: WEEK_DATES, unit: 'MED-3A' });
  const night = r.certCoverage.find((c) => c.shift === 'N');
  assertEqual(night.staffedDays, 4, '示範週大夜有排班 4 天');
  assertEqual(night.certs.find((c) => c.cert === 'CHEMO').coveredDays, 4, 'N-07 具化療資格');
  assertEqual(night.certs.find((c) => c.cert === 'VENT').coveredDays, 0, '大夜整週無呼吸器覆蓋');
});

/* ── 人力缺口分析（管理總覽）── */

test('缺口方程式：demo 資料的內科 3A 缺 5 班次、大夜為結構性缺口、ICU 誠實回報無資料', () => {
  const e = mkEngine(STAFF, SHIFTS);
  const r = e.workforceGapAnalysis({ dates: WEEK_DATES, demand: UNIT_MIN_STAFF });
  const med = r.cells.filter((c) => c.unit === 'MED-3A' && c.gap > 0);
  assertEqual(med.length, 5, '內科 3A 本週應有 5 個缺口格');
  assert(med.some((c) => c.date === '2026-08-09' && c.shift === 'D'), '缺班事件當日白班應在缺口中');
  const medN = r.structural.find((s) => s.unit === 'MED-3A' && s.shift === 'N');
  assert(medN && medN.days === 3, '內科 3A 大夜缺口出現 3 天，應標記為結構性');
  assert(r.noData.includes('ICU'), '無排班資料的單位應回報 noData，不假裝算得出缺口');
  const r2 = e.workforceGapAnalysis({ dates: WEEK_DATES, demand: UNIT_MIN_STAFF });
  assertEqual(JSON.stringify(r.absorb.fills), JSON.stringify(r2.absorb.fills), '同輸入必得同結果');
});

test('缺口分析：填補模擬誠實——無人可合法填補時保留殘餘並標示原因', () => {
  const A = mkStaff('A');
  const shifts = [d('A', '2026-08-10', 'D')];        // 唯一人力當日已排班（H2）
  const r = mkEngine([A], shifts).workforceGapAnalysis({
    dates: ['2026-08-10'], demand: { 'MED-3A': { E: 1 } },
  });
  assertEqual(r.totals.gapSeats, 1);
  assertEqual(r.absorb.withCross, 0, '無人可填補時不得虛報吸收量');
  assertEqual(r.absorb.residualSeats, 1, '殘餘缺口誠實保留');
  assert(r.absorb.residual[0].blockers.some((b) => b.code === 'H4' || b.code === 'H2'),
    '殘餘缺口需標示被哪條規則擋下');
});

test('缺口分析：跨單位支援的吸收量分開計——同單位補不了的缺口由熟悉單位者吸收', () => {
  const A = mkStaff('A', { unit: 'MED-3A', familiarUnits: ['MED-3A', 'SUR-5B'] });
  const B = mkStaff('B', { unit: 'SUR-5B', familiarUnits: ['SUR-5B'] });
  const shifts = [d('B', '2026-08-10', 'D', 'SUR-5B')];   // B 當日已排班 → 同單位無人可補小夜
  const r = mkEngine([A, B], shifts).workforceGapAnalysis({
    dates: ['2026-08-10'], demand: { 'SUR-5B': { D: 1, E: 1 } },
  });
  assertEqual(r.absorb.inUnit, 0, '同單位人力已用盡');
  assertEqual(r.absorb.withCross, 1, '跨單位熟悉者可吸收');
  assert(r.absorb.fills[0].cross === true && r.absorb.fills[0].staffId === 'A',
    '填補紀錄應標示為跨單位支援');
});

test('缺口分析：結構性門檻——同班別缺口 2 天不算、3 天標記為結構性', () => {
  const A = mkStaff('A');
  const mk = (dates) => mkEngine([A], [d('A', dates[0], 'D')]).workforceGapAnalysis({
    dates, demand: { 'MED-3A': { N: 1 } },
  });
  assertEqual(mk(['2026-08-10', '2026-08-11']).structural, [], '2 天缺口不構成結構性');
  const r3 = mk(['2026-08-10', '2026-08-11', '2026-08-12']);
  assert(r3.structural.some((s) => s.shift === 'N' && s.days === 3), '3 天缺口應標記為結構性');
});

test('班表生成：公平輪值——三人輪六天白班，每人恰好兩班', () => {
  const trio = ['A', 'B', 'C'].map((id) => mkStaff(id));
  const r = mkEngine(trio, []).generateSchedule({
    unit: 'MED-3A',
    dates: ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'],
    requirements: [{ shift: 'D', count: 1, requiredRole: '護理師', requiredCerts: [] }],
  });
  assertEqual(r.spread.max, 2, '最多 2 班');
  assertEqual(r.spread.min, 2, '最少 2 班——完全均衡');
});

/* ── 四週彈性工時（勞基法第 30 條之 1：H7／H8／H9）── */

test('H7 雙週例假：固定二週週期內排班 12 天為法定極限，第 13 天被擋', () => {
  // 二週週期 8/03–8/16；H5 調高到 14 天以隔離變因（本測試只驗 H7）
  const reg = structuredClone(RULE_REGISTRY);
  reg.hard.find((r) => r.code === 'H5').param.value = 14;
  const opts = { flexCycleAnchor: '2026-08-03', registry: reg };
  const A = mkStaff('A');
  const work12 = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07',
    '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
    '2026-08-15', '2026-08-16'].map((day) => d('A', day));   // 休 8/08、8/14

  // 已排 11 天 + 缺班日 = 12 天：恰保留 2 日例假，應通過
  const pass = mkEngine([A], work12.slice(0, 11), opts)
    .checkHardConstraints(A, mkGap({ date: '2026-08-16' }));
  assert(!pass.some((v) => v.code === 'H7'), `12 天恰為極限應通過，實際：${pass.map((v) => v.code).join(',')}`);

  // 已排 12 天 + 缺班日 = 13 天：僅餘 1 日例假，應觸發 H7
  const fail = mkEngine([A], work12, opts)
    .checkHardConstraints(A, mkGap({ date: '2026-08-08' }));
  assert(fail.some((v) => v.code === 'H7'), `二週 13 天應觸發 H7，實際：${fail.map((v) => v.code).join(',') || '（無）'}`);
});

test('H8 四週正常工時總量：160 小時為法定總量，第 161 小時起被擋', () => {
  // 用 10 小時班隔離 H9（16 班 × 10h = 160h，但工作日僅 17 天、休息日仍 ≥ 8）
  const types = Object.assign({}, SHIFT_TYPES, {
    X: { code: 'X', name: '十小時班', start: '07:00', end: '17:00', hours: 10, overnight: false },
  });
  const opts = { flexCycleAnchor: '2026-08-03', shiftTypes: types };
  const A = mkStaff('A');
  // 四週（8/03–8/30）每週一～四各一班 = 16 班 × 10 小時 = 160 小時
  const work16 = [
    '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
    '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
    '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20',
    '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
  ].map((day) => d('A', day, 'X'));

  // 15 班 + 缺班 = 160 小時整：法規為「總量 160」，恰好用滿應通過
  const pass = mkEngine([A], work16.slice(0, 15), opts)
    .checkHardConstraints(A, mkGap({ date: '2026-08-27', shift: 'X' }));
  assert(!pass.some((v) => v.code === 'H8'), `160 小時整應通過，實際：${pass.map((v) => v.code).join(',')}`);

  // 16 班 + 缺班 = 170 小時：超過總量，應觸發 H8
  const fail = mkEngine([A], work16, opts)
    .checkHardConstraints(A, mkGap({ date: '2026-08-28', shift: 'X' }));
  assert(fail.some((v) => v.code === 'H8'), `170 小時應觸發 H8，實際：${fail.map((v) => v.code).join(',') || '（無）'}`);
});

test('H9 四週例假與休息日總量：至少 8 日未排班，排到第 21 天被擋', () => {
  // 用 6 小時班隔離 H8（21 班 × 6h = 126h < 160h，休息日卻只剩 7 天）
  const types = Object.assign({}, SHIFT_TYPES, {
    S: { code: 'S', name: '六小時班', start: '08:00', end: '14:00', hours: 6, overnight: false },
  });
  const opts = { flexCycleAnchor: '2026-08-03', shiftTypes: types };
  const A = mkStaff('A');
  // 四週每週一～五各一班 = 20 天（H5 連 5 天、H7 每二週 10 天，皆合法）
  const work20 = [
    '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07',
    '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14',
    '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21',
    '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28',
  ].map((day) => d('A', day, 'S'));

  // 19 天 + 缺班 = 20 天：恰保留 8 日休息，應通過
  const pass = mkEngine([A], work20.slice(0, 19), opts)
    .checkHardConstraints(A, mkGap({ date: '2026-08-28', shift: 'S' }));
  assert(!pass.some((v) => v.code === 'H9'), `20 天恰為極限應通過，實際：${pass.map((v) => v.code).join(',')}`);

  // 20 天 + 缺班（週六）= 21 天：僅餘 7 日，應觸發 H9
  const fail = mkEngine([A], work20, opts)
    .checkHardConstraints(A, mkGap({ date: '2026-08-29', shift: 'S' }));
  assert(fail.some((v) => v.code === 'H9'), `21 天應觸發 H9，實際：${fail.map((v) => v.code).join(',') || '（無）'}`);
});

test('四週彈性工時：固定週期歸屬正確，且不影響既有 demo 情境', () => {
  assertEqual(cycleStartOf('2026-08-16', 14, '2026-08-03'), '2026-08-03', '8/16 屬 8/03 起的二週週期');
  assertEqual(cycleStartOf('2026-08-17', 14, '2026-08-03'), '2026-08-17', '8/17 起進入下一個二週週期');
  assertEqual(cycleStartOf('2026-08-30', 28, '2026-08-03'), '2026-08-03', '8/30 屬 8/03 起的四週週期');
  assertEqual(cycleStartOf('2026-08-02', 28, '2026-08-03'), '2026-07-06', '錨點之前的日期歸入前一個週期');
  // demo 資料在 H7–H9 之下照常運作：合格候選與排除名單不變
  const e = mkEngine(STAFF, SHIFTS.slice(), { flexCycleAnchor: FLEX_CYCLE_ANCHOR });
  const ev = e.evaluateGap(GAP_EVENT);
  assertEqual(ev.candidates.map((c) => c.staff.id), ['N-02', 'N-08', 'N-10', 'N-01'],
    '加入 H7–H9 後 demo 劇本不得改變');
  assert(e.rosterWarnings().every((w) => w.level !== 'high'), 'demo 班表在四週彈性工時下仍應零違規');
});

/* ── 換班互換預檢（analyzeSwap／applySwap）── */

test('換班預檢：合法互換——兩人單純換日，雙向零違規', () => {
  const A = mkStaff('A');
  const B = mkStaff('B');
  const e = mkEngine([A, B], [d('A', '2026-08-05'), d('B', '2026-08-07')]);
  const r = e.analyzeSwap(
    { staffId: 'A', date: '2026-08-05', shift: 'D' },
    { staffId: 'B', date: '2026-08-07', shift: 'D' },
    { requiredCerts: ['ACLS'] });
  assert(r.ok, `合法互換應通過，實際 aTake=${(r.aTake.violations || []).map((v) => v.code)} bTake=${(r.bTake.violations || []).map((v) => v.code)}`);
  assertEqual(r.aTake.violations, [], '甲承接乙的班應零違規');
  assertEqual(r.bTake.violations, [], '乙承接甲的班應零違規');
  assertEqual(r.aTake.slot.date, '2026-08-07', '甲承接的是乙的班次日期');
});

test('換班預檢：大夜殘影——甲留著 8/08 大夜、換來 8/09 白班，H4 抓出 0 小時休息', () => {
  const A = mkStaff('A', { willingShifts: ['N'] });
  const B = mkStaff('B');
  const e = mkEngine([A, B], [
    d('A', '2026-08-08', 'N'),   // 甲的大夜上到 8/09 07:00
    d('A', '2026-08-05'),        // 甲拿去換的班
    d('B', '2026-08-09'),        // 乙的白班 8/09 07:00 開始
  ]);
  const r = e.analyzeSwap(
    { staffId: 'A', date: '2026-08-05', shift: 'D' },
    { staffId: 'B', date: '2026-08-09', shift: 'D' },
    { requiredCerts: ['ACLS'] });
  assert(!r.ok, '互換後班間休息 0 小時，不應通過');
  assert(r.aTake.violations.some((v) => v.code === 'H4'),
    `甲應觸發 H4，實際：${r.aTake.violations.map((v) => v.code).join(',') || '（無）'}`);
  assertEqual(r.bTake.violations, [], '乙承接 8/05 白班應零違規');
});

test('換班預檢：換完連上第 7 天——H5 擋下（用 Excel 對兩張班表根本看不出來）', () => {
  const A = mkStaff('A');
  const B = mkStaff('B');
  const work6 = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08']
    .map((day) => d('A', day));
  const e = mkEngine([A, B], [...work6, d('A', '2026-08-12'), d('B', '2026-08-09')]);
  const r = e.analyzeSwap(
    { staffId: 'A', date: '2026-08-12', shift: 'D' },   // 甲讓出的班在連續區段之外
    { staffId: 'B', date: '2026-08-09', shift: 'D' },   // 換來的班讓 8/03–8/09 連成 7 天
    { requiredCerts: ['ACLS'] });
  assert(!r.ok, '換完連上 7 天不應通過');
  assert(r.aTake.violations.some((v) => v.code === 'H5'),
    `甲應觸發 H5，實際：${r.aTake.violations.map((v) => v.code).join(',') || '（無）'}`);
  assertEqual(r.bTake.violations, [], '乙承接 8/12 白班應零違規');
});

test('換班預檢：同日雙班——甲當日已有另一班，H2 擋下', () => {
  const A = mkStaff('A', { willingShifts: ['D', 'E'] });
  const B = mkStaff('B');
  const e = mkEngine([A, B], [d('A', '2026-08-07', 'E'), d('A', '2026-08-05'), d('B', '2026-08-07')]);
  const r = e.analyzeSwap(
    { staffId: 'A', date: '2026-08-05', shift: 'D' },
    { staffId: 'B', date: '2026-08-07', shift: 'D' },
    { requiredCerts: ['ACLS'] });
  assert(!r.ok, '甲 8/07 已有小夜，再接同日白班不應通過');
  assert(r.aTake.violations.some((v) => v.code === 'H2'),
    `甲應觸發 H2，實際：${r.aTake.violations.map((v) => v.code).join(',') || '（無）'}`);
});

test('換班預檢：資格與跨單位——ICU 班要求 VENT，無資格者被 H1 擋下、跨單位列入提示', () => {
  const A = mkStaff('A');                                        // 無 VENT
  const B = mkStaff('B', { unit: 'ICU', certs: { ACLS: '2030-12-31', VENT: '2030-12-31' } });
  const e = mkEngine([A, B], [d('A', '2026-08-05'), d('B', '2026-08-07', 'D', 'ICU')]);
  const r = e.analyzeSwap(
    { staffId: 'A', date: '2026-08-05', shift: 'D' },
    { staffId: 'B', date: '2026-08-07', shift: 'D' },
    { requiredCerts: ['VENT'] });
  assert(!r.ok, '無 VENT 資格承接 ICU 班不應通過');
  assert(r.aTake.violations.some((v) => v.code === 'H1'),
    `甲應觸發 H1，實際：${r.aTake.violations.map((v) => v.code).join(',') || '（無）'}`);
  assert(r.notices.some((n) => n.includes('跨單位')), '甲跨單位承接應列入提示');
});

test('換班預檢：防呆——查無班次、同一人互換都要擋下', () => {
  const A = mkStaff('A');
  const B = mkStaff('B');
  const e = mkEngine([A, B], [d('A', '2026-08-05'), d('A', '2026-08-07'), d('B', '2026-08-06')]);
  const r1 = e.analyzeSwap(
    { staffId: 'A', date: '2026-08-05', shift: 'D' },
    { staffId: 'B', date: '2026-08-09', shift: 'D' });   // 乙 8/09 沒有班
  assert(!r1.ok && !!r1.error, '查無班次應回報錯誤');
  const r2 = e.analyzeSwap(
    { staffId: 'A', date: '2026-08-05', shift: 'D' },
    { staffId: 'A', date: '2026-08-07', shift: 'D' });
  assert(!r2.ok && !!r2.error, '同一人互換應回報錯誤');
});

test('applySwap 寫回：兩筆班次交換承接人，日期班別單位不動、總班次數不變', () => {
  const A = mkStaff('A');
  const B = mkStaff('B');
  const shifts = [d('A', '2026-08-05'), d('B', '2026-08-07', 'E')];
  const e = mkEngine([A, B], shifts);
  const ok = e.applySwap(
    { staffId: 'A', date: '2026-08-05', shift: 'D' },
    { staffId: 'B', date: '2026-08-07', shift: 'E' });
  assert(ok, '寫回應成功');
  assertEqual(shifts.length, 2, '總班次數不變');
  const s05 = shifts.find((s) => s.date === '2026-08-05');
  const s07 = shifts.find((s) => s.date === '2026-08-07');
  assertEqual(s05.staffId, 'B', '8/05 白班改由乙承接');
  assertEqual(s07.staffId, 'A', '8/07 小夜改由甲承接');
  assertEqual(s07.shift, 'E', '班別不動');
  assert(s05.isSwap === true && s07.isSwap === true, '互換班次應帶 isSwap 標記');
});
