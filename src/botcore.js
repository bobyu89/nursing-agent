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

/** 與平台完全同一份設定的引擎（含四週彈性工時錨點）——bot 所有功能共用 */
function platformEngine() {
  return createEngine({
    staff: STAFF, shifts: SHIFTS, shiftTypes: SHIFT_TYPES, roleLevels: ROLE_LEVELS,
    ladderLevels: LADDER_LEVELS, certs: CERTS, units: UNITS,
    registry: RULE_REGISTRY, staffingMin: UNIT_MIN_STAFF,
    flexCycleAnchor: FLEX_CYCLE_ANCHOR,
  });
}

function runEngine(p) {
  const gap = buildGap(p);
  return { gap, ...platformEngine().evaluateGap(gap) };
}

function evaluateAndFormat(p, platformUrl) {
  const { gap, candidates, excluded } = runEngine(p);

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

async function draftAndFormat(p, platformUrl) {
  globalThis.LLM.mode = 'mock';
  const { gap, candidates } = runEngine(p);
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
const FLEX_C = { red: '#C92C21', amber: '#93600A', green: '#117A58', ink: '#16233A', faint: '#5C6B85', line: '#E4E9F1', brand: '#4060EF' };

function buildDashboardFlex(platformUrl) {
  const C = FLEX_C;
  const eng = createEngine({
    staff: STAFF, shifts: SHIFTS, shiftTypes: SHIFT_TYPES, roleLevels: ROLE_LEVELS,
    ladderLevels: LADDER_LEVELS, certs: CERTS, units: UNITS,
    registry: RULE_REGISTRY, staffingMin: UNIT_MIN_STAFF,
    flexCycleAnchor: FLEX_CYCLE_ANCHOR,
  });
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
          action: { type: 'uri', label: '開啟完整儀表板', uri: platformUrl },
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

function swapCommand(text, platformUrl) {
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

  const pick = (id, d) => SHIFTS.filter((s) => s.staffId === id && s.date === d);
  const rowsA = pick(A, dA);
  const rowsB = pick(B, dB);
  if (!STAFF.some((s) => s.id === A)) return { text: `查無人員 ${A}（請用代號，如 N-01）。`, items: null };
  if (!STAFF.some((s) => s.id === B)) return { text: `查無人員 ${B}（請用代號，如 N-01）。`, items: null };
  if (!rowsA.length) return { text: `${A} 在 ${shortDate(dA)}（${weekdayOf(dA)}）沒有班次，無班可換。`, items: null };
  if (!rowsB.length) return { text: `${B} 在 ${shortDate(dB)}（${weekdayOf(dB)}）沒有班次，無班可換。`, items: null };

  const a = { staffId: A, date: dA, shift: rowsA[0].shift };
  const b = { staffId: B, date: dB, shift: rowsB[0].shift };
  const r = platformEngine().analyzeSwap(a, b, { requiredCerts: ['ACLS'] });
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

function dispatchCommand(text, platformUrl) {
  const m = DISPATCH_RE.exec(text);
  if (!m) return null;
  const date = m[1] ? expandDate(m[1]) : GAP_EVENT.raisedAt.slice(0, 10);
  const shift = m[2] ? SHIFT_WORDS[m[2].toUpperCase()] || SHIFT_WORDS[m[2]] : 'E';
  if (!date || !shift) {
    return { text: '用法：調度 [日期] [班別]\n例：調度 8/9 大夜（不帶參數＝示範今日的小夜）', items: null };
  }

  const eng = platformEngine();
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

function retentionCommand(text, platformUrl) {
  if (!RETENTION_RE.test(text)) return null;
  const led = platformEngine().workloadLedger(WEEK_DATES);
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

/** 三個指令的統一入口：命中回訊息物件，未命中回 null（宿主一行接入） */
function extraCommand(text, platformUrl) {
  return swapCommand(text, platformUrl)
    || dispatchCommand(text, platformUrl)
    || retentionCommand(text, platformUrl);
}

const DASHBOARD_RE = /^(儀表板|戰情|狀態|缺口|dashboard)$/i;
const MENU_RE = /^(選單|功能|幫助|menu|help)$/i;

/** 功能選單：快速按鈕（圖文選單 Rich Menu 的輕量版，隨時可叫出） */
function menuMessage(platformUrl) {
  return {
    type: 'text',
    text: '請選擇功能（也可以直接把請假訊息傳給我）：',
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '📊 戰情儀表板', text: '儀表板' } },
      { type: 'action', action: { type: 'message', label: '🔁 換班預檢', text: '換班' } },
      { type: 'action', action: { type: 'message', label: '🧭 調度棋盤', text: '調度' } },
      { type: 'action', action: { type: 'message', label: '📈 負荷雷達', text: '負荷' } },
      { type: 'action', action: { type: 'message', label: '📝 通報範例', text: '護理長不好意思，我明天白班發燒沒辦法上，很抱歉' } },
      { type: 'action', action: { type: 'uri', label: '🌐 開啟平台', uri: platformUrl } },
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
  '隨時輸入「選單」叫出功能快速按鈕。',
  '規則 H1–H10（含四週彈性工時與母性保護），與平台同一份引擎。',
  '提醒：請以人員代號通報；訊息中請勿包含任何病人資訊。',
  `平台入口：${platformUrl}`,
].join('\n');

/* 讓 Workers（esbuild）、Lambda（CJS interop）、瀏覽器測試頁與 Node CI 共用 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FIELD_TW, encodeParams, decodeParams, askNext, buildGap, runEngine,
    evaluateAndFormat, draftAndFormat, buildDashboardFlex,
    DASHBOARD_RE, MENU_RE, menuMessage, welcomeText,
    swapCommand, dispatchCommand, retentionCommand, extraCommand, expandDate,
  };
}
