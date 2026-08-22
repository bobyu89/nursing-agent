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

/* ── 指令三兄弟：換班預檢／調度棋盤／負荷雷達 ── */

test('botcore：換班指令——日期簡寫展開、綠燈附平台深鏈、用法說明', () => {
  assertEqual(expandDate('8/5'), '2026-08-05', 'M/D 以示範週年份展開');
  assertEqual(expandDate('2026-08-05'), '2026-08-05', '完整日期原樣通過');
  assertEqual(expandDate('13/40'), null, '不存在的日期回 null');

  const usage = swapCommand('換班', 'https://x.example/');
  assert(usage.text.includes('用法'), '無參數回用法說明');

  const ok = swapCommand('換班 N-01 8/3 N-02 8/5', 'https://x.example/');
  assert(ok.text.includes('✓ N-01 承接') && ok.text.includes('✓ N-02 承接'), '合法互換雙向皆綠燈');
  assert(ok.text.includes('✅') && ok.text.includes('index.html#swap'), '綠燈附平台換班簽核深鏈');
});

test('botcore：換班指令——大夜殘影紅燈與防呆，與平台 analyzeSwap 同一份判定', () => {
  // N-07 讓出 8/4 大夜換 N-06 的 8/9 小夜：N-07 班距 8 小時（H4）、N-06 當日雙班（H2）
  const bad = swapCommand('換班 N-07 8/4 N-06 8/9', 'https://x.example/');
  assert(bad.text.includes('⛔ H4') || bad.text.includes('H4：'), 'N-07 接小夜應觸發 H4');
  assert(bad.text.includes('H2'), 'N-06 接大夜應觸發 H2');
  assert(bad.text.includes('不可核准'), '紅燈明說不可核准');

  const noShift = swapCommand('換班 N-01 8/9 N-02 8/5', 'https://x.example/');
  assert(noShift.text.includes('沒有班次'), 'N-01 8/9 無班要擋下');
  const badId = swapCommand('換班 X-99 8/3 N-02 8/5', 'https://x.example/');
  assert(badId.text.includes('查無人員'), '不明代號要擋下');
});

test('botcore：調度指令——預設示範今日小夜，貼線單位不拆、無人可借誠實說', () => {
  const out = dispatchCommand('調度', 'https://x.example/');
  assert(out.text.includes('調度棋盤') && out.text.includes('小夜'), '預設示範今日的小夜');
  assert(out.text.includes('守恆律'), '守恆律要講明');
  assert(out.text.includes('🟡') && out.text.includes('N-06'), 'MED-3A 貼線（N-06 在班）');
  assert(out.text.includes('無人可合法借調'), '示範主資料無餘裕：誠實回報');
  assert(out.text.includes('index.html#dispatch'), '附平台調度棋盤深鏈');

  const args = dispatchCommand('調度 8/9 白', 'https://x.example/');
  assert(args.text.includes('8/9') && args.text.includes('白班'), '參數指定時點');
  assertEqual(dispatchCommand('你好', 'https://x.example/'), null, '非指令不攔截');
});

test('botcore：負荷指令——高負荷名單與旗標理由，與平台留任雷達同一本帳', () => {
  const out = retentionCommand('負荷', 'https://x.example/');
  ['N-09', 'N-07', 'N-06'].forEach((id) =>
    assert(out.text.includes(id), `${id} 應在高負荷名單（與平台 demo 一致）`));
  assert(out.text.includes('非離職預測'), '誠實聲明：不是預測模型');
  assert(out.text.includes('index.html#retention'), '附平台留任雷達深鏈');
});

test('botcore：extraCommand 統一入口——三指令命中其一，一般訊息回 null 交還解析流程', () => {
  assert(!!extraCommand('換班', 'https://x.example/'), '換班命中');
  assert(!!extraCommand('調度', 'https://x.example/'), '調度命中');
  assert(!!extraCommand('負荷', 'https://x.example/'), '負荷命中');
  assertEqual(extraCommand('我明天白班沒辦法上', 'https://x.example/'), null, '請假訊息不得被指令攔截');
  assertEqual(extraCommand('儀表板', 'https://x.example/'), null, '儀表板由既有路由處理，不重複攔截');
});

test('botcore：儀表板 Flex 圖表——純 JSON 長條（零外部繪圖服務、資料不出門）', () => {
  const flex = buildDashboardFlex('https://x.example/');
  const str = JSON.stringify(flex);
  assert(str.includes('三班排班補足率'), '補足率圖表段落存在');
  assert(str.includes('近 30 天代班分佈'), '公平分佈圖表段落存在');
  assert(str.includes('S1 飽和線 5'), '飽和線標示與規則庫 S1 連動');
  const bars = (str.match(/"width":"\d+%"/g) || []).length;
  assert(bars >= 9, `至少 9 根長條（三班 3＋公平 6），實際 ${bars}`);
  assert(str.includes('"filler"'), '長條內層以 filler 撐開（LINE Flex 規格）');
  assert(!str.toLowerCase().includes('quickchart') && !str.includes('"type":"image"'),
    '不使用外部繪圖服務、不夾帶圖片——人事數字不經任何第三方');
  const bytes = new TextEncoder().encode(str).length;
  assert(bytes < 50000, `Flex JSON 需 < 50KB（LINE 上限），實際 ${bytes} bytes`);
  assert(str.includes('N-01'), '公平分佈應含代班最多的 N-01（4 次，飽和線前一格）');
});
