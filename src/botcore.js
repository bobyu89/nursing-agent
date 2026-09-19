/**
 * botcore.js — LINE 通報機器人的共用互動核心（平台無關）
 *
 * Cloudflare Workers 版（cloudflare/linebot/worker.mjs）與
 * AWS Lambda 版（aws/linebot/index.mjs）共用同一份流程邏輯：
 *   解析結果 → 缺什麼條件出哪組按鈕（askNext）→ 條件齊全跑同一份
 *   evaluateGap 引擎（H1–H10：含四週彈性工時與母性保護）→ 替補建議
 *   → 詢問草稿（llmNotificationDraft）；「儀表板」回 Flex 戰情卡；
 *   指令三兄弟：「換班」互換預檢、「調度」守恆律棋盤、「負荷」留任雷達。
 *
 * 本檔只組訊息、不碰傳輸：LINE 簽章驗證、reply API、頻率限制等
 * 平台差異留在各自的進入點。與 engine.js 同一設計：資料取自全域
 * （由宿主以 Object.assign(globalThis, …) 掛載 data/rules/engine/llm），
 * 瀏覽器測試頁、Node CI、Workers、Lambda 四種環境同一份程式碼。
 *
 * 治理邊界：機器人提供「建議」，不做指派決定——正式確認與決策留痕在平台。
 */

const FIELD_TW = { date: '日期', shift: '班別', unit: '單位', requiredCerts: '必要資格', reason: '事由' };

/* ── 缺班條件的無狀態編碼（postback data ≤ 300 字，綽綽有餘）── */

function encodeParams(p) {
  const qs = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => { if (v !== null && v !== undefined) qs.set(k, v); });
  return qs.toString();
}

function decodeParams(str) {
  const qs = new URLSearchParams(str || '');
  return {
    d: qs.get('d'),                                  // 日期 YYYY-MM-DD
    s: qs.get('s'),                                  // 班別代碼 D/E/N
    u: qs.get('u'),                                  // 單位代碼
    c: qs.has('c') ? qs.get('c') : null,             // 資格代碼逗號串（'' = 明確選了「無需資格」）
    id: qs.get('id'),                                // 產生詢問草稿的對象（候選人代號）
  };
}

/* ── 逐步補條件：缺什麼就出哪一組按鈕 ── */

function askNext(p) {
  const base = { d: p.d, s: p.s, u: p.u, c: p.c };
  if (!p.s) {
    return {
      text: '缺的是哪一個班別？（點下方按鈕選擇）',
      items: Object.entries(SHIFT_TYPES).map(([code, t]) => ({
        label: t.name, dataStr: encodeParams({ ...base, s: code }),
      })),
    };
  }
  if (!p.u) {
    return {
      text: '這筆缺班在哪一個照護單位？',
      items: Object.entries(UNITS).map(([code, name]) => ({
        label: name, dataStr: encodeParams({ ...base, u: code }),
      })),
    };
  }
  if (p.c === null) {
    const combos = [
      { label: 'ACLS', c: 'ACLS' },
      { label: 'ACLS＋化療給藥', c: 'ACLS,CHEMO' },
      { label: 'ACLS＋靜脈注射', c: 'ACLS,IV' },
      { label: 'ACLS＋呼吸器', c: 'ACLS,VENT' },
      { label: '無需特殊資格', c: '' },
    ];
    return {
      text: '當班需要哪些必要資格？',
      items: combos.map(({ label, c }) => ({ label, dataStr: encodeParams({ ...base, c }) })),
    };
  }
  return null;   // 條件齊全
}

/* ── 條件齊全 → 同一份引擎評估，回覆替補建議 ── */

function buildGap(p) {
  return {
    date: p.d, shift: p.s, unit: p.u,
    requiredRole: '護理師',
    requiredCerts: p.c ? p.c.split(',').filter(Boolean) : [],
    originalStaffId: null,
  };
}

/**
 * 資料來源注入（Stage 1 地基，docs/LINEBOT-STAGE1.md §2）
 * 宿主若接了 D1，會傳入 { staff, shifts }；未傳則回落到 data.js 的示範資料。
 * 只有人員與班表是「活的」——規則庫、班別、單位、證照定義仍是程式碼裡的設定。
 * 所有讀 STAFF／SHIFTS 的地方一律經過這裡，不直接碰全域。
 */
function liveData(db) {
  return {
    staff: (db && Array.isArray(db.staff)) ? db.staff : STAFF,
    shifts: (db && Array.isArray(db.shifts)) ? db.shifts : SHIFTS,
  };
}

/** 與平台完全同一份設定的引擎（含四週彈性工時錨點）——bot 所有功能共用 */
function platformEngine(db) {
  const live = liveData(db);
  return createEngine({
    staff: live.staff, shifts: live.shifts, shiftTypes: SHIFT_TYPES, roleLevels: ROLE_LEVELS,
    ladderLevels: LADDER_LEVELS, certs: CERTS, units: UNITS,
    registry: RULE_REGISTRY, staffingMin: UNIT_MIN_STAFF,
    flexCycleAnchor: FLEX_CYCLE_ANCHOR,
  });
}

function runEngine(p, db) {
  const gap = buildGap(p);
  return { gap, ...platformEngine(db).evaluateGap(gap) };
}

