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
    r: qs.get('r'),                                  // Phase 1：事由類別（病假／事假…），隨按鈕流程帶著走
    rq: qs.get('rq'),                                // Phase 1：替班請求代號
    act: qs.get('act'),                              // Phase 1：approve | reject | skip | accept | decline
    who: qs.get('who'),                              // Phase 1：略過的候選代號
    cy: qs.get('cy'),                                // Phase 2：預班週期代號（UNIT:YYYY-MM）
  };
}

/* ── 逐步補條件：缺什麼就出哪一組按鈕 ── */

function askNext(p) {
  const base = { d: p.d, s: p.s, u: p.u, c: p.c, r: p.r };
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
function buildDashboardFlex(platformUrl, liffUrl, db, unit, note) {
  const C = FLEX_C;
  const eng = platformEngine(db);
  const live = liveData(db);
  const UNIT = unit || 'MED-3A';
  if (!live.staff.some((s) => s.unit === UNIT)) {
    // 這個單位在目前資料裡沒有任何人員（例：示範資料只有內科 3A）——誠實說，不硬畫
    return {
      type: 'flex', altText: `班守戰情：${UNITS[UNIT] || UNIT} 目前沒有人員與班表資料`,
      contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: [
        { type: 'text', text: '班守 ShiftGuard｜本週戰情', weight: 'bold', size: 'md', color: C.ink },
        { type: 'text', text: `${UNITS[UNIT] || UNIT}${note ? '・' + note : ''}`, size: 'xs', color: C.faint, margin: 'sm', wrap: true },
        { type: 'text', text: '這個單位目前沒有人員與班表資料，無法計算缺口、補足率與代班分佈。', size: 'sm', color: C.ink, wrap: true, margin: 'lg' },
        { type: 'text', text: '請確認人員快照是否已上傳（tools/snapshot-to-sql.cjs），或改看其他單位。', size: 'xs', color: C.faint, wrap: true, margin: 'md' },
      ] } },
    };
  }
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
  const topStandby = live.staff.filter((s) => s.unit === UNIT)
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
          { type: 'text', text: `${UNITS[UNIT]}・本週（示範資料）${note ? '・' + note : ''}`, size: 'xs', color: C.faint, margin: 'sm', wrap: true },
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

