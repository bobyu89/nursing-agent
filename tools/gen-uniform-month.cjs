/* 產生 2026-08「每日人數一致」整月示範班表（內科 3A）：
 * 需求每日 白2／小夜1／大夜1；示範週 8/03–8/09 手排（劇情缺格保留：
 * 8/3 小夜・大夜、8/6 大夜、8/9 白班・大夜 = 5 格），其餘由平台同一份生成器離線產出。
 * 跑完印出所有示範劇本的「實跑數字」，供更新 data.js／tests／台本。 */
/* 用法：node tools/gen-uniform-month.cjs b emit   （b＝N-08 外科班表變體；emit＝輸出 data.js 片段） */
const path = require('path');
const ROOT = path.join(__dirname, '..');
Object.assign(globalThis, require(path.join(ROOT, 'src/data.js')));
Object.assign(globalThis, require(path.join(ROOT, 'src/rules.js')));
Object.assign(globalThis, require(path.join(ROOT, 'src/engine.js')));

function mk(shifts, staff = STAFF, regOverride) {
  return createEngine({
    staff, shifts, shiftTypes: SHIFT_TYPES, roleLevels: ROLE_LEVELS,
    ladderLevels: LADDER_LEVELS, certs: CERTS, units: UNITS,
    registry: regOverride || structuredClone(RULE_REGISTRY),
    staffingMin: UNIT_MIN_STAFF, flexCycleAnchor: FLEX_CYCLE_ANCHOR,
  });
}
const D = (n) => `2026-08-${String(n).padStart(2, '0')}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => D(a + i));
const S = (staffId, day, shift, unit = 'MED-3A') => ({ staffId, date: D(day), shift, unit });

/* ── 新示範週（手排；每格恰達需求，僅劇情缺格留空）──
 * D: 每日 2（8/9 = 0：N-05 病假＋N-11 特休，正是缺班事件）
 * E: 每日 1（8/3 = 0：結構性）
 * N: 8/4,5,7,8 = 1（8/3,6,9 = 0：結構性大夜缺口 3 天）*/
const N08_VARIANTS = {
  a: [S('N-08', 3, 'D', 'SUR-5B'), S('N-08', 4, 'E', 'SUR-5B'), S('N-08', 6, 'D', 'SUR-5B')],   // 24h（原樣）
  b: [S('N-08', 3, 'D', 'SUR-5B'), S('N-08', 6, 'D', 'SUR-5B')],                                  // 16h
  c: [S('N-08', 4, 'E', 'SUR-5B')],                                                               // 8h
};
const N08_PICK = process.argv[2] || 'a';

const WEEK_SHIFTS = [
  // 白班（N-09 連六天＝H5 劇本；8/4 有 N3 資深帶班；N-10 8/7–8/8 讓 8/8 的 VENT 王在班）
  S('N-01', 3, 'D'), S('N-09', 3, 'D'),
  S('N-04', 4, 'D'), S('N-09', 4, 'D'),
  S('N-02', 5, 'D'), S('N-09', 5, 'D'),
  S('N-01', 6, 'D'), S('N-09', 6, 'D'),
  S('N-10', 7, 'D'), S('N-09', 7, 'D'),
  S('N-10', 8, 'D'), S('N-09', 8, 'D'),
  // 小夜（N-06 8/4 供 bot 換班 H2 劇本；8/8–8/9 假日兩班＝假日旗標；8/9＝加演第二筆的原班）
  S('N-06', 4, 'E'),
  S('N-03', 5, 'E'),
  S('N-05', 6, 'E'),
  S('N-11', 7, 'E'),
  S('N-06', 8, 'E'),
  S('N-06', 9, 'E'),
  // 大夜（N-07 全包＝夜班旗標＋H4 劇本；非 N3 以上＝帶班失衡劇本）
  S('N-07', 4, 'N'), S('N-07', 5, 'N'), S('N-07', 7, 'N'), S('N-07', 8, 'N'),
  // N-08（外科 5B，跨單位候選的隱形調音旋鈕）
  ...N08_VARIANTS[N08_PICK],
];

/* ── 生成 8/1–8/2 與 8/10–8/30（需求 2/1/1）── */
const req = [
  { shift: 'D', count: 2, requiredRole: '護理師', requiredCerts: [] },
  { shift: 'E', count: 1, requiredRole: '護理師', requiredCerts: [] },
  { shift: 'N', count: 1, requiredRole: '護理師', requiredCerts: [] },
];
let acc = WEEK_SHIFTS.map((s) => ({ ...s }));
const fill = [];
function genBlock(dates, staff) {
  const e = mk(acc.map((s) => ({ ...s })), staff);
  const r = e.generateSchedule({ unit: 'MED-3A', dates, requirements: req, label: dates[0] });
  r.assignments.forEach((a) => {
    const rec = { staffId: a.staffId, date: a.date, shift: a.shift, unit: 'MED-3A' };
    acc.push(rec); fill.push(rec);
  });
  return { dates: `${dates[0].slice(8)}–${dates[dates.length - 1].slice(8)}`, filled: r.filled, slots: r.slotCount, uncovered: r.uncovered.length };
}
// 8/1–8/2：保護劇本人物（N-09 連六不可提早開始；N-01/02/03/07 班距與換班劇本不可被邊界打擾）
const protectedIds = new Set(['N-01', 'N-02', 'N-03', 'N-07', 'N-09']);
const blocks = [];
blocks.push(genBlock(range(1, 2), STAFF.filter((s) => !protectedIds.has(s.id))));
blocks.push(genBlock(range(10, 16)));
blocks.push(genBlock(range(17, 23)));
blocks.push(genBlock(range(24, 30)));
console.log('blocks:', JSON.stringify(blocks));

// 手工微調：8/10 白班不得排入加演第二筆的候選（N-01/N-03/N-10 接 8/9 小夜會撞 H4 班距）
const demo2Cands = new Set(['N-01', 'N-03', 'N-10']);
for (const s of fill) {
  if (s.date === D(10) && s.shift === 'D' && demo2Cands.has(s.staffId)) {
    // 找當日休且雙向合法的替身：優先 N-09（8/9 休，六連後首日）與 N-02
    for (const sub of ['N-09', 'N-02', 'N-05', 'N-11']) {
      const busy = acc.some((x) => x.staffId === sub && x.date === D(10));
      if (busy) continue;
      const probe = mk(acc.filter((x) => x !== s).concat([{ staffId: sub, date: D(10), shift: 'D', unit: 'MED-3A' }]).map((x) => ({ ...x })));
      if (probe.rosterWarnings().every((w) => w.level !== 'high')) { s.staffId = sub; break; }
    }
  }
}

/* ── 守護檢查與實跑數字 ─────────────────────────── */
const eFull = mk(acc.map((s) => ({ ...s })));
const bad = [];
const ck = (name, cond, extra) => { if (!cond) bad.push(name + (extra ? '｜' + extra : '')); };

// 0) 每日人數一致：整月每格恰達需求，僅 5 個劇情缺格為 0
const STORY_GAPS = new Set(['03E', '03N', '06N', '09D', '09N']);
const NEED = { D: 2, E: 1, N: 1 };
let covBad = [];
for (let dd = 1; dd <= 30; dd++) {
  for (const sh of ['D', 'E', 'N']) {
    const n = acc.filter((s) => s.unit === 'MED-3A' && s.date === D(dd) && s.shift === sh).length;
    const want = STORY_GAPS.has(String(dd).padStart(2, '0') + sh) ? 0 : NEED[sh];
    if (n !== want) covBad.push(`${D(dd)} ${sh}=${n}（應 ${want}）`);
  }
}
ck('整月覆蓋一致', covBad.length === 0, covBad.slice(0, 6).join('、'));

// 1) 全月零「已違規」
const high = eFull.rosterWarnings().filter((w) => w.level === 'high');
ck('零已違規', high.length === 0, JSON.stringify(high.slice(0, 3)));

// 2) 主線第一筆（8/9 白班）
const r1 = eFull.evaluateGap(GAP_EVENT);
console.log('demo1 候選：', r1.candidates.map((c) => `${c.staff.id}:${c.score.total}`).join('  '),
  '｜排除', r1.excluded.length, '位');
console.log('demo1 排除原因：', r1.excluded.map((x) => `${x.staff.id}=${x.violations.map((v) => v.code).join('+')}`).join('  '));
ck('demo1 名單集合', JSON.stringify(r1.candidates.map((c) => c.staff.id).slice().sort()) === '["N-01","N-02","N-08","N-10"]');
ck('demo1 N-02 居首', r1.candidates[0] && r1.candidates[0].staff.id === 'N-02');
ck('demo1 排除 7 位', r1.excluded.length === 7);
const why = Object.fromEntries(r1.excluded.map((x) => [x.staff.id, x.violations.map((v) => v.code)]));
ck('N-07 H4', (why['N-07'] || []).includes('H4'));
ck('N-09 H5', (why['N-09'] || []).includes('H5'));
ck('N-04 H1', (why['N-04'] || []).includes('H1'));
ck('N-03 H1', (why['N-03'] || []).includes('H1'));
ck('N-06 H2', (why['N-06'] || []).includes('H2'));
ck('N-11 H3', (why['N-11'] || []).includes('H3'));

// 2b) 規則庫劇本：S1 權重 30 → 0 時 N-08 的名次變化（台本幕 2 步 5）
const reg0 = structuredClone(RULE_REGISTRY);
reg0.soft.find((r) => r.code === 'S1').weight = 0;
const r1z = mk(acc.map((s) => ({ ...s })), STAFF, reg0).evaluateGap(GAP_EVENT);
console.log('S1=0 時排序：', r1z.candidates.map((c) => `${c.staff.id}:${c.score.total}`).join('  '));

// 3) 加演第二筆（N-02 已接 8/9 白班後 → 8/9 小夜，原班 N-06）
const acc2 = acc.concat([{ staffId: 'N-02', date: D(9), shift: 'D', unit: 'MED-3A' }]);
const r2 = mk(acc2.map((s) => ({ ...s }))).evaluateGap({
  id: 'G2', date: D(9), shift: 'E', unit: 'MED-3A', requiredRole: '護理師',
  requiredCerts: ['ACLS'], originalStaffId: 'N-06', reason: '病假', raisedBy: '', raisedAt: '2026-08-08 21:00',
});
console.log('demo2 候選：', r2.candidates.map((c) => `${c.staff.id}:${c.score.total}`).join('  '),
  '｜排除', r2.excluded.length, '位');
const why2 = Object.fromEntries(r2.excluded.map((x) => [x.staff.id, x.violations.map((v) => v.code)]));
ck('demo2 N-02 因 H2 被排除', (why2['N-02'] || []).includes('H2'), JSON.stringify(why2['N-02']));
ck('demo2 名單集合', JSON.stringify(r2.candidates.map((c) => c.staff.id).slice().sort()) === '["N-01","N-03","N-08","N-10"]',
  r2.candidates.map((c) => c.staff.id).join(','));

// 4) 換班台本三組（與 UI 預設一致：必要資格 ACLS）
const swap = (a, b) => eFull.analyzeSwap(a, b, { requiredCerts: ['ACLS'] });
const g1 = swap({ staffId: 'N-01', date: D(3), shift: 'D' }, { staffId: 'N-02', date: D(5), shift: 'D' });
ck('換班綠燈', g1.ok === true, JSON.stringify([(g1.aTake.violations || []).map((v) => v.code), (g1.bTake.violations || []).map((v) => v.code)]));
const rd = swap({ staffId: 'N-01', date: D(3), shift: 'D' }, { staffId: 'N-07', date: D(5), shift: 'N' });
ck('換班紅燈 H4（對 8/6 白班 0 小時）', !rd.ok && rd.aTake.violations.some((v) => v.code === 'H4') && rd.bTake.violations.length === 0,
  JSON.stringify([rd.aTake.violations.map((v) => v.code), rd.bTake.violations.map((v) => v.code)]));
if (rd.aTake.violations.length) console.log('紅燈 H4 detail:', rd.aTake.violations.find((v) => v.code === 'H4').detail);
const h10 = swap({ staffId: 'N-03', date: D(5), shift: 'E' }, { staffId: 'N-07', date: D(4), shift: 'N' });
ck('換班 H10', !h10.ok && h10.aTake.violations.some((v) => v.code === 'H10'),
  JSON.stringify(h10.aTake && h10.aTake.violations ? h10.aTake.violations.map((v) => v.code) : h10.error));

// 4b) bot 換班劇本：N-07 8/4 ↔ N-06 8/9（需 H4＋H2）
const bot = eFull.analyzeSwap({ staffId: 'N-07', date: D(4), shift: 'N' }, { staffId: 'N-06', date: D(9), shift: 'E' }, { requiredCerts: [] });
ck('bot 換班 H4+H2', !bot.ok && bot.aTake.violations.some((v) => v.code === 'H4') && bot.bTake.violations.some((v) => v.code === 'H2'),
  JSON.stringify([bot.aTake.violations.map((v) => v.code), bot.bTake.violations.map((v) => v.code)]));

// 5) 負荷雷達三人旗標
const led = eFull.workloadLedger(WEEK_DATES);
const flagged = led.staff.filter((x) => x.flags.length > 0).map((x) => `${x.staff.id}[${x.flags.map((f) => f.code).join(',')}]`);
console.log('雷達旗標：', flagged.join('  '));
const names = led.staff.filter((x) => x.flags.length > 0).map((x) => x.staff.id).sort();
ck('三人旗標', JSON.stringify(names) === '["N-06","N-07","N-09"]', names.join(','));
ck('N-09 連續旗', led.staff.find((x) => x.staff.id === 'N-09').flags.some((f) => f.code === '連續'));
ck('N-07 夜班旗', led.staff.find((x) => x.staff.id === 'N-07').flags.some((f) => f.code === '夜班'));
ck('N-06 假日旗', led.staff.find((x) => x.staff.id === 'N-06').flags.some((f) => f.code === '假日'));

// 6) 生成下一週（8/31–9/6）28/28、N-04 排除、零新違規
const GEN2 = { unit: 'MED-3A', dates: ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'],
  requirements: [
    { shift: 'D', count: 2, requiredRole: '護理師', requiredCerts: ['ACLS'] },
    { shift: 'E', count: 1, requiredRole: '護理師', requiredCerts: ['ACLS'] },
    { shift: 'N', count: 1, requiredRole: '護理師', requiredCerts: ['ACLS'] },
  ] };
const rg = mk(acc.map((s) => ({ ...s }))).generateSchedule(GEN2);
ck('生成週 28/28', rg.filled === rg.slotCount && rg.uncovered.length === 0, `${rg.filled}/${rg.slotCount} uncovered=${rg.uncovered.length}`);
ck('生成週 N-04 排除', rg.assignments.every((a) => a.staffId !== 'N-04'));
ck('生成週零新違規', rg.verification.newHigh.length === 0 && rg.verification.newMedium.length === 0,
  JSON.stringify([rg.verification.newHigh.slice(0, 2), rg.verification.newMedium.slice(0, 2)]));

// 7) 缺口方程式（週視窗）：5 缺格、大夜結構性 3 天、吸收模擬
const wga = eFull.workforceGapAnalysis({ dates: WEEK_DATES, demand: UNIT_MIN_STAFF });
const medGaps = wga.cells.filter((c) => c.unit === 'MED-3A' && c.gap > 0);
ck('缺口 5 格', medGaps.length === 5, medGaps.map((c) => `${c.date.slice(8)}${c.shift}`).join(','));
ck('含 8/9 白班', medGaps.some((c) => c.date === D(9) && c.shift === 'D'));
const stN = wga.structural.find((s) => s.unit === 'MED-3A' && s.shift === 'N');
ck('大夜結構性 3 天', stN && stN.days === 3, JSON.stringify(wga.structural));
console.log('缺口帳：需求', wga.totals.demandSeats, '在班', wga.totals.scheduledSeats,
  '缺口', wga.totals.gapSeats, '｜吸收', wga.absorb.withCross, '殘餘', wga.absorb.residualSeats,
  '｜公平代價筆數', (wga.absorb.fills || []).filter((f) => f.fairnessCost || f.flags && f.flags.length).length,
  '｜fills', JSON.stringify((wga.absorb.fills || []).map((f) => `${f.staffId}→${(f.date || '').slice(8)}${f.shift}${f.cross ? '跨' : ''}`)));

// 8) 多筆缺班：逐筆 vs 全局
const greedy = eFull.assignGreedy(MULTI_GAP_SCENARIO);
const joint = eFull.assignJointly(MULTI_GAP_SCENARIO);
const mg1 = mk(acc.map((s) => ({ ...s }))).evaluateGap(MULTI_GAP_SCENARIO[0]);
console.log('多筆第一筆候選：', mg1.candidates.map((c) => `${c.staff.id}:${c.score.total}`).join('  '));
ck('逐筆先用 N-10', greedy[0].staffId === 'N-10', JSON.stringify(greedy.map((g) => g.staffId)));
ck('逐筆第二筆無人', greedy[1].staffId === null);
ck('全局兩筆都補上', joint.filled === 2 && JSON.stringify(joint.assignment) === '["N-01","N-10"]', JSON.stringify(joint));

// 9) 能力分析：8/4 白班有資深、大夜 4 天全由非 N3↑、VENT 0 覆蓋
const cap = eFull.capabilityAnalysis({ dates: WEEK_DATES, unit: 'MED-3A' });
const nights = cap.shiftMix.filter((m) => m.shift === 'N' && !m.empty);
ck('大夜 4 天', nights.length === 4, String(nights.length));
ck('大夜無資深', nights.every((m) => !m.hasSenior));
ck('8/4 白班有資深', cap.shiftMix.find((m) => m.date === D(4) && m.shift === 'D').hasSenior);
const nightCov = cap.certCoverage.find((c) => c.shift === 'N');
ck('大夜 CHEMO 4/4', nightCov.certs.find((c) => c.cert === 'CHEMO').coveredDays === 4);
ck('大夜 VENT 0', nightCov.certs.find((c) => c.cert === 'VENT').coveredDays === 0);

// 10) 8/8 調度劇本：小夜全院僅 N-06 → 零建議
const disp = eFull.dispatchAnalysis({ date: D(8), shift: 'E', toUnit: 'ICU', demand: UNIT_MIN_STAFF, requiredCerts: ['ACLS'] });
ck('調度零建議', disp.candidates.length === 0, JSON.stringify(disp.candidates.map((c) => c.staff.id)));

// 11) 護病比口徑（台本幕庫）：週視窗達標數
const rd2 = ratioDemand(Object.fromEntries(Object.entries(UNIT_CENSUS).map(([u, c]) => [u, { occupied: c.occupied }])), HOSPITAL_LEVELS.MC.ratios, { ICU: ICU_RATIO });
const wga2 = eFull.workforceGapAnalysis({ dates: WEEK_DATES, demand: { 'MED-3A': rd2['MED-3A'] } });
console.log('護病比口徑（醫學中心）：需求', wga2.totals.demandSeats, '在班', wga2.totals.scheduledSeats, '缺口', wga2.totals.gapSeats);

// 12) 每日在班統計（給台本與 UI 對照）
const dayTot = {};
acc.forEach((s) => { if (s.unit === 'MED-3A') dayTot[s.date] = (dayTot[s.date] || 0) + 1; });
console.log('每日在班：', range(1, 30).map((dd) => `${dd.slice(8)}:${dayTot[dd] || 0}`).join(' '));

console.log(bad.length ? '✗ 守護檢查失敗：\n  ' + bad.join('\n  ') : '✓ 守護檢查全數通過');
if (!bad.length && process.argv[3] === 'emit') {
  const ord = { D: 0, E: 1, N: 2 };
  const week = WEEK_SHIFTS.slice().sort((a, b) => a.staffId.localeCompare(b.staffId) || a.date.localeCompare(b.date));
  const month = fill.slice().sort((a, b) => a.date.localeCompare(b.date) || ord[a.shift] - ord[b.shift] || a.staffId.localeCompare(b.staffId));
  console.log('=== WEEK（' + week.length + ' 班）===');
  console.log(week.map((s) => `  { staffId: '${s.staffId}', date: '${s.date}', shift: '${s.shift}', unit: '${s.unit}' },`).join('\n'));
  console.log('=== MONTH_FILL（' + month.length + ' 班）===');
  console.log(month.map((s) => `  { staffId: '${s.staffId}', date: '${s.date}', shift: '${s.shift}', unit: 'MED-3A' },`).join('\n'));
}