function evaluateAndFormat(p, platformUrl, db) {
  const { gap, candidates, excluded } = runEngine(p, db);

  const head = `【替補建議】${shortDate(gap.date)}（${weekdayOf(gap.date)}）${SHIFT_TYPES[gap.shift].name}｜${UNITS[gap.unit]}\n` +
    `需求：護理師以上${gap.requiredCerts.length ? '＋' + gap.requiredCerts.map((c) => CERTS[c].replace(/\s.*/, '')).join('、') : ''}`;

  if (candidates.length === 0) {
    const codes = [...new Set(excluded.flatMap((e) => e.violations.map((v) => v.code)))].filter((c) => c !== '—');
    return {
      text: [
        head, '',
        `⚠ 查無合格替補（${excluded.length} 人全數排除，涉及規則：${codes.join('、')}）。`,
        '請至平台查看放寬試算與第 3 層任務重分配（決策階梯會引導）：',
        platformUrl,
        '',
        '＊示範資料（虛構人員）；正式決策以平台留痕為準',
      ].join('\n'),
      items: null,
    };
  }

  const medal = ['1️⃣', '2️⃣', '3️⃣'];
  const top3 = candidates.slice(0, 3);
  const top = top3.map((c, i) => {
    const why = [...c.score.breakdown].sort((a, b) => b.points - a.points).slice(0, 2)
      .map((b) => `${b.name} ${b.points} 分`).join('、');
    const warn = c.flags.length ? `\n　⚠ ${c.flags.map((f) => f.code).join('、')}${c.needsApproval ? '（需額外核准）' : ''}` : '';
    return `${medal[i]} ${c.staff.id}　${c.score.total}／${c.score.maxTotal} 分\n　${why}${warn}`;
  }).join('\n');

  const exCodes = [...new Set(excluded.flatMap((e) => e.violations.map((v) => v.code)))].filter((c) => c !== '—');
  return {
    text: [
      head, '', top, '',
      `另有 ${excluded.length} 人被排除（${exCodes.slice(0, 4).join('、')}），逐筆原因見平台。`,
      '點下方按鈕可產生「詢問訊息草稿」，複製後自行轉傳。',
      '正式指派請至平台完成主管確認（寫回班表＋決策留痕）：',
      platformUrl,
      '',
      '＊建議由確定性引擎計算（H1–H10：含四週彈性工時 H7–H9 與母性保護 H10）；機器人不做指派決定',
      '＊示範資料（虛構人員）',
    ].join('\n'),
    items: top3.map((c) => ({
      label: `✉ 詢問 ${c.staff.id}`,
      dataStr: encodeParams({ d: p.d, s: p.s, u: p.u, c: p.c, id: c.staff.id }),
    })),
  };
}

/* ── 詢問訊息草稿：平台同一份 llmNotificationDraft，含工時試算與誠實聲明 ── */

async function draftAndFormat(p, platformUrl, db) {
  globalThis.LLM.mode = 'mock';
  const { gap, candidates } = runEngine(p, db);
  const others = candidates.slice(0, 3).filter((c) => c.staff.id !== p.id);
  const backItems = [
    ...others.map((c) => ({
      label: `✉ 詢問 ${c.staff.id}`,
      dataStr: encodeParams({ d: p.d, s: p.s, u: p.u, c: p.c, id: c.staff.id }),
    })),
    { label: '↩ 回建議清單', dataStr: encodeParams({ d: p.d, s: p.s, u: p.u, c: p.c }) },
  ];

  const chosen = candidates.find((c) => c.staff.id === p.id);
  if (!chosen) {
    return { text: `${p.id} 已不在合格候選內（條件可能已變動），請回建議清單重新確認。`, items: backItems };
  }

  const draft = await globalThis.llmNotificationDraft(gap, chosen);
  return {
    text: [
      `【詢問訊息草稿｜${p.id}】`,
      '複製下方訊息、自行轉傳給該同仁——系統不代發，發送與否由你決定：',
      '',
      '──────────',
      draft,
      '──────────',
      '',
      '＊工時試算由引擎確定性計算；對方同意後，正式指派請至平台完成主管確認與留痕',
    ].join('\n'),
    items: backItems,
  };
}

/* ── 戰情儀表板（Flex Message）──────────────────────────
 * 與平台管理總覽同一份引擎即時計算：缺口方程式、帶班平衡、單點依賴、
 * 證照效期、結構性訊號＋前三項行動。輸入「儀表板」即生成。
 */
/* 色票與平台儀表板同步（淺色 SaaS 主題、靛藍主色） */
const FLEX_C = { red: '#C92C21', amber: '#93600A', green: '#117A58', ink: '#16233A', faint: '#5C6B85', line: '#E4E9F1', brand: '#4060EF', track: '#EEF2F7' };

/**
 * Flex 長條圖列：LINE 沒有圖表元件，但巢狀 box 的寬度百分比＋背景色
 * 就是貨真價實的長條——純 JSON、零依賴、資料不經任何第三方繪圖服務。
 */
function flexBar(label, right, pct, color) {
  const C = FLEX_C;
  const width = Math.max(2, Math.min(100, Math.round(pct)));   // 0 也畫 2%，讓「幾乎沒有」看得見
  return {
    type: 'box', layout: 'vertical', margin: 'md',
    contents: [
      {
        type: 'box', layout: 'horizontal',
        contents: [
          { type: 'text', text: label, size: 'xs', color: C.ink, flex: 5 },
          { type: 'text', text: right, size: 'xs', color: C.faint, align: 'end', flex: 3 },
        ],
      },
      {
        type: 'box', layout: 'vertical', margin: 'xs', height: '8px',
        backgroundColor: C.track, cornerRadius: '4px',
        contents: [{
          type: 'box', layout: 'vertical', width: `${width}%`, height: '8px',
          backgroundColor: color, cornerRadius: '4px',
          contents: [{ type: 'filler' }],
        }],
      },
    ],
  };
}