function retentionCommand(text, platformUrl, db, scope) {
  if (!RETENTION_RE.test(text)) return null;
  const led = platformEngine(db).workloadLedger(WEEK_DATES);
  const inScope = (unit) => !scope || !scope.unit || unit === scope.unit;
  const flagged = led.staff.filter((x) => x.flags.length > 0 && inScope(x.staff.unit));
  const lines = flagged.length
    ? flagged.map((x) => `⚠ ${x.staff.id}（${UNITS[x.staff.unit] || x.staff.unit}）\n` +
      x.flags.map((f) => `　・${f.text}`).join('\n'))
    : ['以目前班表與門檻，沒有人落入高負荷名單。'];
  const uneven = (scope && scope.unit) ? [] : led.units.filter((u) => u.staffCount > 0 && u.nightMax - u.nightMin >= 3);

  return {
    text: [
      `【負荷雷達】${scope && scope.unit ? UNITS[scope.unit] || scope.unit : '全院'}・本週（非離職預測——是確定性的負荷會計）`, '',
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
function guideCommand(text, platformUrl, liffUrl, tier = 'exec') {
  if (!GUIDE_RE.test(text)) return null;
  const can = (k) => commandAllowed(tier, k);
  const cmds = [
    can('dashboard') && '・儀表板 —— 本週戰情卡：缺口、補足率、代班分佈' + (can('dispatch') ? '（可加單位：儀表板 ICU）' : '（本單位）'),
    can('pending') && '・待核准 —— 本單位待你核准的替班請求，附核准／駁回／調整鍵',
    can('swap') && '・換班 N-01 8/3 N-02 8/5 —— 互換前先預檢，\n　兩人各自重跑 H1–H10，紅燈逐條附規則代碼',
    can('myask') && '・我的邀請 —— 重看正在等你回覆的替班詢問',
    can('opencycle') && '・開啟預班 10月 —— 開下個月的預假收集（可加：截止 9/25、上限 3）；\n　預班狀態／催繳／關閉預班 —— 看進度、手動催、提前截止並生成草稿',
    can('requirement') && '・需求 —— 看本單位生成草稿的每班人數；設定需求 D2 E1 N1 —— 改（留痕）',
    can('prebook') && '・預假 10/3 10/4 —— 回覆下個月想休的日期（截止前可改，最後一次為準；不需要回「預假 無」）；\n　我的預假 —— 看自己這期送了什麼（附日曆連結）',
    can('platform') && '・平台 —— 拿一條本人專屬的登入連結，開啟平台後改讀雲端即時班表、視角鎖定你的權責層',
    can('dispatch') && '・調度 8/9 大夜 —— 全院缺口🔴貼線🟡餘裕🟢，\n　借調建議含守恆律檢查（不讓支援單位變缺口）',
    can('retention') && '・負荷 —— 高負荷名單，誰一直在扛看得見',
    can('whoami') && '・我是誰 —— 綁定身分與權責層',
    '・選單 —— 隨時叫出功能快速按鈕',
  ].filter(Boolean);
  return {
    text: [
      `【班守 ShiftGuard】使用說明（${TIER_LABEL[tier] || tier}視角）`,
      '',
      '■ 通報缺班（最常用）',
      '直接把請假訊息傳給我，例如：',
      '「護理長不好意思，我明天白班發燒沒辦法上」',
      '沒寫到的條件我會用按鈕問你——不臆測、不亂猜；',
      '條件齊全後建立替班請求、送護理長核准；核准後機器人逐一詢問候選，每一步留痕。',
      '',
      '■ 快速指令',
      ...cmds,
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
      can('dashboard') && { type: 'action', action: { type: 'message', label: '📊 試試儀表板', text: '儀表板' } },
      { type: 'action', action: { type: 'message', label: '🔁 試試換班預檢', text: '換班 N-01 8/3 N-02 8/5' } },
      can('dispatch') && { type: 'action', action: { type: 'message', label: '🧭 試試調度棋盤', text: '調度 8/9 大夜' } },
      { type: 'action', action: { type: 'message', label: '📝 通報缺班', text: '通報缺班' } },
      { type: 'action', action: { type: 'uri', label: '🌐 開啟平台', uri: liffUrl || platformUrl } },
    ].filter(Boolean),
  };
}

/** 四個指令的統一入口：命中回訊息物件，未命中回 null（宿主一行接入） */
function extraCommand(text, platformUrl, liffUrl, db, ctx = {}) {
  return swapCommand(text, platformUrl, db)
    || dispatchCommand(text, platformUrl, db)
    || retentionCommand(text, platformUrl, db, ctx.scope)
    || guideCommand(text, platformUrl, liffUrl, ctx.tier || 'exec');
}

const DASHBOARD_RE = /^(儀表板|戰情|狀態|缺口|dashboard)(?:\s+(\S+))?$/i;   // 尾端可指定單位（exec 用）

/* ── 資料範圍（Phase 1.6，docs/LINEBOT-STAGE1.md §2.5）──
 * scope = { unit } 表示只看該單位；null 表示全院。head／staff 鎖在自己的單位，exec 與管理者全院。 */
function resolveScope(identity, tier) {
  if (TIERS[tier] >= TIERS.exec) return null;
  return identity && identity.unit ? { unit: identity.unit } : null;
}
/** 把「儀表板 ICU」「儀表板 內科」之類的尾端字詞解析成單位代碼；認不得回 null */
function parseUnitWord(w) {
  if (!w) return null;
  const t = String(w).trim();
  const byCode = Object.keys(UNITS).find((k) => k.toLowerCase() === t.toLowerCase());
  if (byCode) return byCode;
  const byName = Object.entries(UNITS).find(([, name]) => name.includes(t) || t.includes(name.replace(/病房.*$/, '')));
  return byName ? byName[0] : null;
}
/** 儀表板要看哪個單位：有範圍就鎖範圍（指定別單位時附註），全院者可指定，預設示範單位 */
function dashboardUnit(text, scope) {
  const m = DASHBOARD_RE.exec(String(text || '').trim());
  const asked = m ? parseUnitWord(m[2]) : null;
  if (scope && scope.unit) {
    return { unit: scope.unit, note: asked && asked !== scope.unit ? `你的範圍是 ${UNITS[scope.unit]}，已改顯示本單位` : '' };
  }
  return { unit: asked || 'MED-3A', note: '' };
}
const MENU_RE = /^(選單|功能|幫助|menu|help)$/i;

/** 功能選單：快速按鈕（圖文選單 Rich Menu 的輕量版，隨時可叫出） */
/** 功能選單：依權責層過濾（§2.5 矩陣），示範模式（無身分）視同 exec 全開 */
function menuMessage(platformUrl, liffUrl, tier = 'exec') {
  const all = [
    ['dashboard',   { type: 'message', label: '📊 戰情儀表板', text: '儀表板' }],
    ['pending',     { type: 'message', label: '✅ 待核准', text: '待核准' }],
    ['reportguide', { type: 'message', label: '📝 通報缺班', text: '通報缺班' }],
    ['swap',        { type: 'message', label: '🔁 換班預檢', text: '換班' }],
    ['myask',       { type: 'message', label: '🔔 我的邀請', text: '我的邀請' }],
    ['cyclestatus', { type: 'message', label: '🗓 預班狀態', text: '預班狀態' }],
    ['myprebook',   { type: 'message', label: '🗓 我的預假', text: '我的預假' }],
    ['dispatch',    { type: 'message', label: '🧭 調度棋盤', text: '調度' }],
    ['retention',   { type: 'message', label: '📈 負荷雷達', text: '負荷' }],
    ['menu',        { type: 'uri', label: '🌐 開啟平台', uri: liffUrl || platformUrl }],
    ['guide',       { type: 'message', label: '📖 使用說明', text: '使用說明' }],
    ['menu',        { type: 'uri', label: 'ℹ️ 功能介紹', uri: platformUrl.replace(/\/?$/, '/') + 'home.html' }],
  ];
  return {
    type: 'text',
    text: '請選擇功能（也可以直接把請假訊息傳給我）：',
    quickReply: { items: all.filter(([k]) => commandAllowed(tier, k)).map(([, action]) => ({ type: 'action', action })) },
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
  myask: 'staff', whoami: 'staff', reportguide: 'staff', bindguide: 'staff',
  prebook: 'staff', myprebook: 'staff', platform: 'staff',
  dashboard: 'head', pending: 'head', manage: 'head',
  opencycle: 'head', cyclestatus: 'head', remindnow: 'head', closecycle: 'head', publish: 'head', requirement: 'head',
  retention: 'exec', dispatch: 'exec',
};
const COMMAND_LABEL = {
  menu: '選單', guide: '使用說明', report: '通報缺班', swap: '換班預檢',
  myask: '我的邀請', whoami: '我是誰', reportguide: '通報引導', bindguide: '綁定說明',
  prebook: '預假', myprebook: '我的預假', platform: '平台登入',
  dashboard: '儀表板', pending: '待核准', manage: '核准／調整替班',
  opencycle: '開啟預班', cyclestatus: '預班狀態', remindnow: '催繳預班', closecycle: '截止預班', publish: '核准公告班表', requirement: '生成需求',
  retention: '負荷雷達', dispatch: '調度棋盤',
};

/** 把一句文字歸類成指令鍵；非指令的一律視為通報（report） */
function classifyCommand(text) {
  const t = String(text || '').trim();
  if (PENDING_RE.test(t)) return 'pending';
  if (MYASK_RE.test(t)) return 'myask';
  if (WHOAMI_RE.test(t)) return 'whoami';
  if (REPORT_GUIDE_RE.test(t)) return 'reportguide';
  if (BIND_GUIDE_RE.test(t)) return 'bindguide';
  if (phase15Command(t)) return 'manage';
  if (OPEN_CYCLE_RE.test(normalizeCmdText(t))) return 'opencycle';
  if (CYCLE_STATUS_RE.test(t)) return 'cyclestatus';
  if (REMIND_NOW_RE.test(t)) return 'remindnow';
  if (CLOSE_CYCLE_RE.test(t)) return 'closecycle';
  if (REQ_RE.test(normalizeCmdText(t))) return 'requirement';
  if (MYPREBOOK_RE.test(t)) return 'myprebook';
  if (PLATFORM_LOGIN_RE.test(t)) return 'platform';
  if (PREBOOK_RE.test(normalizeCmdText(t))) return 'prebook';
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
      '下方選單已切換為你的身分版本；輸入「選單」也可查看可用功能。',
    ].filter(Boolean).join('\n'),
    bound: { staffId, tier, replacedLineUserId },   // 宿主據此掛對應 tier 的圖文選單、解除舊帳號的
  };
}

/**
 * 留痕鏈的規範化字串：hash = sha256(auditCanonical(entry))
 * 欄位順序固定、以 | 分隔——與平台端 chainValid 同一精神，改任何一筆後續全斷。
 */
function auditCanonical({ prevHash, ts, actor, action, payloadJson }) {
  return [prevHash || '', ts, actor === null || actor === undefined ? '' : actor, action, payloadJson].join('|');
}

/* ══ Phase 1：替班迴路 通報 → 核准 → 逐一問 → 回報（docs/LINEBOT-STAGE1.md §4）══════
 *
 * 純邏輯：每個 flow 回 { reply?: {text, items}, pushes: [{ staffId | admin:true, text, items }] }，
 * 宿主把 staffId 解析成 line_user_id 後推播。決定與訊息都在這裡，宿主不含業務判斷。
 *
 * store 介面（Phase 1 新增；cloudflare/linebot/store-d1.mjs 實作，測試用記憶體假物件）：
 *   store.findOpenSubRequest({ unit, date, shift, originalStaffId }) → row | null
 *   store.createSubRequest(row)                          store.getSubRequest(id) → row | null
 *   store.updateSubRequest(id, patch)                    store.listAsks(requestId) → rows（依 seq）
 *   store.insertAsk({ requestId, seq, staffId, askedAt, expiredAt })
 *   store.answerAsk({ requestId, staffId, answer, answeredAt }) → row | null
 *       （原子：只有該請求「仍在等」且 staff 相符的那筆會被寫入並回傳）
 *   store.cancelOpenAsk(requestId, nowIso) → row | null   （原子：把仍在等的那筆標 cancelled）
 *   store.expireDueAsks(nowIso) → rows                    （原子：仍在等且逾時的全部標 timeout 並回傳）
 *   store.listIdentities({ unit, minTierRank }) → rows    （unit 為 null 表示不限單位）
 *   store.applySubstitution({ date, shift, unit, originalStaffId, substituteStaffId, reasonType, now })
 *
 * 紀律（§4.2）：同一時間只有一位候選看得到請求；遲到的接不算數；拒絕與逾時不扣分，
 * standbyCount30d 只在 FILLED 時對替補者 +1（applySubstitution 內做）。
 */

const SUB_TOP_N = 5;

/** 請求代號：R＋時間 4 位（base36）＋亂數 2 位；rand 可注入 */
function genRequestId(nowIso, rand = Math.random) {
  const t = Math.floor(new Date(nowIso).getTime() / 1000) % (36 ** 4);
  const A = '0123456789ABCDEFGHJKMNPQRSTUVWXYZ';   // 去掉 I／L／O 避免誤讀
  let s = 'R' + t.toString(36).toUpperCase().padStart(4, '0');
  for (let i = 0; i < 2; i += 1) s += A[Math.floor(rand() * A.length)];
  return s;
}

/** 逾時分級（§4.4）：依缺班距今小時數。班次起點以台北時間解讀。 */
function timeoutMinutesFor(gap, nowIso) {
  const st = SHIFT_TYPES[gap.shift];
  const start = new Date(`${gap.date}T${(st && st.start) || '00:00'}:00+08:00`).getTime();
  const hours = (start - new Date(nowIso).getTime()) / 3_600_000;
  if (hours < 12) return 15;
  if (hours < 48) return 60;
  return 240;
}

function gapLabel(gap) {
  return `${shortDate(gap.date)}（${weekdayOf(gap.date)}）${SHIFT_TYPES[gap.shift].name}｜${UNITS[gap.unit] || gap.unit}` +
    (gap.requiredCerts && gap.requiredCerts.length ? `，需 ${gap.requiredCerts.join('、')}` : '');
}

function gapOf(req) {
  return { date: req.date, shift: req.shift, unit: req.unit, requiredRole: '護理師',
    requiredCerts: JSON.parse(req.required_certs_json || '[]'), originalStaffId: req.original_staff_id };
}

/** 核准用的候選摘要＋按鈕（REPORTED 狀態下重複使用：通報時、略過後） */
function approvalMessage(req) {
  const cands = JSON.parse(req.candidates_json || '[]');
  const gap = gapOf(req);
  const lines = [
    `【待核准｜${req.id}】${gapLabel(gap)}`,
    `通報人：${req.reporter_staff_id}${req.reason_type ? `（${req.reason_type}）` : ''}`,
    '',
  ];
  if (cands.length === 0) {
    lines.push('⚠ 引擎查無合格候選——核准後會直接標記無人可補，交人工處理。');
  } else {
    lines.push(`合格候選 ${cands.length} 位（引擎排序，逐一詢問，每位等 ${req.timeout_min} 分鐘）：`);
    cands.forEach((c, i) => lines.push(`${i + 1}. ${c.id}　${c.total}／${c.max} 分　${c.why}`));
  }
  lines.push('', '核准後機器人才會開口，序列即凍結；要略過、置頂、改逾時，先按「調整」（每一步留痕）。');
  const items = [
    { label: `✅ 核准（${cands.length} 位）`, dataStr: encodeParams({ rq: req.id, act: 'approve' }) },
    { label: '⛔ 駁回', dataStr: encodeParams({ rq: req.id, act: 'reject' }) },
    { label: '✎ 調整', dataStr: encodeParams({ rq: req.id, act: 'adjust' }) },
  ];
  return { text: lines.join('\n'), items };
}

/** 主管們（同單位 head 以上）；一個都沒有時退到管理者 */
async function headsOf(store, unit) {
  const heads = await store.listIdentities({ unit, minTierRank: TIERS.head });
  if (heads.length) return heads.map((h) => ({ staffId: h.staff_id }));
  return [{ admin: true }];
}

/* ── 1. 通報 ── */
async function reportFlow({ p, reporter, reasonType, now, store, db, rand }) {
  const gap = { ...buildGap(p), originalStaffId: reporter.staff_id };
  const dup = await store.findOpenSubRequest({ unit: gap.unit, date: gap.date, shift: gap.shift, originalStaffId: reporter.staff_id });
  if (dup) {
    return { reply: { text: `這筆缺班已有進行中的請求（${dup.id}，狀態：${dup.state}），不重複建立。`, items: null }, pushes: [] };
  }
  const { candidates } = platformEngine(db).evaluateGap(gap);
  const cands = candidates.slice(0, SUB_TOP_N).map((c) => ({
    id: c.staff.id, total: c.score.total, max: c.score.maxTotal,
    why: [...c.score.breakdown].sort((a, b) => b.points - a.points).slice(0, 2).map((b) => `${b.name} ${b.points}`).join('、'),
  }));
  const req = {
    id: genRequestId(now, rand), unit: gap.unit, date: gap.date, shift: gap.shift,
    required_certs_json: JSON.stringify(gap.requiredCerts), original_staff_id: reporter.staff_id,
    reason_type: reasonType || null, reporter_staff_id: reporter.staff_id, state: 'REPORTED',
    candidates_json: JSON.stringify(cands), timeout_min: timeoutMinutesFor(gap, now), created_at: now,
  };
  await store.createSubRequest(req);
  await store.appendAudit({ ts: now, actor: reporter.staff_id, action: 'sub.reported',
    payload: { id: req.id, unit: gap.unit, date: gap.date, shift: gap.shift, candidates: cands.map((c) => c.id), timeoutMin: req.timeout_min } });

  const heads = await headsOf(store, gap.unit);
  const msg = approvalMessage(req);
  const noHead = heads.length === 1 && heads[0].admin;
  return {
    reply: {
      text: [
        `已通報 ${req.id}：${gapLabel(gap)}。`,
        `引擎排出 ${cands.length} 位合格候選，已送護理長核准；核准後機器人會逐一詢問，有結果會通知你。`,
        noHead ? '（此單位尚無護理長綁定，已改通知管理者。）' : '',
      ].filter(Boolean).join('\n'),
      items: null,
    },
    pushes: heads.map((h) => ({ ...h, text: msg.text, items: msg.items })),
  };
}

/* ── 共用：把第 seq 位候選問出去，或宣告無人可補 ── */
async function advanceAsk(req, now, store) {
  const cands = JSON.parse(req.candidates_json || '[]');
  const asks = await store.listAsks(req.id);
  const seq = asks.length;
  const gap = gapOf(req);
  if (seq >= cands.length) {
    await store.updateSubRequest(req.id, { state: 'EXHAUSTED', closed_at: now });
    const tally = asks.reduce((t, a) => { t[a.answer] = (t[a.answer] || 0) + 1; return t; }, {});
    await store.appendAudit({ ts: now, actor: null, action: 'sub.exhausted', payload: { id: req.id, asked: asks.length, tally } });
    const summary = `${asks.length} 位皆未接（拒絕 ${tally.decline || 0}、逾時 ${tally.timeout || 0}）`;
    const heads = await headsOf(store, req.unit);
    return [
      ...heads.map((h) => ({ ...h, text: `【無人可補｜${req.id}】${gapLabel(gap)}\n${summary}。請至平台以放寬試算或任務重分配人工處理（決策階梯第 2–3 階）。`, items: null })),
      { staffId: req.reporter_staff_id, text: `你的通報 ${req.id} 已問完 ${asks.length} 位候選、皆未接，護理長將人工處理。`, items: null },
    ];
  }
  const c = cands[seq];
  const expiredAt = isoPlusMinutes(now, req.timeout_min);
  await store.insertAsk({ requestId: req.id, seq, staffId: c.id, askedAt: now, expiredAt });
  await store.updateSubRequest(req.id, { state: 'ASKING' });
  await store.appendAudit({ ts: now, actor: null, action: 'sub.asked', payload: { id: req.id, seq, staffId: c.id, expiredAt } });
  return [{
    staffId: c.id,
    text: [
      `【替班詢問｜${req.id}】${gapLabel(gap)}`,
      `你符合資格，引擎排序第 ${seq + 1} 位（${c.total}／${c.max} 分：${c.why}）。`,
      `接嗎？請在 ${req.timeout_min} 分鐘內回覆；逾時會自動問下一位，不影響你的任何評分。`,
    ].join('\n'),
    items: [
      { label: '✅ 接', dataStr: encodeParams({ rq: req.id, act: 'accept' }) },
      { label: '❌ 不接', dataStr: encodeParams({ rq: req.id, act: 'decline' }) },
    ],
  }];
}

/* ── 2. 核准／略過／駁回（護理長）── */
function actorMayManage(req, actor) {
  return TIERS[actor.tier] >= TIERS.exec || (TIERS[actor.tier] >= TIERS.head && actor.unit === req.unit);
}

async function approveFlow({ rq, actor, now, store }) {
  const req = await store.getSubRequest(rq);
  if (!req) return { reply: { text: `查無請求 ${rq}。`, items: null }, pushes: [] };
  if (!actorMayManage(req, actor)) return { reply: { text: `請求 ${rq} 屬 ${UNITS[req.unit] || req.unit}，需該單位護理長或督導核准。`, items: null }, pushes: [] };
  if (req.state !== 'REPORTED') return { reply: { text: `請求 ${rq} 目前狀態為 ${req.state}，不可再核准。`, items: null }, pushes: [] };
  const cands = JSON.parse(req.candidates_json || '[]');
  await store.updateSubRequest(req.id, { state: 'APPROVED', approved_at: now, approved_by: actor.staff_id });
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'sub.approved',
    payload: { id: req.id, sequence: cands.map((c) => c.id), selfApproved: actor.staff_id === req.original_staff_id, timeoutMin: req.timeout_min } });
  const fresh = await store.getSubRequest(req.id);
  const pushes = await advanceAsk(fresh, now, store);
  const first = cands[0];
  return {
    reply: {
      text: first
        ? `已核准 ${req.id}，開始逐一詢問：第 1 位 ${first.id}，等 ${req.timeout_min} 分鐘。每一步都會通知你。`
        : `已核准 ${req.id}，但無合格候選——已標記無人可補。`,
      items: null,
    },
    pushes,
  };
}

