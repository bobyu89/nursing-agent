/**
 * botcore.test.js — LINE 機器人共用互動核心的測試
 *
 * 釘住的是兩套 bot（Cloudflare／AWS Lambda）共同依賴的行為：
 * postback 參數編解碼、逐步補條件的順序、替補建議訊息的誠實性、
 * 以及「bot 引擎與平台引擎同一份規則（含 H7–H9）同一個週期錨點」。
 */

test('botcore：postback 參數編解碼 roundtrip（含「無需資格」的空字串哨兵）', () => {
  const p = { d: '2026-08-09', s: 'D', u: 'MED-3A', c: 'ACLS,CHEMO' };
  assertEqual(decodeParams(encodeParams(p)), { ...p, id: null }, '一般條件應原樣還原');

  const noCert = decodeParams(encodeParams({ d: '2026-08-09', s: 'E', u: 'ICU', c: '' }));
  assertEqual(noCert.c, '', '明確選了「無需資格」是空字串，不得變回 null（null 代表還沒問）');

  const partial = decodeParams(encodeParams({ d: '2026-08-09' }));
  assertEqual([partial.s, partial.u, partial.c], [null, null, null], '未提供的條件應為 null');
});

test('botcore：askNext 逐步補條件——班別 → 單位 → 資格 → 齊全回 null', () => {
  const step1 = askNext({ d: '2026-08-09', s: null, u: null, c: null });
  assert(step1.text.includes('班別'), '先問班別');
  assertEqual(step1.items.length, Object.keys(SHIFT_TYPES).length);

  const step2 = askNext({ d: '2026-08-09', s: 'D', u: null, c: null });
  assert(step2.text.includes('單位'), '再問單位');
  assertEqual(step2.items.length, Object.keys(UNITS).length);

  const step3 = askNext({ d: '2026-08-09', s: 'D', u: 'MED-3A', c: null });
  assert(step3.text.includes('資格'), '最後問必要資格');
  assert(step3.items.some((i) => i.label === '無需特殊資格'), '要能明確選「無需資格」');

  assertEqual(askNext({ d: '2026-08-09', s: 'D', u: 'MED-3A', c: '' }), null, '條件齊全即結束追問');
});

test('botcore：替補建議訊息——demo 情境前三名與排除數誠實呈現，附詢問按鈕', () => {
  const out = evaluateAndFormat({ d: '2026-08-09', s: 'D', u: 'MED-3A', c: 'ACLS,CHEMO' }, 'https://x.example/');
  assert(out.text.includes('1️⃣ N-02'), '第一名應為 N-02（與平台 demo 劇本一致）');
  assert(out.text.includes('7 人被排除'), '排除人數要誠實');
  assert(out.text.includes('H7–H9'), '訊息應標示含四週彈性工時規則');
  assertEqual(out.items.length, 3, '前三名各附一顆詢問草稿按鈕');
  assert(out.items.every((i) => i.dataStr.includes('id=')), '按鈕 data 應帶候選人代號');
});

test('botcore：bot 引擎與平台引擎同一份規則同一個錨點；查無替補時誠實列出規則代碼', () => {
  // 同一缺班條件，botcore.runEngine 與直接建平台引擎必須同結果
  const p = { d: '2026-08-09', s: 'D', u: 'MED-3A', c: 'ACLS,CHEMO' };
  const viaBot = runEngine(p).candidates.map((c) => c.staff.id);
  const platform = createEngine({
    staff: STAFF, shifts: SHIFTS, shiftTypes: SHIFT_TYPES, roleLevels: ROLE_LEVELS,
    certs: CERTS, units: UNITS, registry: RULE_REGISTRY, staffingMin: UNIT_MIN_STAFF,
    flexCycleAnchor: FLEX_CYCLE_ANCHOR,
  }).evaluateGap(buildGap(p)).candidates.map((c) => c.staff.id);
  assertEqual(viaBot, platform, 'bot 與平台的候選排序必須一字不差');

  // 8/08 白班＋呼吸器資格：唯一持有者 N-10 當日已排班（H2）→ 查無合格替補
  const none = evaluateAndFormat({ d: '2026-08-08', s: 'D', u: 'ICU', c: 'VENT' }, 'https://x.example/');
  assert(none.text.includes('查無合格替補'), '無人可派要明說');
  assert(none.text.includes('H1') && none.text.includes('H2'), '排除涉及的規則代碼要列出');
  assertEqual(none.items, null, '無候選人時不出詢問按鈕');
});