/**
 * LIFF 支援（選配）：宿主設定 LIFF_ID 後，「開啟平台／完整儀表板」
 * 按鈕改走 https://liff.line.me/{id} —— 在 LINE 內以全高視窗開啟平台，
 * 體驗像原生功能。未設定則維持一般網址（LINE 內建瀏覽器）。
 * 深鏈（#swap 等）維持一般網址：LIFF 會把 # 轉進 liff.state，
 * 平台頁未載入 LIFF SDK（CSP 嚴格、零外部腳本），錨點會丟失——誠實取捨。
 */
function buildDashboardFlex(platformUrl, liffUrl, db) {
  const C = FLEX_C;
  const eng = platformEngine(db);
  const live = liveData(db);
  const UNIT = 'MED-3A';
  const gap = eng.workforceGapAnalysis({ dates: WEEK_DATES, demand: UNIT_MIN_STAFF });
  const cap = eng.capabilityAnalysis({ dates: WEEK_DATES, unit: UNIT });

  const cells = gap.cells.filter((c) => c.unit === UNIT);
  const gapCells = cells.filter((c) => c.gap > 0);
  const need = cells.reduce((n, c) => n + c.need, 0);
  const sched = cells.reduce((n, c) => n + Math.min(c.scheduled, c.need), 0);
  const fills = gap.absorb.fills.filter((f) => f.unit === UNIT);
  const flagged = fills.filter((f) => f.flags.length > 0);
  const residual = gap.absorb.residual.filter((u) => u.unit === UNIT).length;
  const structural = gap.structural.filter((s) => s.unit === UNIT);

  const balance = ['D', 'E', 'N'].map((code) => {
    const staffed = cap.shiftMix.filter((x) => x.shift === code && !x.empty);
    return { code, staffed: staffed.length, ok: staffed.filter((x) => x.hasSenior).length };
  }).filter((b) => b.staffed > 0);
  const worst = balance.reduce((w, b) => (b.ok / b.staffed < w.ok / w.staffed ? b : w), balance[0]);
  const sp = cap.certSinglePoints.filter((c) => c.count <= 1);
  const expired = cap.expiring.filter((x) => x.status === 'expired').length;
  const expSoon = cap.expiring.filter((x) => x.status === 'expiring').length;

  const kpiRow = (label, value, color) => ({
    type: 'box', layout: 'horizontal', margin: 'md',
    contents: [
      { type: 'text', text: label, size: 'sm', color: C.ink, flex: 5 },
      { type: 'text', text: value, size: 'sm', weight: 'bold', color, align: 'end', flex: 3 },
    ],
  });
  /* 圖表資料：三班補足率＋公平分佈（皆為引擎輸出，長條只是把數字畫出來） */
  const fillBars = ['D', 'E', 'N'].map((code) => {
    const cs = cells.filter((c) => c.shift === code);
    const needN = cs.reduce((n, c) => n + c.need, 0);
    const schedN = cs.reduce((n, c) => n + Math.min(c.scheduled, c.need), 0);
    const pct = needN ? (schedN / needN) * 100 : 0;
    const color = pct >= 100 ? C.green : (pct >= 70 ? C.amber : C.red);
    return flexBar(SHIFT_TYPES[code].name, `${schedN}／${needN} 格`, pct, color);
  });
  const s1 = RULE_REGISTRY.soft.find((r) => r.code === 'S1');
  const sat = (s1 && s1.param ? s1.param.value : 5);
  const topStandby = [...live.staff]
    .sort((a, b) => b.standbyCount30d - a.standbyCount30d || (a.id < b.id ? -1 : 1)).slice(0, 6);
  const maxStandby = Math.max(sat, topStandby.length ? topStandby[0].standbyCount30d : 1);
  const fairBars = topStandby.map((s) => {
    const color = s.standbyCount30d >= sat ? C.red : (s.standbyCount30d === sat - 1 ? C.amber : C.brand);
    return flexBar(s.id, `${s.standbyCount30d} 次`, (s.standbyCount30d / maxStandby) * 100, color);
  });

  const actions = [];
  balance.filter((b) => b.ok < b.staffed).forEach((b) =>
    actions.push(`${SHIFT_TYPES[b.code].name}資深覆蓋 ${b.ok}/${b.staffed} 天 → 輪入 N3↑`));
  sp.forEach((c) => actions.push(`${CERTS[c.code].replace(/\s.*/, '')}${c.count === 0 ? '無人持有' : `僅 ${c.holders[0]}`} → 培訓第二人`));
  if (expired) actions.push(`${expired} 張證照已過期 → 安排回訓`);
  if (flagged.length) actions.push(`吸收方案 ${flagged.length} 筆有公平代價 → 留意集中`);

  return {
    type: 'flex',
    altText: `班守本週戰情：缺口 ${gapCells.length} 班次、殘餘 ${residual}、行動 ${actions.length} 項`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'lg',
        contents: [
          { type: 'text', text: '班守 ShiftGuard｜本週戰情', weight: 'bold', size: 'md', color: C.ink },
          { type: 'text', text: `${UNITS[UNIT]}・本週（示範資料）`, size: 'xs', color: C.faint, margin: 'sm' },
          { type: 'separator', margin: 'lg', color: C.line },
          { type: 'text', margin: 'lg', size: 'sm', color: C.ink, wrap: true,
            text: `缺口方程式：需 ${need} − 排 ${sched} ＝ 缺 ${gapCells.length} → 可吸收 ${fills.length} ＝ 殘餘 ${residual}` },
          { type: 'text', text: '三班排班補足率（本週）', weight: 'bold', size: 'sm', color: C.ink, margin: 'xl' },
          ...fillBars,
          { type: 'text', text: `近 30 天代班分佈（S1 飽和線 ${sat} 次）`, weight: 'bold', size: 'sm', color: C.ink, margin: 'xl' },
          ...fairBars,
          { type: 'separator', margin: 'lg', color: C.line },
          kpiRow('殘餘缺口', `${residual} 班次`, residual ? C.red : C.green),
          kpiRow(`帶班平衡（最弱：${SHIFT_TYPES[worst.code].name}）`, `${worst.ok}/${worst.staffed} 天`, worst.ok < worst.staffed ? C.red : C.green),
          kpiRow('資格單點依賴', `${sp.length} 項`, sp.length ? C.red : C.green),
          kpiRow('證照 過期＋將到期', `${expired}＋${expSoon}`, (expired + expSoon) ? C.amber : C.green),
          kpiRow('結構性缺口', structural.length ? structural.map((s) => SHIFT_TYPES[s.shift].name).join('、') : '無', structural.length ? C.red : C.green),
          { type: 'separator', margin: 'lg', color: C.line },
          { type: 'text', text: '需要行動', weight: 'bold', size: 'sm', color: C.ink, margin: 'lg' },
          ...(actions.length ? actions.slice(0, 3).map((t) => ({
            type: 'text', text: `・${t}`, size: 'xs', color: C.ink, wrap: true, margin: 'sm',
          })) : [{ type: 'text', text: '目前無需行動事項', size: 'xs', color: C.faint, margin: 'sm' }]),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: 'md',
        contents: [{
          type: 'button', style: 'primary', height: 'sm', color: C.brand,
          action: { type: 'uri', label: '開啟完整儀表板', uri: liffUrl || platformUrl },
        }],
      },
    },
  };
}