async function skipFlow({ rq, who, actor, now, store }) {
  const req = await store.getSubRequest(rq);
  if (!req) return { reply: { text: `查無請求 ${rq}。`, items: null }, pushes: [] };
  if (!actorMayManage(req, actor)) return { reply: { text: `請求 ${rq} 需該單位護理長或督導處理。`, items: null }, pushes: [] };
  if (req.state !== 'REPORTED') return { reply: { text: `請求 ${rq} 已核准，序列已凍結，不可再略過。`, items: null }, pushes: [] };
  const cands = JSON.parse(req.candidates_json || '[]');
  if (!cands.some((c) => c.id === who)) return { reply: { text: `${who} 不在 ${rq} 的候選序列中。`, items: null }, pushes: [] };
  const next = cands.filter((c) => c.id !== who);
  await store.updateSubRequest(req.id, { candidates_json: JSON.stringify(next) });
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'sub.skipped', payload: { id: req.id, who, remaining: next.map((c) => c.id) } });
  const msg = approvalMessage({ ...req, candidates_json: JSON.stringify(next) });
  return { reply: { text: `已略過 ${who}（留痕）。\n\n${msg.text}`, items: msg.items }, pushes: [] };
}

async function rejectFlow({ rq, actor, now, store }) {
  const req = await store.getSubRequest(rq);
  if (!req) return { reply: { text: `查無請求 ${rq}。`, items: null }, pushes: [] };
  if (!actorMayManage(req, actor)) return { reply: { text: `請求 ${rq} 需該單位護理長或督導處理。`, items: null }, pushes: [] };
  if (!['REPORTED', 'APPROVED', 'ASKING'].includes(req.state)) return { reply: { text: `請求 ${rq} 狀態為 ${req.state}，不可駁回。`, items: null }, pushes: [] };
  const open = await store.cancelOpenAsk(req.id, now);
  await store.updateSubRequest(req.id, { state: 'REJECTED', closed_at: now });
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'sub.rejected', payload: { id: req.id, cancelledAsk: open ? open.staff_id : null } });
  const pushes = [{ staffId: req.reporter_staff_id, text: `你的通報 ${req.id}（${gapLabel(gapOf(req))}）護理長已駁回，請直接與護理長聯繫。`, items: null }];
  if (open) pushes.push({ staffId: open.staff_id, text: `替班詢問 ${req.id} 已由護理長取消，不需回覆。`, items: null });
  return { reply: { text: `已駁回 ${req.id}。`, items: null }, pushes };
}

/* ── 3. 候選回覆：接／不接 ── */
async function answerFlow({ rq, answer, actor, now, store, db }) {
  const req = await store.getSubRequest(rq);
  if (!req) return { reply: { text: `查無請求 ${rq}。`, items: null }, pushes: [] };
  const ask = await store.answerAsk({ requestId: rq, staffId: actor.staff_id, answer, answeredAt: now });
  if (!ask) {
    // 沒搶到：不是問你的、已回覆過、已被 cron 標逾時、或請求已結束
    let why = '這不是目前問你的那一筆。';
    if (req.state === 'FILLED') why = `此筆已由 ${req.filled_by} 接下，謝謝你。`;
    else if (['REJECTED', 'CANCELLED', 'EXHAUSTED'].includes(req.state)) why = `此筆已結束（${req.state}），不需回覆。`;
    else {
      const asks = await store.listAsks(rq);
      const mine = asks.filter((a) => a.staff_id === actor.staff_id).at(-1);
      if (mine && mine.answer === 'timeout') why = '此筆已逾時、已改問下一位，謝謝你。（遲到的回覆不算數，也不影響評分）';
      else if (mine && mine.answer) why = `你已回覆過（${mine.answer}）。`;
    }
    await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'sub.answer_ignored', payload: { id: rq, answer, why } });
    return { reply: { text: why, items: null }, pushes: [] };
  }

  if (answer === 'decline') {
    await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'sub.declined', payload: { id: rq, seq: ask.seq } });
    const pushes = await advanceAsk(await store.getSubRequest(rq), now, store);
    return { reply: { text: `已記錄你不接 ${rq}。不影響評分，謝謝回覆。`, items: null }, pushes };
  }

  // accept：寫回前再驗一次硬性規則（§4.5：候選可能已接了別筆）
  const gap = gapOf(req);
  const { candidates } = platformEngine(db).evaluateGap(gap);
  if (!candidates.some((c) => c.staff.id === actor.staff_id)) {
    await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'sub.accept_conflict', payload: { id: rq, seq: ask.seq } });
    const pushes = await advanceAsk(await store.getSubRequest(rq), now, store);
    return { reply: { text: `抱歉，重新檢核時你已不符合 ${rq} 的硬性規則（可能是班距或工時已變），本筆改問下一位。`, items: null }, pushes };
  }
  await store.applySubstitution({ date: req.date, shift: req.shift, unit: req.unit,
    originalStaffId: req.original_staff_id, substituteStaffId: actor.staff_id, reasonType: req.reason_type, now });
  await store.updateSubRequest(rq, { state: 'FILLED', filled_by: actor.staff_id, closed_at: now });
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'sub.filled',
    payload: { id: rq, seq: ask.seq, by: actor.staff_id, original: req.original_staff_id } });

  const asks = await store.listAsks(rq);
  const skipped = asks.filter((a) => a.answer !== 'accept').map((a) => `${a.staff_id}（${a.answer === 'decline' ? '不接' : '逾時'}）`);
  const heads = await headsOf(store, req.unit);
  const label = gapLabel(gap);
  return {
    reply: { text: `已確認你接 ${rq}：${label}。班表已更新，護理長與原通報人已收到通知。`, items: null },
    pushes: [
      { staffId: req.reporter_staff_id, text: `你 ${label} 的缺班已由 ${actor.staff_id} 接下（${rq}），班表已更新。`, items: null },
      ...heads.map((h) => ({ ...h, text: `【已補上｜${rq}】${label}\n替補：${actor.staff_id}（序列第 ${ask.seq + 1} 位）${skipped.length ? `\n前面：${skipped.join('、')}` : ''}\n班表已寫回並留痕。`, items: null })),
    ],
  };
}

/* ── 4. cron：逾時掃描 ── */
async function expireFlow({ now, store }) {
  const due = await store.expireDueAsks(now);
  const pushes = [];
  for (const a of due) {
    await store.appendAudit({ ts: now, actor: null, action: 'sub.timeout', payload: { id: a.request_id, seq: a.seq, staffId: a.staff_id } });
    pushes.push({ staffId: a.staff_id, text: `替班詢問 ${a.request_id} 已逾時，改問下一位。不影響你的評分。`, items: null });
    const req = await store.getSubRequest(a.request_id);
    if (req && req.state === 'ASKING') pushes.push(...await advanceAsk(req, now, store));
  }
  return { expired: due.length, pushes };
}

/* ══ Phase 1.5：護理長的「調整」＋ 依身分的常駐指令（docs/LINEBOT-STAGE1.md §4.3、§2.4）══════
 *
 * 調整只在 REPORTED 可做（核准後序列凍結）：
 *   ・略過（skip，Phase 1 已有）／置頂（top）——按鈕；調序（reorder）——文字指令「調序 R… N-04 N-08」
 *   ・逾時三檔按鈕（15／60／240）；任意分鐘——文字指令「逾時 R… 30」（5–720）
 *   每一次調整都留痕 before／after，並回新的核准訊息。
 *
 * 常駐指令（圖文選單格子送出的文字）：
 *   ・待核准（head+）：列出本單位 REPORTED 請求，附第一筆的核准按鈕——推播被滑掉也找得回來
 *   ・我的邀請：把「正在等你回覆」的替班詢問重送一次（含接／不接）
 *   ・我是誰：回綁定身分與權責層
 *   ・通報缺班：引導＋三個可直接送出的範例句
 *   ・綁定說明：未綁定者的入口（任何人可用）
 *
 * store 新增：store.listSubRequests({ unit, state })、store.findOpenAskFor(staffId, nowIso)
 */

const TIMEOUT_PRESETS = [15, 60, 240];
const TIMEOUT_MIN = 5, TIMEOUT_MAX = 720;

const REORDER_RE = /^調序\s+(R[0-9A-Z]{6})((?:\s+n-?\d{1,2})+)$/i;
const TIMEOUT_RE = /^逾時\s+(R[0-9A-Z]{6})\s+(\d{1,3})$/i;
const PENDING_RE = /^(待核准|待核|核准清單)$/;
const MYASK_RE = /^(我的邀請|我的替班邀請|邀請)$/;
const WHOAMI_RE = /^(我是誰|我的身分|綁定狀態)$/;
const REPORT_GUIDE_RE = /^(通報缺班|通報|我要通報|請假通報)$/;
const BIND_GUIDE_RE = /^(綁定說明|如何綁定|怎麼綁定)$/;

/** 文字版管理指令：命中回 { kind, rq, ... }，未命中 null */
function phase15Command(text) {
  const t = normalizeCmdText(text);
  let m = REORDER_RE.exec(t);
  if (m) return { kind: 'reorder', rq: m[1].toUpperCase(), order: m[2].trim().split(/\s+/).map((w) => padStaffId(w.replace(/^n-?/i, ''))) };
  m = TIMEOUT_RE.exec(t);
  if (m) return { kind: 'timeout', rq: m[1].toUpperCase(), minutes: Number(m[2]) };
  return null;
}

/** 調整選單：略過×n、置頂×(n−1)、逾時三檔（≤ 12 顆，LINE 上限 13） */
function adjustMessage(req) {
  const cands = JSON.parse(req.candidates_json || '[]');
  const items = [
    ...cands.slice(0, 5).map((c) => ({ label: `略過 ${c.id}`, dataStr: encodeParams({ rq: req.id, act: 'skip', who: c.id }) })),
    ...cands.slice(1, 5).map((c) => ({ label: `置頂 ${c.id}`, dataStr: encodeParams({ rq: req.id, act: 'top', who: c.id }) })),
    ...TIMEOUT_PRESETS.map((m) => ({ label: `逾時 ${m} 分`, dataStr: encodeParams({ rq: req.id, act: 'timeout', who: String(m) }) })),
  ];
  return {
    text: [
      `【調整｜${req.id}】目前序列：${cands.map((c, i) => `${i + 1}.${c.id}`).join('　')}｜每位等 ${req.timeout_min} 分鐘`,
      '',
      '略過＝移出本次序列；置頂＝移到第 1 位；逾時＝改每位等候分鐘。每一步都留痕。',
      '也可以直接打：「調序 ' + req.id + ' N-04 N-08」（完整順序）、「逾時 ' + req.id + ' 30」（任意分鐘）。',
      '調整完回上一則按「核准」。',
    ].join('\n'),
    items,
  };
}

async function loadAdjustable(rq, actor, store) {
  const req = await store.getSubRequest(rq);
  if (!req) return { err: { text: `查無請求 ${rq}。`, items: null } };
  if (!actorMayManage(req, actor)) return { err: { text: `請求 ${rq} 需該單位護理長或督導處理。`, items: null } };
  if (req.state !== 'REPORTED') return { err: { text: `請求 ${rq} 已核准，序列已凍結，不可再調整。`, items: null } };
  return { req };
}

async function adjustFlow({ rq, actor, store }) {
  const { req, err } = await loadAdjustable(rq, actor, store);
  if (err) return { reply: err, pushes: [] };
  return { reply: adjustMessage(req), pushes: [] };
}

/** 置頂：把 who 移到第 1 位，其餘相對順序不變 */
async function topFlow({ rq, who, actor, now, store }) {
  const { req, err } = await loadAdjustable(rq, actor, store);
  if (err) return { reply: err, pushes: [] };
  const cands = JSON.parse(req.candidates_json || '[]');
  const idx = cands.findIndex((c) => c.id === who);
  if (idx < 0) return { reply: { text: `${who} 不在 ${rq} 的候選序列中。`, items: null }, pushes: [] };
  if (idx === 0) return { reply: { text: `${who} 已經是第 1 位。`, items: adjustMessage(req).items }, pushes: [] };
  const next = [cands[idx], ...cands.filter((_, i) => i !== idx)];
  await store.updateSubRequest(rq, { candidates_json: JSON.stringify(next) });
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'sub.reordered',
    payload: { id: rq, how: 'top', who, before: cands.map((c) => c.id), after: next.map((c) => c.id) } });
  const msg = approvalMessage({ ...req, candidates_json: JSON.stringify(next) });
  return { reply: { text: `已把 ${who} 置頂（留痕）。\n\n${msg.text}`, items: msg.items }, pushes: [] };
}

/** 調序：文字指令給完整或部分順序；有列的照順序排前面，沒列的照原相對順序接在後面 */
async function reorderFlow({ rq, order, actor, now, store }) {
  const { req, err } = await loadAdjustable(rq, actor, store);
  if (err) return { reply: err, pushes: [] };
  const cands = JSON.parse(req.candidates_json || '[]');
  const ids = cands.map((c) => c.id);
  const unknown = order.filter((id) => !ids.includes(id));
  if (unknown.length) return { reply: { text: `${unknown.join('、')} 不在 ${rq} 的候選序列中（序列：${ids.join('、')}）。`, items: null }, pushes: [] };
  const uniq = [...new Set(order)];
  const next = [...uniq.map((id) => cands.find((c) => c.id === id)), ...cands.filter((c) => !uniq.includes(c.id))];
  await store.updateSubRequest(rq, { candidates_json: JSON.stringify(next) });
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'sub.reordered',
    payload: { id: rq, how: 'reorder', before: ids, after: next.map((c) => c.id) } });
  const msg = approvalMessage({ ...req, candidates_json: JSON.stringify(next) });
  return { reply: { text: `已調序（留痕）：${next.map((c, i) => `${i + 1}.${c.id}`).join('　')}\n\n${msg.text}`, items: msg.items }, pushes: [] };
}

/** 改逾時：5–720 分鐘 */
async function timeoutFlow({ rq, minutes, actor, now, store }) {
  const { req, err } = await loadAdjustable(rq, actor, store);
  if (err) return { reply: err, pushes: [] };
  const m = Number(minutes);
  if (!Number.isInteger(m) || m < TIMEOUT_MIN || m > TIMEOUT_MAX) {
    return { reply: { text: `逾時需為 ${TIMEOUT_MIN}–${TIMEOUT_MAX} 的整數分鐘（收到：${minutes}）。`, items: null }, pushes: [] };
  }
  await store.updateSubRequest(rq, { timeout_min: m });
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'sub.timeout_changed', payload: { id: rq, before: req.timeout_min, after: m } });
  const msg = approvalMessage({ ...req, timeout_min: m });
  return { reply: { text: `逾時已改為每位等 ${m} 分鐘（原 ${req.timeout_min}，留痕）。\n\n${msg.text}`, items: msg.items }, pushes: [] };
}