/* ══ 指令三兄弟：換班預檢／調度棋盤／負荷雷達 ═══════════════
 * LINE 的本質是「人不在電腦前」的時刻：同仁在 LINE 談好換班、
 * 值班督導半夜接到倒人電話、主任在外開會想看誰快被壓垮。
 * 三個指令都跑與平台完全相同的引擎，bot 只給建議不做決定。 */

function deepLink(platformUrl, hash) {
  return `${String(platformUrl || '').replace(/\/?$/, '/')}index.html#${hash}`;
}

/** M/D → YYYY-MM-DD（年份取示範週；完整日期原樣通過），無法解析回 null */
function expandDate(t) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isValidDateStr(t) ? t : null;
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (!m) return null;
  const full = `${WEEK_DATES[0].slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return isValidDateStr(full) ? full : null;
}

const SWAP_USAGE = [
  '【換班預檢】用法：',
  '換班 甲代號 甲的班日期 乙代號 乙的班日期',
  '例：換班 N-01 8/3 N-02 8/5',
  '',
  '我會模擬互換後兩人各自重跑 H1–H10（班距、連續天數、',
  '四週彈性工時、資格效期、母性保護…），綠燈紅燈都給依據。',
  '＊必要資格以院內政策（ACLS）檢查；特殊資格請至平台換班簽核頁',
].join('\n');

function swapCommand(text, platformUrl, db) {
  if (!/^換班/.test(text)) return null;
  const tokens = text.slice(2).trim().split(/[\s,、⇄]+/).filter(Boolean);
  if (tokens.length === 0) return { text: SWAP_USAGE, items: null };
  if (tokens.length !== 4) {
    return { text: `格式不對（需要 4 個欄位，收到 ${tokens.length} 個）。\n\n${SWAP_USAGE}`, items: null };
  }
  const [idA, dA0, idB, dB0] = tokens;
  const A = idA.toUpperCase();
  const B = idB.toUpperCase();
  const dA = expandDate(dA0);
  const dB = expandDate(dB0);
  if (!dA || !dB) return { text: `日期看不懂（收到「${dA0}」「${dB0}」），請用 8/5 或 2026-08-05 格式。`, items: null };

  const live = liveData(db);
  const pick = (id, d) => live.shifts.filter((s) => s.staffId === id && s.date === d);
  const rowsA = pick(A, dA);
  const rowsB = pick(B, dB);
  if (!live.staff.some((s) => s.id === A)) return { text: `查無人員 ${A}（請用代號，如 N-01）。`, items: null };
  if (!live.staff.some((s) => s.id === B)) return { text: `查無人員 ${B}（請用代號，如 N-01）。`, items: null };
  if (!rowsA.length) return { text: `${A} 在 ${shortDate(dA)}（${weekdayOf(dA)}）沒有班次，無班可換。`, items: null };
  if (!rowsB.length) return { text: `${B} 在 ${shortDate(dB)}（${weekdayOf(dB)}）沒有班次，無班可換。`, items: null };

  const a = { staffId: A, date: dA, shift: rowsA[0].shift };
  const b = { staffId: B, date: dB, shift: rowsB[0].shift };
  const r = platformEngine(db).analyzeSwap(a, b, { requiredCerts: ['ACLS'] });
  if (r.error) return { text: `無法預檢：${r.error}`, items: null };

  const label = (q) => `${shortDate(q.date)}（${weekdayOf(q.date)}）${SHIFT_TYPES[q.shift].name}`;
  const side = (take) => take.violations.length
    ? `✗ ${take.staff.id} 承接 ${label(take.slot)}\n${take.violations.map((v) => `　⛔ ${v.code}：${v.detail}`).join('\n')}`
    : `✓ ${take.staff.id} 承接 ${label(take.slot)}——通過全部硬性約束`;

  return {
    text: [
      `【換班預檢】${A} ${label(a)} ⇄ ${B} ${label(b)}`, '',
      side(r.aTake), '', side(r.bTake), '',
      ...(r.notices.length ? [r.notices.map((n) => `・${n}`).join('\n'), ''] : []),
      r.ok
        ? '✅ 雙向皆通過 H1–H10。核准與寫回請至平台「換班簽核」完成（決策留痕）：\n' + deepLink(platformUrl, 'swap')
        : '⛔ 存在硬性違規，不可核准——請改談其他班次；門檻依據見平台規則庫。',
      '',
      '＊預檢由確定性引擎計算；機器人不做核准決定',
    ].join('\n'),
    items: null,
  };
}

const DISPATCH_RE = /^(?:調度|棋盤|借調)(?:\s+(\S+))?(?:\s+(\S+))?$/;
const SHIFT_WORDS = { D: 'D', 白: 'D', 白班: 'D', E: 'E', 小夜: 'E', 晚班: 'E', N: 'N', 大夜: 'N', 夜班: 'N' };

function dispatchCommand(text, platformUrl, db) {
  const m = DISPATCH_RE.exec(text);
  if (!m) return null;
  const date = m[1] ? expandDate(m[1]) : GAP_EVENT.raisedAt.slice(0, 10);
  const shift = m[2] ? SHIFT_WORDS[m[2].toUpperCase()] || SHIFT_WORDS[m[2]] : 'E';
  if (!date || !shift) {
    return { text: '用法：調度 [日期] [班別]\n例：調度 8/9 大夜（不帶參數＝示範今日的小夜）', items: null };
  }

  const eng = platformEngine(db);
  const r = eng.dispatchAnalysis({ date, shift, toUnit: '', demand: UNIT_MIN_STAFF, requiredCerts: ['ACLS'] });
  const MARK = { deficit: '🔴', tight: '🟡', surplus: '🟢' };
  const boardLines = r.board.map((b) => `${MARK[b.status]} ${UNITS[b.unit] || b.unit}　${b.scheduled}／需 ${b.need}` +
    `${b.status === 'surplus' ? `（+${b.scheduled - b.need}）` : b.status === 'deficit' ? `（缺 ${b.need - b.scheduled}）` : ''}` +
    `｜${b.onDuty.join('、') || '無人在班'}`);

  const deficits = r.board.filter((b) => b.status === 'deficit').slice(0, 2);
  const findLines = deficits.flatMap((defUnit) => {
    const dr = eng.dispatchAnalysis({ date, shift, toUnit: defUnit.unit, demand: UNIT_MIN_STAFF, requiredCerts: ['ACLS'] });
    if (!dr.candidates.length) {
      return [`→ ${UNITS[defUnit.unit] || defUnit.unit}：無人可合法借調（守恆律——不拆貼線單位），請走替補流程或任務重分配。`];
    }
    return [`→ 可借調至${UNITS[defUnit.unit] || defUnit.unit}：` + dr.candidates.slice(0, 3).map((c) =>
      `${c.staff.id}（${UNITS[c.fromUnit] || c.fromUnit}${c.flags.length ? '，⚠' : ''}）`).join('、')];
  });

  return {
    text: [
      `【調度棋盤】${shortDate(date)}（${weekdayOf(date)}）${SHIFT_TYPES[shift].name}`,
      '守恆律：借調不能讓支援單位自己變成缺口。', '',
      ...boardLines, '',
      ...(findLines.length ? [...findLines, ''] : []),
      '換個時點：輸入「調度 8/9 白」「調度 8/9 大夜」',
      '完整分析與值班演示情境：' + deepLink(platformUrl, 'dispatch'),
      '',
      '＊需求口徑＝各單位最低配置（示範）；示範資料部分單位為部分名單',
    ].join('\n'),
    items: null,
  };
}

const RETENTION_RE = /^(?:負荷|留任|雷達)$/;

function retentionCommand(text, platformUrl, db) {
  if (!RETENTION_RE.test(text)) return null;
  const led = platformEngine(db).workloadLedger(WEEK_DATES);
  const flagged = led.staff.filter((x) => x.flags.length > 0);
  const lines = flagged.length
    ? flagged.map((x) => `⚠ ${x.staff.id}（${UNITS[x.staff.unit] || x.staff.unit}）\n` +
      x.flags.map((f) => `　・${f.text}`).join('\n'))
    : ['以目前班表與門檻，沒有人落入高負荷名單。'];
  const uneven = led.units.filter((u) => u.staffCount > 0 && u.nightMax - u.nightMin >= 3);

  return {
    text: [
      '【負荷雷達】本週（非離職預測——是確定性的負荷會計）', '',
      ...lines, '',
      ...(uneven.length ? [uneven.map((u) => `・${UNITS[u.unit] || u.unit} 夜班分佈不均（最多 ${u.nightMax}／最少 ${u.nightMin}）`).join('\n'), ''] : []),
      '完整五維帳與單位比較：' + deepLink(platformUrl, 'retention'),
      '',
      '＊旗標門檻與平台規則庫連動；解讀與關懷面談由主管進行',
    ].join('\n'),
    items: null,
  };
}

const GUIDE_RE = /^(?:使用說明|說明|教學|指南|怎麼用|使用方式)$/;

/** 使用說明：完整教學一頁看完，附「照著打」的快速按鈕（圖文選單底部說明列也指到這裡） */
function guideCommand(text, platformUrl, liffUrl) {
  if (!GUIDE_RE.test(text)) return null;
  return {
    text: [
      '【班守 ShiftGuard】使用說明',
      '',
      '■ 通報缺班（最常用）',
      '直接把請假訊息傳給我，例如：',
      '「護理長不好意思，我明天白班發燒沒辦法上」',
      '沒寫到的條件我會用按鈕問你——不臆測、不亂猜；',
      '解析完成後給合規替補建議，每一位都附排序依據。',
      '',
      '■ 快速指令',
      '・儀表板 —— 本週戰情卡：缺口、補足率、代班分佈',
      '・換班 N-01 8/3 N-02 8/5 —— 互換前先預檢，',
      '　兩人各自重跑 H1–H10，紅燈逐條附規則代碼',
      '・調度 8/9 大夜 —— 全院缺口🔴貼線🟡餘裕🟢，',
      '　借調建議含守恆律檢查（不讓支援單位變缺口）',
      '・負荷 —— 高負荷名單，誰一直在扛看得見',
      '・選單 —— 隨時叫出功能快速按鈕',
      '',
      '■ 小抄',
      '日期可寫 8/9，也可寫「明天」「禮拜天」；',
      '班別寫 白班／小夜／大夜；人員一律用代號（如 N-01）。',
      '訊息中請勿包含任何病人資訊。',
      '',
      '■ 誠實原則',
      '示範資料、非真實人員；建議必附依據；',
      '我不代替主管決定——正式核准與決策留痕請回平台。',
    ].join('\n'),
    items: [
      { type: 'action', action: { type: 'message', label: '📊 試試儀表板', text: '儀表板' } },
      { type: 'action', action: { type: 'message', label: '🔁 試試換班預檢', text: '換班 N-01 8/3 N-02 8/5' } },
      { type: 'action', action: { type: 'message', label: '🧭 試試調度棋盤', text: '調度 8/9 大夜' } },
      { type: 'action', action: { type: 'message', label: '📝 通報範例', text: '護理長不好意思，我明天白班發燒沒辦法上，很抱歉' } },
      { type: 'action', action: { type: 'uri', label: '🌐 開啟平台', uri: liffUrl || platformUrl } },
    ],
  };
}

/** 四個指令的統一入口：命中回訊息物件，未命中回 null（宿主一行接入） */
function extraCommand(text, platformUrl, liffUrl, db) {
  return swapCommand(text, platformUrl, db)
    || dispatchCommand(text, platformUrl, db)
    || retentionCommand(text, platformUrl, db)
    || guideCommand(text, platformUrl, liffUrl);
}

const DASHBOARD_RE = /^(儀表板|戰情|狀態|缺口|dashboard)$/i;
const MENU_RE = /^(選單|功能|幫助|menu|help)$/i;

/** 功能選單：快速按鈕（圖文選單 Rich Menu 的輕量版，隨時可叫出） */
function menuMessage(platformUrl, liffUrl) {
  return {
    type: 'text',
    text: '請選擇功能（也可以直接把請假訊息傳給我）：',
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '📊 戰情儀表板', text: '儀表板' } },
      { type: 'action', action: { type: 'message', label: '🔁 換班預檢', text: '換班' } },
      { type: 'action', action: { type: 'message', label: '🧭 調度棋盤', text: '調度' } },
      { type: 'action', action: { type: 'message', label: '📈 負荷雷達', text: '負荷' } },
      { type: 'action', action: { type: 'message', label: '📝 通報範例', text: '護理長不好意思，我明天白班發燒沒辦法上，很抱歉' } },
      { type: 'action', action: { type: 'uri', label: '🌐 開啟平台', uri: liffUrl || platformUrl } },
      { type: 'action', action: { type: 'message', label: '📖 使用說明', text: '使用說明' } },
      { type: 'action', action: { type: 'uri', label: 'ℹ️ 功能介紹', uri: platformUrl.replace(/\/?$/, '/') + 'home.html' } },
    ] },
  };
}

const welcomeText = (platformUrl) => [
  '【班守 ShiftGuard】值班通報機器人',
  '',
  '五種用法：',
  '① 通報缺班：直接傳請假訊息，例如',
  '　「護理長不好意思，我明天白班發燒沒辦法上」',
  '　我會解析並用按鈕補條件，給你合規替補建議。',
  '② 換班預檢：「換班 N-01 8/3 N-02 8/5」——',
  '　互換後兩人各自重跑 H1–H10，綠燈紅燈都給依據。',
  '③ 調度棋盤：「調度 8/9 大夜」——全院缺口／貼線／',
  '　餘裕一眼看，借調建議附守恆律檢查。',
  '④ 看戰情：輸入「儀表板」，回覆本週缺口、',
  '　帶班平衡、單點依賴與需要行動的事項。',
  '⑤ 負荷雷達：輸入「負荷」，看誰一直在扛。',
  '',
  '隨時輸入「選單」叫出快速按鈕、「使用說明」看完整教學。',
  '規則 H1–H10（含四週彈性工時與母性保護），與平台同一份引擎。',
  '提醒：請以人員代號通報；訊息中請勿包含任何病人資訊。',
  `平台入口：${platformUrl}`,
].join('\n');

/* ══ Stage 1 地基：身分綁定與留痕（docs/LINEBOT-STAGE1.md §2.2、§2.4）══════
 *
 * 這一段是純邏輯：透過注入的 `store` 存取狀態，本檔不知道 D1 是什麼。
 * 宿主（cloudflare/linebot/store-d1.mjs）實作以下介面；測試用記憶體假物件即可：
 *
 *   store.issueBindCode({ code, staffId, tier, issuedBy, issuedAt, expiresAt })
 *   store.consumeBindCode(code, nowIso) → { staff_id, tier, expires_at, used_at } | null
 *       （回傳同時把 used_at 寫入；已用過或不存在回 null）
 *   store.bindIdentity({ lineUserId, staffId, unit, role, tier, boundAt })
 *       → { replacedLineUserId: string | null }   （同代號重綁＝換手機，舊帳號失效）
 *   store.appendAudit({ ts, actor, action, payload })   （雜湊鏈由 store 計算）
 *
 * 所有時間為 ISO 字串、由呼叫端注入（`now`），確保可測且與 cron 同一口徑。
 */

const BIND_CODE_TTL_MIN = 30;
/* 寬鬆解析：手機上打字會有全形數字、沒空格、小寫 n、漏連字號、句尾標點——
 * 先正規化再比對，代號一律還原成 N-兩位。命中與否只看語義，不看排版。 */
const ISSUE_RE = /^發碼[:：]?\s*n-?(\d{1,2})(?:\s+(\S+))?$/i;   // 第 2 組：權責層（可省略）
const BIND_RE = /^綁定[:：]?\s*n-?(\d{1,2})[\s,，、]+(\d{6})$/i;

/* ── 權責層（tier）與權限矩陣：docs/LINEBOT-STAGE1.md §2.5 ─────────────
 * 職級（role）判資格是引擎的事；權責層判權限是 bot 的事，由管理者發碼時授權。
 * 三層照抄平台 ROLES：staff 護理師 → head 護理長 → exec 督導／主任，上級涵蓋下級。 */
const TIERS = { staff: 0, head: 1, exec: 2 };
const TIER_LABEL = { staff: '護理師', head: '護理長', exec: '督導／主任' };
const TIER_WORDS = { 護理師: 'staff', 護理長: 'head', 督導: 'exec', 主任: 'exec', 督導主任: 'exec' };

/** 發碼時的權責層字詞 → tier；省略＝staff；不認得＝null（呼叫端回錯） */
function tierFromWord(w) {
  if (w === undefined || w === null || w === '') return 'staff';
  return TIER_WORDS[String(w).trim()] || null;
}

/** 指令 → 所需最低權責層（矩陣的唯一真相來源；圖文選單與閘門都從這裡生） */
const COMMAND_MIN_TIER = {
  menu: 'staff', guide: 'staff', report: 'staff', swap: 'staff',
  dashboard: 'head',
  retention: 'exec', dispatch: 'exec',
};
const COMMAND_LABEL = {
  menu: '選單', guide: '使用說明', report: '通報缺班', swap: '換班預檢',
  dashboard: '儀表板', retention: '負荷雷達', dispatch: '調度棋盤',
};

/** 把一句文字歸類成指令鍵；非指令的一律視為通報（report） */
function classifyCommand(text) {
  const t = String(text || '').trim();
  if (DASHBOARD_RE.test(t)) return 'dashboard';
  if (MENU_RE.test(t)) return 'menu';
  if (GUIDE_RE.test(t)) return 'guide';
  if (/^換班/.test(t)) return 'swap';
  if (DISPATCH_RE.test(t)) return 'dispatch';
  if (RETENTION_RE.test(t)) return 'retention';
  return 'report';
}

function commandAllowed(tier, key) {
  const need = COMMAND_MIN_TIER[key];
  if (need === undefined) return false;
  return (TIERS[tier] ?? -1) >= TIERS[need];
}

/** 權限不足的誠實回覆：說清楚屬哪一層、你是哪一層，不假裝指令不存在 */
function tierDeniedText(key, tier) {
  const need = COMMAND_MIN_TIER[key];
  return [
    `「${COMMAND_LABEL[key] || key}」屬${TIER_LABEL[need]}以上視角；你目前的權責層是${TIER_LABEL[tier] || tier}。`,
    '需要調整權責請找管理者重新發碼、重新綁定（會留痕）。',
  ].join('\n');
}

function normalizeCmdText(text) {
  return String(text || '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30))   // 全形數字 → 半形
    .replace(/[Ｎｎ]/g, 'N')                                                             // 全形 N
    .replace(/[－—–]/g, '-')                                                             // 各種橫線 → 連字號
    .replace(/[　\t]/g, ' ')                                                         // 全形空白 → 半形
    .replace(/[。．.!！]+$/g, '')                                                         // 句尾標點
    .trim();
}
const padStaffId = (n) => 'N-' + String(Number(n)).padStart(2, '0');

const STORE_DISABLED_TEXT = '此部署尚未啟用資料庫，綁定與狀態功能不可用（示範模式）。';

const BIND_HELP = [
  '【班守 ShiftGuard】此為院內內部系統，你的 LINE 尚未綁定人員代號。',
  '請向單位管理者索取一次性綁定碼，然後輸入：',
  '　綁定 你的代號 六位數綁定碼',
  '例：綁定 N-04 483920',
  '',
  '綁定碼 30 分鐘內有效、用過即作廢；綁定後即可使用全部功能。',
].join('\n');

/** 六位數綁定碼。rand 可注入（測試用），預設 Math.random。 */
function genBindCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 6; i += 1) s += Math.floor(rand() * 10);
  return s;
}

/** 把 ISO 時間往後推 n 分鐘（純字串進出，不依賴時區） */
function isoPlusMinutes(iso, n) {
  return new Date(new Date(iso).getTime() + n * 60_000).toISOString();
}

/** 解析 Stage 1 指令：命中回 { kind, ... }，未命中回 null */
function stage1Command(text) {
  const t = normalizeCmdText(text);
  let m = ISSUE_RE.exec(t);
  if (m) return { kind: 'issue', staffId: padStaffId(m[1]), tierWord: m[2] || '' };
  m = BIND_RE.exec(t);
  if (m) return { kind: 'bind', staffId: padStaffId(m[1]), code: m[2] };
  return null;
}

/**
 * 發碼（管理者專用；是否為管理者由宿主判定後才呼叫）。
 * adminHash：管理者 line_user_id 的雜湊——留痕只存雜湊、不存原值。
 */
async function issueBindCodeFlow({ staffId, tierWord, adminHash, now, store, db, rand }) {
  if (!store) return { text: STORE_DISABLED_TEXT };
  const tier = tierFromWord(tierWord);
  if (!tier) {
    return { text: `權責層「${tierWord}」不認得。可用：護理長、督導（或主任）；省略＝護理師。例：發碼 ${staffId} 護理長` };
  }
  const staff = liveData(db).staff.find((s) => s.id === staffId);
  if (!staff) return { text: `查無人員 ${staffId}，未發碼。請確認代號（如 N-04）與人員快照是否已上傳。` };
  const code = genBindCode(rand);
  const expiresAt = isoPlusMinutes(now, BIND_CODE_TTL_MIN);
  await store.issueBindCode({ code, staffId, tier, issuedBy: adminHash, issuedAt: now, expiresAt });
  await store.appendAudit({ ts: now, actor: null, action: 'bind_code.issued',
    payload: { staffId, tier, issuedBy: adminHash, expiresAt } });
  return {
    text: [
      `已為 ${staffId}（${UNITS[staff.unit] || staff.unit}｜權責層：${TIER_LABEL[tier]}）產生綁定碼：`,
      '',
      `　${code}`,
      '',
      `${BIND_CODE_TTL_MIN} 分鐘內有效、用過即作廢。請以院內管道交給本人，`,
      `本人輸入「綁定 ${staffId} ${code}」即完成。`,
    ].join('\n'),
  };
}

/**
 * 綁定（任何人可呼叫；未綁定者也能——這正是它存在的理由）。
 * lineUserHash 只用於留痕；lineUserId 原值進 identity（推播要用）。
 */
async function bindFlow({ lineUserId, lineUserHash, staffId, code, now, store, db }) {
  if (!store) return { text: STORE_DISABLED_TEXT };
  const rec = await store.consumeBindCode(code, now);
  const reject = async (why) => {
    await store.appendAudit({ ts: now, actor: null, action: 'bind.rejected',
      payload: { staffId, lineUser: lineUserHash, why } });
    return { text: '綁定失敗：綁定碼無效、已過期或已使用。請向管理者重新索取。' };
  };
  if (!rec) return reject('no-such-or-used');
  if (rec.staff_id !== staffId) return reject('staff-mismatch');
  if (rec.expires_at < now) return reject('expired');
  const staff = liveData(db).staff.find((s) => s.id === staffId);
  if (!staff) return reject('staff-not-in-snapshot');

  const tier = TIERS[rec.tier] !== undefined ? rec.tier : 'staff';
  const { replacedLineUserId } = await store.bindIdentity({
    lineUserId, staffId, unit: staff.unit, role: staff.role, tier, boundAt: now,
  });
  await store.appendAudit({ ts: now, actor: staffId, action: 'bind.completed',
    payload: { staffId, tier, lineUser: lineUserHash, replaced: Boolean(replacedLineUserId) } });
  return {
    text: [
      `已綁定為 ${staffId}（${UNITS[staff.unit] || staff.unit}｜${staff.role}｜權責層：${TIER_LABEL[tier]}）。`,
      replacedLineUserId ? '此代號先前綁定的 LINE 帳號已失效（換手機情境）。' : '',
      '輸入「選單」查看可用功能。',
    ].filter(Boolean).join('\n'),
  };
}

/**
 * 留痕鏈的規範化字串：hash = sha256(auditCanonical(entry))
 * 欄位順序固定、以 | 分隔——與平台端 chainValid 同一精神，改任何一筆後續全斷。
 */
function auditCanonical({ prevHash, ts, actor, action, payloadJson }) {
  return [prevHash || '', ts, actor === null || actor === undefined ? '' : actor, action, payloadJson].join('|');
}

/* 讓 Workers（esbuild）、Lambda（CJS interop）、瀏覽器測試頁與 Node CI 共用 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FIELD_TW, encodeParams, decodeParams, askNext, buildGap, runEngine,
    evaluateAndFormat, draftAndFormat, buildDashboardFlex,
    DASHBOARD_RE, MENU_RE, GUIDE_RE, menuMessage, welcomeText,
    swapCommand, dispatchCommand, retentionCommand, guideCommand, extraCommand, expandDate,
    // Stage 1 地基
    liveData, platformEngine,
    BIND_CODE_TTL_MIN, BIND_HELP, STORE_DISABLED_TEXT,
    genBindCode, isoPlusMinutes, stage1Command, issueBindCodeFlow, bindFlow, auditCanonical,
    TIERS, TIER_LABEL, COMMAND_MIN_TIER, COMMAND_LABEL,
    tierFromWord, classifyCommand, commandAllowed, tierDeniedText,
  };
}