/* ── 常駐指令 ── */

/** 待核准：本單位（exec 為全院）的 REPORTED 請求；第一筆附核准按鈕 */
async function pendingFlow({ actor, store }) {
  const unit = TIERS[actor.tier] >= TIERS.exec ? null : actor.unit;
  const rows = await store.listSubRequests({ unit, state: 'REPORTED' });
  if (!rows.length) return { reply: { text: `目前沒有待核准的替班請求${unit ? `（${UNITS[unit] || unit}）` : ''}。`, items: null }, pushes: [] };
  const first = approvalMessage(rows[0]);
  const more = rows.length > 1
    ? `\n\n另有 ${rows.length - 1} 筆待核准：${rows.slice(1).map((r) => `${r.id}（${gapLabel(gapOf(r))}）`).join('；')}。處理完第一筆再輸入「待核准」。`
    : '';
  return { reply: { text: `待核准 ${rows.length} 筆。\n\n${first.text}${more}`, items: first.items }, pushes: [] };
}

/** 我的邀請：重送「正在等你回覆」的那一筆 */
async function myAskFlow({ actor, now, store }) {
  const a = await store.findOpenAskFor(actor.staff_id, now);
  if (!a) return { reply: { text: '目前沒有等你回覆的替班詢問。', items: null }, pushes: [] };
  const req = await store.getSubRequest(a.request_id);
  const cands = JSON.parse(req.candidates_json || '[]');
  const c = cands[a.seq] || { total: '?', max: '?', why: '' };
  const left = Math.max(0, Math.round((new Date(a.expired_at) - new Date(now)) / 60_000));
  return {
    reply: {
      text: [
        `【替班詢問｜${req.id}】${gapLabel(gapOf(req))}`,
        `你符合資格，引擎排序第 ${a.seq + 1} 位（${c.total}／${c.max} 分：${c.why}）。`,
        `還有約 ${left} 分鐘可回覆；逾時會自動問下一位，不影響你的任何評分。`,
      ].join('\n'),
      items: [
        { label: '✅ 接', dataStr: encodeParams({ rq: req.id, act: 'accept' }) },
        { label: '❌ 不接', dataStr: encodeParams({ rq: req.id, act: 'decline' }) },
      ],
    },
    pushes: [],
  };
}

/** 我是誰 */
function whoamiText(identity, isAdminUser) {
  if (!identity) return isAdminUser ? '你是管理者（未綁定人員代號）。輸入「發碼 N-xx」可為同仁發綁定碼。' : BIND_HELP;
  return [
    `你是 ${identity.staff_id}（${UNITS[identity.unit] || identity.unit}｜${identity.role}｜權責層：${TIER_LABEL[identity.tier] || identity.tier}）`,
    isAdminUser ? '同時是管理者。' : '',
    `綁定於 ${String(identity.bound_at || '').replace('T', ' ').slice(0, 16)}`,
  ].filter(Boolean).join('\n');
}

/** 通報引導：三個可直接送出的範例（message 型快速按鈕） */
function reportGuideMessage() {
  return {
    text: [
      '要通報缺班，直接用一句話告訴我：日期、班別，以及原因（可省略）。',
      '例如「我明天白班不能來」「我 9/25 大夜發燒沒辦法上」。',
      '單位會從你的身分帶入；沒寫到的條件我會用按鈕問你——不臆測。',
      '條件齊全後會建立替班請求、送護理長核准，有結果會通知你。',
    ].join('\n'),
    items: [
      { label: '我明天白班不能來', text: '我明天白班不能來' },
      { label: '我明天小夜不能來', text: '我明天小夜不能來' },
      { label: '我後天大夜不能來', text: '我後天大夜不能來' },
    ],
  };
}

/* ══ Phase 2：預班迴路 開啟 → 預假 → 催繳 → 截止 → 生成 → 審核 → 公告（docs/LINEBOT-STAGE1.md §3）══════
 *
 * 純邏輯，同 Phase 1 的介面：每個 flow 回 { reply?, pushes }。
 * store 新增（cloudflare/linebot/store-d1.mjs 實作；測試用記憶體假物件）：
 *   store.listStaffByUnit(unit) → [{ id, unit, role }]               （人員快照，不是 identity——沒綁定的人也要有一列）
 *   store.createCycle(row)  store.getCycle(id) → row|null  store.updateCycle(id, patch)
 *   store.findCycle({ unit, states }) → row|null            store.listCycles({ states }) → rows
 *   store.upsertPrebookRequests(cycleId, staffIds, nowIso)  （PENDING，已存在者不動）
 *   store.getPrebookRequest(cycleId, staffId) → row|null    store.updatePrebookRequest(cycleId, staffId, patch)
 *   store.listPrebookRequests(cycleId, state?) → rows
 *   store.insertLeaves(rows)   store.insertShifts(rows)     （批次，INSERT OR REPLACE）
 *   store.loadDb() → { staff, shifts }                      （截止後要重新載入，預假才會進 leaves）
 *
 * 誠實原則：預假是請求不是保證；生成器排不出的格子連同阻擋規則一起交護理長，不硬塞。
 */

const PREBOOK_DEFAULT_MAX = 4;
const PREBOOK_MAX_LIMIT = 10;
const PREBOOK_DEFAULT_DEADLINE_DAY = 25;       // 前月 25 日 23:59（台北）
const PREBOOK_REMIND_DAYS = [3, 1];            // 截止前 3 天、前 1 天（cron）

const OPEN_CYCLE_RE = /^(?:開啟預班|預班開放|開放預班)\s*(\S+)?(?:\s+截止\s*(\S+))?(?:\s+上限\s*(\d{1,2}))?$/;
const PREBOOK_RE = /^(?:預假|預班|我要預假)(?:[:：]|\s)?\s*(.*)$/;
const MYPREBOOK_RE = /^(我的預假|我的預班|預假查詢)$/;
const CYCLE_STATUS_RE = /^(預班狀態|預班進度|誰還沒填)$/;
const REMIND_NOW_RE = /^(催繳|催預班|催繳預班)$/;
const CLOSE_CYCLE_RE = /^(關閉預班|截止預班|預班截止)$/;

/** 「10月」「10」「2026-10」「2026/10」→ YYYY-MM；只給月份時取「今年」，若已過則明年 */
function parseMonthWord(w, nowIso) {
  const t = normalizeCmdText(w || '').replace(/月$/, '');
  let m = /^(\d{4})[-\/](\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;
  m = /^(\d{1,2})$/.exec(t);
  if (!m) return null;
  const mon = Number(m[1]);
  if (mon < 1 || mon > 12) return null;
  const now = new Date(new Date(nowIso).getTime() + 8 * 3600_000);   // 台北
  let year = now.getUTCFullYear();
  if (mon < now.getUTCMonth() + 1) year += 1;
  return `${year}-${String(mon).padStart(2, '0')}`;
}

function monthDays(month) {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

/** 預設截止：前月 25 日 23:59 台北 → ISO */
function defaultDeadline(month) {
  const [y, m] = month.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, PREBOOK_DEFAULT_DEADLINE_DAY, 15, 59, 0));   // 23:59+08 = 15:59Z
  return prev.toISOString();
}

/** 「10/3」「10月3日」「2026-10-03」→ YYYY-MM-DD，年份由呼叫端給（預班週期跨年時不能靠「今年」猜） */
function expandDateIn(word, year) {
  const t = String(word || '').replace(/(\d{1,2})月(\d{1,2})日?/, '$1/$2');
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isValidDateStr(t) ? t : null;
  const m = /^(\d{1,2})[\/-](\d{1,2})$/.exec(t);
  if (!m) return null;
  const full = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return isValidDateStr(full) ? full : null;
}

/** 「9/25」「2026-09-25」→ 該日 23:59 台北 ISO；認不得 null。只給月日時，落在週期月之前的那一年 */
function parseDeadlineWord(w, month) {
  if (!w) return null;
  const year = Number(month.slice(0, 4));
  let d = expandDateIn(normalizeCmdText(w), year);
  if (d && d.slice(0, 7) >= month && !/^\d{4}-/.test(w)) d = expandDateIn(normalizeCmdText(w), year - 1);
  return d ? new Date(`${d}T23:59:00+08:00`).toISOString() : null;
}

/** 把「10/3 10/4 10/17」「10月3日」等解析成 ISO 日期陣列；無法解析的字詞回在 bad */
function parseDateList(text, year) {
  const words = normalizeCmdText(text).split(/[\s,，、;；]+/).filter(Boolean);
  const dates = [], bad = [];
  for (const w of words) {
    const d = expandDateIn(w, year);
    if (d) dates.push(d); else bad.push(w);
  }
  return { dates: [...new Set(dates)].sort(), bad };
}

function cycleIdOf(unit, month) { return `${unit}:${month}`; }
function monthLabel(month) { return `${Number(month.split('-')[1])} 月`; }
function tpe(iso) { return new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ').replace('-', '/'); }

function announceMessage(cycle) {
  return {
    text: [
      `【${monthLabel(cycle.month)}預班開放｜${UNITS[cycle.unit] || cycle.unit}】`,
      `請在 ${tpe(cycle.deadline)} 前回覆想休的日期，每人最多 ${cycle.max_days} 天，截止前可改（最後一次為準）：`,
      `　預假 ${cycle.month.split('-')[1]}/3 ${cycle.month.split('-')[1]}/4`,
      '不需要預假請回「預假 無」。逾期未回視同無預假，會留痕。',
      '預假是請求不是保證：人力不足時排不開的格子會交護理長決定。',
    ].join('\n'),
    items: [
      { label: '📅 用日曆挑', page: 'prebook.html' },
      { label: '預假 無', text: '預假 無' },
      { label: '我的預假', text: '我的預假' },
    ],
  };
}

/* ── 1. 護理長開啟週期 ── */
async function openCycleFlow({ text, actor, now, store, db }) {
  const m = OPEN_CYCLE_RE.exec(normalizeCmdText(text));
  if (!m) return { reply: { text: '格式：開啟預班 10月（可加：截止 9/25、上限 3）', items: null }, pushes: [] };
  const month = parseMonthWord(m[1], now);
  if (!month) return { reply: { text: `月份「${m[1] || ''}」不認得。例：開啟預班 10月、開啟預班 2026-11`, items: null }, pushes: [] };
  const deadline = m[2] ? parseDeadlineWord(m[2], month) : defaultDeadline(month);
  if (!deadline) return { reply: { text: `截止日「${m[2]}」不認得。例：截止 9/25`, items: null }, pushes: [] };
  if (deadline <= now) return { reply: { text: `截止時間 ${tpe(deadline)} 已過，請指定未來的日期（截止 9/25）。`, items: null }, pushes: [] };
  const maxDays = m[3] ? Number(m[3]) : PREBOOK_DEFAULT_MAX;
  if (maxDays < 0 || maxDays > PREBOOK_MAX_LIMIT) return { reply: { text: `上限需為 0–${PREBOOK_MAX_LIMIT} 天。`, items: null }, pushes: [] };
  const unit = actor.unit;
  const id = cycleIdOf(unit, month);
  const existing = await store.getCycle(id);
  if (existing) {
    return { reply: { text: `${UNITS[unit] || unit} 的 ${monthLabel(month)}預班已存在（狀態 ${existing.state}）。輸入「預班狀態」查看；同一單位同一月份只開一次。`, items: null }, pushes: [] };
  }
  const staff = liveData(db).staff.filter((s) => s.unit === unit);
  if (!staff.length) return { reply: { text: `${UNITS[unit] || unit} 目前沒有人員快照，無法開啟預班。`, items: null }, pushes: [] };
  const cycle = { id, unit, month, deadline, max_days: maxDays, state: 'OPEN', opened_by: actor.staff_id, opened_at: now };
  await store.createCycle(cycle);
  await store.upsertPrebookRequests(id, staff.map((s) => s.id), now);
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'prebook.opened',
    payload: { id, month, deadline, maxDays, staffCount: staff.length } });
  const msg = announceMessage(cycle);
  return {
    reply: {
      text: `已開啟 ${UNITS[unit] || unit} ${monthLabel(month)}預班：${staff.length} 人、截止 ${tpe(deadline)}、每人上限 ${maxDays} 天。已推播全單位；截止前 3 天與前 1 天會自動催繳未回覆者。輸入「預班狀態」隨時看進度。`,
      items: null,
    },
    pushes: staff.map((s) => ({ staffId: s.id, text: msg.text, items: msg.items })),
  };
}

/* ── 2. 同仁送出預假 ── */
async function prebookFlow({ text, actor, now, store }) {
  const m = PREBOOK_RE.exec(normalizeCmdText(text));
  const body = (m && m[1] ? m[1] : '').trim();
  const cycle = await store.findCycle({ unit: actor.unit, states: ['OPEN'] });
  if (!cycle) return { reply: { text: `${UNITS[actor.unit] || actor.unit} 目前沒有開放中的預班週期。`, items: null }, pushes: [] };
  if (cycle.deadline <= now) return { reply: { text: `${monthLabel(cycle.month)}預班已於 ${tpe(cycle.deadline)} 截止，無法再送。`, items: null }, pushes: [] };
  let dates = [];
  if (!/^(無|沒有|不用|不需要|none)$/i.test(body)) {
    const parsed = parseDateList(body, Number(cycle.month.slice(0, 4)));
    if (!body || (parsed.dates.length === 0 && parsed.bad.length === 0)) {
      return { reply: { text: `請列出想休的日期，例：預假 ${cycle.month.split('-')[1]}/3 ${cycle.month.split('-')[1]}/4；不需要請回「預假 無」。`, items: null }, pushes: [] };
    }
    if (parsed.bad.length) return { reply: { text: `這些日期不認得：${parsed.bad.join('、')}。請用 10/3 或 2026-10-03 的寫法。`, items: null }, pushes: [] };
    const outOfMonth = parsed.dates.filter((d) => !d.startsWith(cycle.month));
    if (outOfMonth.length) return { reply: { text: `${outOfMonth.join('、')} 不在 ${monthLabel(cycle.month)}。這個週期只收 ${cycle.month} 的日期。`, items: null }, pushes: [] };
    if (parsed.dates.length > cycle.max_days) return { reply: { text: `最多 ${cycle.max_days} 天，你給了 ${parsed.dates.length} 天。請刪減後再送。`, items: null }, pushes: [] };
    dates = parsed.dates;
  }
  const prev = await store.getPrebookRequest(cycle.id, actor.staff_id);
  if (!prev) await store.upsertPrebookRequests(cycle.id, [actor.staff_id], now);
  await store.updatePrebookRequest(cycle.id, actor.staff_id, { dates_json: JSON.stringify(dates), state: 'SUBMITTED', submitted_at: now });
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'prebook.submitted',
    payload: { cycle: cycle.id, dates, replaced: !!(prev && prev.state === 'SUBMITTED') } });
  return {
    reply: {
      text: dates.length
        ? `已收到你 ${monthLabel(cycle.month)}的預假：${dates.map((d) => d.slice(5).replace('-', '/')).join('、')}（${dates.length}／${cycle.max_days} 天）。截止 ${tpe(cycle.deadline)} 前可重送覆蓋。`
        : `已記錄：你 ${monthLabel(cycle.month)}不需要預假。截止前可再送「預假 日期」覆蓋。`,
      items: null,
    },
    pushes: [],
  };
}

async function myPrebookFlow({ actor, store }) {
  const cycle = await store.findCycle({ unit: actor.unit, states: ['OPEN', 'CLOSED', 'GENERATED', 'REVIEW'] });
  if (!cycle) return { reply: { text: '目前沒有進行中的預班週期。', items: null }, pushes: [] };
  const r = await store.getPrebookRequest(cycle.id, actor.staff_id);
  const dates = r ? JSON.parse(r.dates_json || '[]') : [];
  const st = !r || r.state === 'PENDING' ? '尚未回覆' : r.state === 'NO_REQUEST' ? '逾期未回，視同無預假' : (dates.length ? dates.map((d) => d.slice(5).replace('-', '/')).join('、') : '無預假');
  return { reply: { text: `${monthLabel(cycle.month)}預班（${cycle.state}，截止 ${tpe(cycle.deadline)}）：${st}`,
    items: cycle.state === 'OPEN' ? [{ label: '📅 用日曆改', page: 'prebook.html' }] : null }, pushes: [] };
}

/* ── 3. 護理長看進度／手動催繳／手動截止 ── */
async function cycleStatusFlow({ actor, store }) {
  const cycle = await store.findCycle({ unit: actor.unit, states: ['OPEN', 'CLOSED', 'GENERATED', 'REVIEW', 'PUBLISHED'] });
  if (!cycle) return { reply: { text: `${UNITS[actor.unit] || actor.unit} 沒有預班週期。輸入「開啟預班 10月」開始。`, items: null }, pushes: [] };
  const rows = await store.listPrebookRequests(cycle.id);
  const by = (s) => rows.filter((r) => r.state === s);
  const lines = [
    `【${monthLabel(cycle.month)}預班｜${UNITS[cycle.unit] || cycle.unit}】狀態 ${cycle.state}，截止 ${tpe(cycle.deadline)}，上限 ${cycle.max_days} 天`,
    `已回覆 ${by('SUBMITTED').length}／未回覆 ${by('PENDING').length}／逾期視同無預假 ${by('NO_REQUEST').length}`,
  ];
  if (by('PENDING').length) lines.push(`未回覆：${by('PENDING').map((r) => r.staff_id).join('、')}`);
  if (cycle.state === 'REVIEW') lines.push(`草稿：${JSON.parse(cycle.draft_json || '[]').length} 格已排、${JSON.parse(cycle.uncovered_json || '[]').length} 格排不出——見上一則核准訊息或輸入「待核准」`);
  const items = [];
  if (cycle.state === 'OPEN') {
    items.push({ label: '催繳未回覆者', text: '催繳' });
    items.push({ label: '立即截止並生成', text: '關閉預班' });
  }
  return { reply: { text: lines.join('\n'), items: items.length ? items : null }, pushes: [] };
}

function reminderMessage(cycle) {
  return {
    text: `【催繳｜${monthLabel(cycle.month)}預班】你還沒回覆想休的日期，截止 ${tpe(cycle.deadline)}。逾期視同無預假。回「預假 10/3 10/4」或「預假 無」。`,
    items: [{ label: '📅 用日曆挑', page: 'prebook.html' }, { label: '預假 無', text: '預假 無' }, { label: '我的預假', text: '我的預假' }],
  };
}

async function remindPending(cycle, now, store, actor) {
  const pending = await store.listPrebookRequests(cycle.id, 'PENDING');
  const msg = reminderMessage(cycle);
  for (const r of pending) {
    await store.updatePrebookRequest(cycle.id, r.staff_id, { reminded_count: (r.reminded_count || 0) + 1, last_reminded_at: now });
  }
  if (pending.length) {
    await store.appendAudit({ ts: now, actor: actor || null, action: 'prebook.reminded',
      payload: { cycle: cycle.id, count: pending.length, staff: pending.map((r) => r.staff_id), manual: !!actor } });
  }
  return pending.map((r) => ({ staffId: r.staff_id, text: msg.text, items: msg.items }));
}

async function remindNowFlow({ actor, now, store }) {
  const cycle = await store.findCycle({ unit: actor.unit, states: ['OPEN'] });
  if (!cycle) return { reply: { text: '沒有開放中的預班週期。', items: null }, pushes: [] };
  const pushes = await remindPending(cycle, now, store, actor.staff_id);
  return { reply: { text: pushes.length ? `已催繳 ${pushes.length} 位未回覆者（留痕）。` : '全員都已回覆，不需催繳。', items: null }, pushes };
}

/* ── 4. 截止 → 預假入 leaves → 生成 → REVIEW（cron 到時自動；護理長可「關閉預班」提前）── */
/* ── Phase 3d：平台編輯寫回 D1（純函式；D1 與簽章在宿主）──
 * 平台把「目前這份班表」整份送回，宿主算差異、驗版本（樂觀鎖）、批次寫入、留痕差異。
 * 這裡只做兩件純的事：逐筆白名單驗證（代號∈人員、日期真實、班別∈D/E/N、單位∈UNITS、單位在範圍內），
 * 與「現況 vs 送來的」差異（key＝代號|日期|班別；單位或來源不同視為刪＋加）。 */
const SHIFT_SOURCES = ['imported', 'generated', 'substitution', 'swap', 'manual'];
function shiftKey(s) { return `${s.staffId}|${s.date}|${s.shift}`; }
function shiftSourceOf(s) {
  if (s.source && SHIFT_SOURCES.includes(s.source)) return s.source;
  return s.isReplacement ? 'substitution' : s.isSwap ? 'swap' : 'manual';
}
function validateShiftRows(rows, { staffIds, scopeUnit }) {
  const errors = [];
  if (!Array.isArray(rows)) return { ok: false, errors: ['shifts 需為陣列'] };
  rows.forEach((s, i) => {
    if (!s || typeof s !== 'object') { errors.push(`#${i}：不是物件`); return; }
    if (!staffIds.has(s.staffId)) errors.push(`#${i}：代號 ${s.staffId} 不在人員名單`);
    if (!isValidDateStr(String(s.date || ''))) errors.push(`#${i}：日期 ${s.date} 不存在`);
    if (!SHIFT_TYPES[s.shift]) errors.push(`#${i}：班別 ${s.shift} 不認得`);
    if (!UNITS[s.unit]) errors.push(`#${i}：單位 ${s.unit} 不認得`);
    else if (scopeUnit && s.unit !== scopeUnit) errors.push(`#${i}：單位 ${s.unit} 超出你的範圍（${scopeUnit}）`);
  });
  const seen = new Set();
  rows.forEach((s, i) => { const k = shiftKey(s || {}); if (seen.has(k)) errors.push(`#${i}：${k} 重複`); seen.add(k); });
  return { ok: errors.length === 0, errors: errors.slice(0, 20) };
}
/** current／next 皆為 { staffId, date, shift, unit, source? }；回 { deletes, inserts }（inserts 已帶 source） */
function diffShifts(current, next) {
  const cur = new Map(current.map((s) => [shiftKey(s), s]));
  const nxt = new Map(next.map((s) => [shiftKey(s), { staffId: s.staffId, date: s.date, shift: s.shift, unit: s.unit, source: shiftSourceOf(s) }]));
  const deletes = []; const inserts = [];
  for (const [k, s] of cur) { const n = nxt.get(k); if (!n) deletes.push({ staffId: s.staffId, date: s.date, shift: s.shift }); }
  for (const [k, n] of nxt) { const c = cur.get(k); if (!c || c.unit !== n.unit || (c.source || 'manual') !== n.source) inserts.push(n); }
  return { deletes, inserts };
}
/** 平台快照的班次形狀：D1 的 source → 平台的 isReplacement／isSwap 旗標（徽章才會延續） */
function shiftRowForPlatform(r) {
  const o = { staffId: r.staffId, date: r.date, shift: r.shift, unit: r.unit, source: r.source || 'imported' };
  if (r.source === 'substitution') o.isReplacement = true;
  if (r.source === 'swap') o.isSwap = true;
  return o;
}

/* ── Phase 3b：平台以 LINE 身分登入（docs/LINEBOT-STAGE1.md §0 第 11 個決定）──
 * 平台是靜態頁（GitHub Pages），CSP 不載 LIFF SDK；改由機器人回一條「帶簽章短效連結」：
 * 宿主用自己的 secret 簽 { staff_id, exp }，平台開頁時拿它向 Worker 換 session，再讀 D1 快照。
 * 這裡只組訊息；items 裡的 { label, page } 由宿主換成本人專屬的簽章網址（每個人不同、10 分鐘內有效）。 */
const PLATFORM_LOGIN_RE = /^(平台|登入平台|平台登入|開啟平台|登入)$/;
function platformLoginMessage(identity) {
  return {
    text: [
      `【平台登入】${identity.staff_id}｜${UNITS[identity.unit] || identity.unit}｜${TIER_LABEL[identity.tier] || identity.tier}視角`,
      '按下面的按鈕開啟平台：這條連結只給你、10 分鐘內有效，開啟後平台改讀雲端即時班表（D1），',
      '視角鎖定為你的權責層。逾時就再輸入「平台」拿新連結。',
    ].join('\n'),
    items: [
      { label: '🌐 開啟平台（已登入）', page: 'index.html' },
      { label: '📅 預假日曆', page: 'prebook.html' },
    ],
  };
}

/* ── Phase 3a：生成需求可設定（每單位每班人數，存 D1 setting `req.<unit>`；沒設＝平台的最低人力 UNIT_MIN_STAFF）── */
const REQ_RE = /^(?:設定需求|需求設定|生成需求|目前需求|需求)(?:\s+(.+))?$/;
const REQ_MAX = 9;
const SHIFT_WORD = { D: 'D', E: 'E', N: 'N', 白: 'D', 白班: 'D', 小夜: 'E', 小夜班: 'E', 大夜: 'N', 大夜班: 'N', 日: 'D', 晚: 'E', 夜: 'N' };

/** 「D2 E1 N1」「白班2 小夜1 大夜1」「2 1 1」→ {D,E,N}；認不得回 null */
function parseRequirementWords(body) {
  const words = normalizeCmdText(body || '').split(/[\s,，、／/]+/).filter(Boolean);
  if (!words.length) return null;
  const out = {};
  if (words.length === 3 && words.every((w) => /^\d$/.test(w))) {
    [out.D, out.E, out.N] = words.map(Number);
  } else {
    for (const w of words) {
      const m = /^([A-Za-z\u4e00-\u9fff]+?)\s*[:：=]?\s*(\d)$/.exec(w);
      const k = m && SHIFT_WORD[m[1].toUpperCase()] || (m && SHIFT_WORD[m[1]]);
      if (!k) return null;
      out[k] = Number(m[2]);
    }
  }
  if (!['D', 'E', 'N'].every((k) => Number.isInteger(out[k]) && out[k] >= 0 && out[k] <= REQ_MAX)) return null;
  return { D: out.D, E: out.E, N: out.N };
}

function defaultRequirementCounts(unit) {
  const min = UNIT_MIN_STAFF[unit] || { D: 1, E: 1, N: 1 };
  return { D: min.D, E: min.E, N: min.N };
}

/** 單位的生成需求：D1 setting 優先，沒設＝平台的最低人力（UNIT_MIN_STAFF）。回 { counts, source } */
async function unitRequirements(store, unit) {
  if (store && typeof store.getSetting === 'function') {
    try {
      const raw = await store.getSetting(`req.${unit}`);
      if (raw) {
        const c = JSON.parse(raw);
        if (['D', 'E', 'N'].every((k) => Number.isInteger(c[k]))) return { counts: { D: c.D, E: c.E, N: c.N }, source: 'setting' };
      }
    } catch { /* 壞掉的設定值視同沒設 */ }
  }
  return { counts: defaultRequirementCounts(unit), source: 'default' };
}

function requirementLabel(counts) {
  return ['D', 'E', 'N'].map((k) => `${SHIFT_TYPES[k] ? SHIFT_TYPES[k].name : k}${counts[k]}`).join('／');
}

/** 生成需求＝每班人數（可設定）＋院內政策 ACLS；與調度棋盤同一把尺 */
function requirementsFor(unit, counts) {
  const c = counts || defaultRequirementCounts(unit);
  return ['D', 'E', 'N'].map((shift) => ({ shift, count: c[shift], requiredRole: '護理師', requiredCerts: ['ACLS'] }));
}

/** 護理長「需求」看目前值、「設定需求 D2 E1 N1」改；改了留痕 before／after */
async function requirementFlow({ text, actor, now, store }) {
  const m = REQ_RE.exec(normalizeCmdText(text));
  const body = m && m[1] ? m[1].trim() : '';
  const unit = actor.unit;
  const cur = await unitRequirements(store, unit);
  const hint = '格式：設定需求 D2 E1 N1（也可寫 白班2 小夜1 大夜1），每班 0–9 人；生成草稿時另加院內政策 ACLS。';
  if (!body) {
    return { reply: { text: `${UNITS[unit] || unit} 目前的生成需求：${requirementLabel(cur.counts)}${cur.source === 'default' ? '（平台預設，尚未設定）' : ''}。\n${hint}`, items: null }, pushes: [] };
  }
  const counts = parseRequirementWords(body);
  if (!counts) return { reply: { text: `看不懂「${body}」。${hint}`, items: null }, pushes: [] };
  if (!store || typeof store.setSetting !== 'function') return { reply: { text: STORE_DISABLED_TEXT, items: null }, pushes: [] };
  await store.setSetting(`req.${unit}`, JSON.stringify(counts), now);
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'req.changed', payload: { unit, before: cur.counts, after: counts } });
  return { reply: { text: `已設定 ${UNITS[unit] || unit} 的生成需求：${requirementLabel(counts)}（原 ${requirementLabel(cur.counts)}）。下次截止生成草稿即以此為準；已生成的草稿不變。`, items: null }, pushes: [] };
}

async function closeAndGenerate(cycle, now, store, actor) {
  const rows = await store.listPrebookRequests(cycle.id);
  const pending = rows.filter((r) => r.state === 'PENDING');
  for (const r of pending) await store.updatePrebookRequest(cycle.id, r.staff_id, { state: 'NO_REQUEST' });
  const leaves = [];
  for (const r of rows.filter((x) => x.state === 'SUBMITTED')) {
    for (const d of JSON.parse(r.dates_json || '[]')) leaves.push({ staffId: r.staff_id, from: d, to: d, type: '預假', source: 'prebook', createdAt: now });
  }
  if (leaves.length) await store.insertLeaves(leaves);
  await store.updateCycle(cycle.id, { state: 'CLOSED', closed_at: now });
  await store.appendAudit({ ts: now, actor: actor || null, action: 'prebook.closed',
    payload: { cycle: cycle.id, noRequest: pending.map((r) => r.staff_id), leaves: leaves.length, manual: !!actor } });

  const db = await store.loadDb();                       // 預假已入 leaves，重新載入
  const dates = monthDays(cycle.month);
  const req = await unitRequirements(store, cycle.unit);
  const gen = platformEngine(db).generateSchedule({ unit: cycle.unit, dates, requirements: requirementsFor(cycle.unit, req.counts) });
  gen.requirementCounts = req.counts;
  await store.updateCycle(cycle.id, {
    state: 'REVIEW', generated_at: now,
    draft_json: JSON.stringify(gen.assignments), uncovered_json: JSON.stringify(gen.uncovered),
  });
  await store.appendAudit({ ts: now, actor: null, action: 'prebook.generated',
    payload: { cycle: cycle.id, filled: gen.filled, slots: gen.slotCount, uncovered: gen.uncovered.length, requirements: req.counts, requirementSource: req.source } });
  const fresh = await store.getCycle(cycle.id);
  const heads = await headsOf(store, cycle.unit);
  const msg = reviewMessage(fresh, gen);
  return heads.map((h) => ({ ...h, text: msg.text, items: msg.items }));
}

function reviewMessage(cycle, gen) {
  const unc = gen ? gen.uncovered : JSON.parse(cycle.uncovered_json || '[]');
  const filled = gen ? gen.filled : JSON.parse(cycle.draft_json || '[]').length;
  const slots = gen ? gen.slotCount : filled + unc.length;
  const lines = [
    `【${monthLabel(cycle.month)}班表草稿｜${UNITS[cycle.unit] || cycle.unit}】已排 ${filled}／${slots} 格`,
    ...(gen && gen.requirementCounts ? [`需求：每日 ${requirementLabel(gen.requirementCounts)}＋ACLS（「設定需求」可改）`] : []),
    unc.length ? `排不出 ${unc.length} 格（不硬塞、不放寬）：` : '全部格子都排得出。',
    ...unc.slice(0, 8).map((u) => `　・${u.date.slice(5).replace('-', '/')} ${SHIFT_TYPES[u.shift] ? SHIFT_TYPES[u.shift].name : u.shift}——${(u.blockers || []).map((b) => `${b.code}×${b.count}`).join('、')}`),
    ...(unc.length > 8 ? [`　…另 ${unc.length - 8} 格`] : []),
    '',
    '核准即寫入正式班表並公告全單位；要調整請先到平台改，改完再核准。',
  ];
  return {
    text: lines.join('\n'),
    items: [
      { label: '✅ 核准並公告', dataStr: encodeParams({ cy: cycle.id, act: 'publish' }) },
      { label: '⏸ 暫緩（保留草稿）', dataStr: encodeParams({ cy: cycle.id, act: 'hold' }) },
    ],
  };
}

async function closeCycleFlow({ actor, now, store }) {
  const cycle = await store.findCycle({ unit: actor.unit, states: ['OPEN'] });
  if (!cycle) return { reply: { text: '沒有開放中的預班週期。', items: null }, pushes: [] };
  const pushes = await closeAndGenerate(cycle, now, store, actor.staff_id);
  return { reply: { text: `已截止 ${monthLabel(cycle.month)}預班並生成草稿，核准訊息已送出。`, items: null }, pushes };
}

/* ── 5. 審核：公告／暫緩 ── */
async function publishFlow({ cy, actor, now, store, db }) {
  const cycle = await store.getCycle(cy);
  if (!cycle) return { reply: { text: `查無預班週期 ${cy}。`, items: null }, pushes: [] };
  if (!(TIERS[actor.tier] >= TIERS.exec || (TIERS[actor.tier] >= TIERS.head && actor.unit === cycle.unit))) {
    return { reply: { text: `${cy} 需該單位護理長或督導核准。`, items: null }, pushes: [] };
  }
  if (cycle.state !== 'REVIEW') return { reply: { text: `${cy} 狀態為 ${cycle.state}，不可公告。`, items: null }, pushes: [] };
  const draft = JSON.parse(cycle.draft_json || '[]');
  await store.insertShifts(draft.map((a) => ({ staffId: a.staffId, date: a.date, shift: a.shift, unit: a.unit, source: 'generated', writtenAt: now })));
  await store.updateCycle(cy, { state: 'PUBLISHED', published_at: now, published_by: actor.staff_id });
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'prebook.published', payload: { cycle: cy, shifts: draft.length } });
  const staff = liveData(db).staff.filter((s) => s.unit === cycle.unit);
  const text = `【${monthLabel(cycle.month)}班表已公告｜${UNITS[cycle.unit] || cycle.unit}】共 ${draft.length} 格。輸入「我的班表」或到平台查看。`;
  return {
    reply: { text: `已公告 ${monthLabel(cycle.month)}班表（${draft.length} 格寫入正式班表），全單位 ${staff.length} 人已通知。`, items: null },
    pushes: staff.map((s) => ({ staffId: s.id, text, items: null })),
  };
}

async function holdFlow({ cy, actor, now, store }) {
  const cycle = await store.getCycle(cy);
  if (!cycle) return { reply: { text: `查無預班週期 ${cy}。`, items: null }, pushes: [] };
  if (cycle.state !== 'REVIEW') return { reply: { text: `${cy} 狀態為 ${cycle.state}。`, items: null }, pushes: [] };
  await store.appendAudit({ ts: now, actor: actor.staff_id, action: 'prebook.held', payload: { cycle: cy } });
  return { reply: { text: `草稿保留（${cy}），未寫入班表。到平台調整後，輸入「預班狀態」再按核准。`, items: null }, pushes: [] };
}

/* ── 6. cron：催繳與到期截止 ── */
async function prebookCron({ now, store }) {
  const open = await store.listCycles({ states: ['OPEN'] });
  const pushes = [];
  let reminded = 0, closed = 0;
  for (const c of open) {
    if (c.deadline <= now) {
      pushes.push(...await closeAndGenerate(c, now, store, null));
      closed += 1;
      continue;
    }
    const due = PREBOOK_REMIND_DAYS.filter((d) => now >= isoPlusMinutes(c.deadline, -d * 1440)).length;   // 到了幾輪
    if (!due) continue;
    const pending = (await store.listPrebookRequests(c.id, 'PENDING')).filter((r) => (r.reminded_count || 0) < due);
    if (!pending.length) continue;
    const msg = reminderMessage(c);
    for (const r of pending) {
      await store.updatePrebookRequest(c.id, r.staff_id, { reminded_count: (r.reminded_count || 0) + 1, last_reminded_at: now });
      pushes.push({ staffId: r.staff_id, text: msg.text, items: msg.items });
    }
    await store.appendAudit({ ts: now, actor: null, action: 'prebook.reminded', payload: { cycle: c.id, round: due, count: pending.length, staff: pending.map((r) => r.staff_id) } });
    reminded += pending.length;
  }
  return { reminded, closed, pushes };
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
    tierFromWord, classifyCommand, commandAllowed, tierDeniedText, normalizeCmdText,
    // Phase 1 替班迴路
    SUB_TOP_N, genRequestId, timeoutMinutesFor, gapLabel, approvalMessage,
    reportFlow, approveFlow, skipFlow, rejectFlow, answerFlow, expireFlow, advanceAsk,
    // Phase 1.5 調整＋常駐指令
    TIMEOUT_PRESETS, phase15Command, adjustMessage, adjustFlow, topFlow, reorderFlow, timeoutFlow,
    pendingFlow, myAskFlow, whoamiText, reportGuideMessage,
    PENDING_RE, MYASK_RE, WHOAMI_RE, REPORT_GUIDE_RE, BIND_GUIDE_RE,
    // Phase 1.6 資料範圍
    resolveScope, parseUnitWord, dashboardUnit,
    // Phase 2 預班迴路
    PREBOOK_DEFAULT_MAX, PREBOOK_REMIND_DAYS, OPEN_CYCLE_RE, PREBOOK_RE, MYPREBOOK_RE, CYCLE_STATUS_RE, REMIND_NOW_RE, CLOSE_CYCLE_RE,
    parseMonthWord, monthDays, defaultDeadline, parseDeadlineWord, parseDateList, expandDateIn, requirementsFor,
    announceMessage, reminderMessage, reviewMessage,
    openCycleFlow, prebookFlow, myPrebookFlow, cycleStatusFlow, remindNowFlow, closeCycleFlow, closeAndGenerate,
    publishFlow, holdFlow, prebookCron,
    // Phase 3a 生成需求可設定
    REQ_RE, parseRequirementWords, defaultRequirementCounts, unitRequirements, requirementLabel, requirementFlow,
    // Phase 3b 平台登入
    PLATFORM_LOGIN_RE, platformLoginMessage,
    // Phase 3d 平台編輯寫回
    SHIFT_SOURCES, shiftKey, shiftSourceOf, validateShiftRows, diffShifts, shiftRowForPlatform,
  };
}
