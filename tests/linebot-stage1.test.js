/**
 * linebot-stage1.test.js — LINE 機器人 Stage 1 地基的測試（docs/LINEBOT-STAGE1.md §2）
 *
 * 釘住的是：資料來源注入（D1 快照 vs 示範資料的回落）、綁定碼的一碼一用與 30 分鐘效期、
 * 發碼限已知人員、留痕鏈的規範化字串、以及「沒接 D1 時所有 Stage 1 指令誠實說不可用」。
 * store 用記憶體假物件——與 cloudflare/linebot/store-d1.mjs 同一介面，不碰任何真實資料庫。
 */

/* ── 測試用記憶體 store：與 store-d1 同介面，順便記錄每次呼叫供斷言 ── */
function memStore() {
  const codes = new Map();      // code → {staff_id, issued_by, expires_at, used_at}
  const idByUser = new Map();   // lineUserId → identity
  const audit = [];
  return {
    codes, idByUser, audit,
    async issueBindCode({ code, staffId, tier, issuedBy, issuedAt, expiresAt }) {
      codes.set(code, { staff_id: staffId, tier: tier || 'staff', issued_by: issuedBy, issued_at: issuedAt, expires_at: expiresAt, used_at: null });
    },
    async consumeBindCode(code, nowIso) {
      const r = codes.get(code);
      if (!r || r.used_at) return null;
      r.used_at = nowIso;
      return { staff_id: r.staff_id, tier: r.tier, expires_at: r.expires_at, used_at: r.used_at };
    },
    async getIdentityByUser(u) { return idByUser.get(u) || null; },
    async bindIdentity({ lineUserId, staffId, unit, role, tier, boundAt }) {
      let replacedLineUserId = null;
      for (const [u, id] of idByUser) if (id.staff_id === staffId && u !== lineUserId) { replacedLineUserId = u; idByUser.delete(u); }
      idByUser.delete(lineUserId);
      idByUser.set(lineUserId, { line_user_id: lineUserId, staff_id: staffId, unit, role, tier: tier || 'staff', bound_at: boundAt });
      return { replacedLineUserId };
    },
    async appendAudit(e) { audit.push(e); return 'h' + audit.length; },
  };
}
const T0 = '2026-09-19T01:00:00.000Z';
const fixedRand = (seq) => { let i = 0; return () => seq[(i++) % seq.length]; };

/* ── 資料來源注入 ── */

test('stage1：liveData 未注入時回落示範資料，注入後以注入為準', () => {
  const fb = liveData(undefined);
  assert(fb.staff === STAFF && fb.shifts === SHIFTS, '未注入應直接回落全域示範資料');
  const one = { staff: [STAFF[0]], shifts: [] };
  const lv = liveData(one);
  assert(lv.staff === one.staff && lv.shifts === one.shifts, '注入後應以注入為準');
  const half = liveData({ staff: 'not-array', shifts: [] });
  assert(half.staff === STAFF && half.shifts.length === 0, '欄位逐一回落：壞的回落、好的採用');
});

test('stage1：同一條件下，注入只有原班人員的快照 → 引擎零候選（資料真的換了源）', () => {
  const p = { d: '2026-08-09', s: 'D', u: 'MED-3A', c: '' };
  const base = runEngine(p);
  assert(base.candidates.length > 0, '示範資料下應有候選（出廠基準）');
  const lone = runEngine(p, { staff: [STAFF[0]], shifts: SHIFTS });
  assert(lone.candidates.length + lone.excluded.length === 1, '注入單人快照後只評估那一人');
});

/* ── 指令解析與綁定碼 ── */

test('stage1：stage1Command 命中「發碼 N-xx」與「綁定 N-xx 六碼」——手機打字的各種排版都要認得', () => {
  assertEqual(stage1Command('發碼 N-04'), { kind: 'issue', staffId: 'N-04', tierWord: '' });
  assertEqual(stage1Command('發碼 N-04 護理長'), { kind: 'issue', staffId: 'N-04', tierWord: '護理長' }, '第二個字詞是權責層');
  assertEqual(stage1Command('  綁定 N-04 483920 '), { kind: 'bind', staffId: 'N-04', code: '483920' });
  // 真實使用者會打出來的變體（2026-09-19 實機第一次綁定就卡在這）
  const want = { kind: 'bind', staffId: 'N-01', code: '078318' };
  for (const v of ['綁定N-01 078318', '綁定 n-01 078318', '綁定 N01 078318', '綁定 N-1 078318',
    '綁定 N-01　078318', '綁定 N-01 ０７８３１８', '綁定 N-01 078318。', '綁定：N-01 078318',
    '綁定 Ｎ－01 078318', '綁定 N-01,078318']) {
    assertEqual(stage1Command(v), want, `應認得：${JSON.stringify(v)}`);
  }
  assertEqual(stage1Command('發碼n4'), { kind: 'issue', staffId: 'N-04', tierWord: '' }, '發碼同樣寬鬆並補零');
  // 語義不符的仍不命中
  assertEqual(stage1Command('綁定 N-04 48392'), null, '五碼不命中');
  assertEqual(stage1Command('綁定 N-04 4839201'), null, '七碼不命中');
  assertEqual(stage1Command('綁定 N-123 483920'), null, '三位代號不命中');
  assertEqual(stage1Command('儀表板'), null);
  assertEqual(stage1Command('我明天綁定不了'), null, '句中出現關鍵字不命中');
  assertEqual(stage1Command(''), null);
});

test('stage1：genBindCode 恆為六位數字，且由注入的亂數決定（可重現）', () => {
  const c = genBindCode(fixedRand([0.4, 0.8, 0.3, 0.9, 0.2, 0.0]));
  assertEqual(c, '483920');
  for (let i = 0; i < 50; i += 1) assert(/^\d{6}$/.test(genBindCode()), '預設亂數也應是六位數字');
});

test('stage1：isoPlusMinutes 純字串進出，跨日正確', () => {
  assertEqual(isoPlusMinutes('2026-09-19T23:50:00.000Z', 30), '2026-09-20T00:20:00.000Z');
});

/* ── 發碼流程 ── */

test('stage1：發碼——查無人員即拒絕、不寫任何東西；已知人員寫碼＋留痕、回覆含碼與效期', async () => {
  const st = memStore();
  const bad = await issueBindCodeFlow({ staffId: 'N-99', adminHash: 'adm', now: T0, store: st });
  assert(/查無人員 N-99/.test(bad.text), '未知代號應明說');
  assertEqual(st.codes.size, 0, '不得為未知代號發碼');
  assertEqual(st.audit.length, 0, '拒絕發碼不留痕（沒有事件發生）');

  const ok = await issueBindCodeFlow({ staffId: 'N-04', adminHash: 'adm', now: T0, store: st,
    rand: fixedRand([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) });
  assert(/123456/.test(ok.text), '回覆應含綁定碼');
  assert(new RegExp(BIND_CODE_TTL_MIN + ' 分鐘').test(ok.text), '回覆應含效期');
  const rec = st.codes.get('123456');
  assertEqual(rec.staff_id, 'N-04');
  assertEqual(rec.expires_at, isoPlusMinutes(T0, BIND_CODE_TTL_MIN), '效期＝發碼時間＋TTL');
  assertEqual(st.audit[0].action, 'bind_code.issued');
  assertEqual(st.audit[0].payload.issuedBy, 'adm', '留痕只放管理者雜湊');
});

/* ── 綁定流程 ── */

test('stage1：綁定——成功寫入身分、留痕、回覆含單位與角色', async () => {
  const st = memStore();
  await issueBindCodeFlow({ staffId: 'N-04', adminHash: 'adm', now: T0, store: st, rand: fixedRand([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) });
  const out = await bindFlow({ lineUserId: 'U1', lineUserHash: 'h1', staffId: 'N-04', code: '123456', now: isoPlusMinutes(T0, 5), store: st });
  assert(/已綁定為 N-04/.test(out.text), out.text);
  const id = st.idByUser.get('U1');
  assertEqual(id.staff_id, 'N-04');
  assertEqual(id.unit, STAFF.find((s) => s.id === 'N-04').unit);
  assertEqual(st.audit.at(-1).action, 'bind.completed');
  assertEqual(st.audit.at(-1).payload.lineUser, 'h1', '留痕放雜湊不放原值');
});

test('stage1：綁定——一碼一用；第二次用同一碼被拒且留痕', async () => {
  const st = memStore();
  await issueBindCodeFlow({ staffId: 'N-04', adminHash: 'adm', now: T0, store: st, rand: fixedRand([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) });
  await bindFlow({ lineUserId: 'U1', lineUserHash: 'h1', staffId: 'N-04', code: '123456', now: T0, store: st });
  const again = await bindFlow({ lineUserId: 'U2', lineUserHash: 'h2', staffId: 'N-04', code: '123456', now: T0, store: st });
  assert(/綁定失敗/.test(again.text));
  assert(!st.idByUser.has('U2'), 'U2 不得被綁定');
  assertEqual(st.audit.at(-1).action, 'bind.rejected');
  assertEqual(st.audit.at(-1).payload.why, 'no-such-or-used');
});

test('stage1：綁定——代號不符、逾期各自拒絕，理由留痕；逾期的碼也已被消耗', async () => {
  const st = memStore();
  await issueBindCodeFlow({ staffId: 'N-04', adminHash: 'adm', now: T0, store: st, rand: fixedRand([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) });
  const wrong = await bindFlow({ lineUserId: 'U1', lineUserHash: 'h1', staffId: 'N-05', code: '123456', now: T0, store: st });
  assert(/綁定失敗/.test(wrong.text));
  assertEqual(st.audit.at(-1).payload.why, 'staff-mismatch');

  const st2 = memStore();
  await issueBindCodeFlow({ staffId: 'N-04', adminHash: 'adm', now: T0, store: st2, rand: fixedRand([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) });
  const late = await bindFlow({ lineUserId: 'U1', lineUserHash: 'h1', staffId: 'N-04', code: '123456',
    now: isoPlusMinutes(T0, BIND_CODE_TTL_MIN + 1), store: st2 });
  assert(/綁定失敗/.test(late.text));
  assertEqual(st2.audit.at(-1).payload.why, 'expired');
  assert(st2.codes.get('123456').used_at, '逾期嘗試也消耗該碼，不得留給下一次');
});

test('stage1：綁定——同代號換手機：舊帳號失效、回覆明說、留痕 replaced=true', async () => {
  const st = memStore();
  const r = fixedRand([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  await issueBindCodeFlow({ staffId: 'N-04', adminHash: 'adm', now: T0, store: st, rand: r });
  await bindFlow({ lineUserId: 'OLD', lineUserHash: 'ho', staffId: 'N-04', code: '123456', now: T0, store: st });
  await issueBindCodeFlow({ staffId: 'N-04', adminHash: 'adm', now: T0, store: st, rand: fixedRand([0.9, 0.9, 0.9, 0.9, 0.9, 0.9]) });
  const out = await bindFlow({ lineUserId: 'NEW', lineUserHash: 'hn', staffId: 'N-04', code: '999999', now: T0, store: st });
  assert(/換手機/.test(out.text), '應提示舊帳號失效');
  assert(!st.idByUser.has('OLD') && st.idByUser.get('NEW').staff_id === 'N-04');
  assertEqual(st.audit.at(-1).payload.replaced, true);
});

test('stage1：沒接 D1（store 為 null）時，發碼與綁定都誠實回「未啟用」，不拋錯', async () => {
  const a = await issueBindCodeFlow({ staffId: 'N-04', adminHash: 'adm', now: T0, store: null });
  const b = await bindFlow({ lineUserId: 'U', lineUserHash: 'h', staffId: 'N-04', code: '123456', now: T0, store: null });
  assertEqual(a.text, STORE_DISABLED_TEXT);
  assertEqual(b.text, STORE_DISABLED_TEXT);
});

/* ── 留痕鏈 ── */

test('stage1：auditCanonical 欄位順序固定、系統動作 actor 為空字串、改任一欄結果即變', () => {
  const base = { prevHash: 'abc', ts: T0, actor: 'N-04', action: 'bind.completed', payloadJson: '{"a":1}' };
  assertEqual(auditCanonical(base), `abc|${T0}|N-04|bind.completed|{"a":1}`);
  assertEqual(auditCanonical({ ...base, actor: null }), `abc|${T0}||bind.completed|{"a":1}`, 'cron 等系統動作 actor 為空');
  assertEqual(auditCanonical({ ...base, prevHash: '' }).startsWith('|'), true, '創世筆 prevHash 為空');
  assert(auditCanonical(base) !== auditCanonical({ ...base, payloadJson: '{"a":2}' }), 'payload 變即變');
});

/* ── 權責層與權限矩陣（§2.5）── */

test('stage1：權限矩陣——三層照抄平台 ROLES，上級涵蓋下級', () => {
  const allowed = (t) => Object.keys(COMMAND_MIN_TIER).filter((k) => commandAllowed(t, k)).sort();
  assertEqual(allowed('staff'), ['guide', 'menu', 'report', 'swap'], '護理師：通報、換班、選單、說明');
  assertEqual(allowed('head'), ['dashboard', 'guide', 'menu', 'report', 'swap'], '護理長：多儀表板');
  assertEqual(allowed('exec'), ['dashboard', 'dispatch', 'guide', 'menu', 'report', 'retention', 'swap'], '督導：全部');
  assert(!commandAllowed('staff', 'dispatch') && !commandAllowed('head', 'retention'), '護理師不得調度、護理長不得看負荷');
  assert(!commandAllowed('nobody', 'menu') && !commandAllowed('exec', 'unknown'), '未知層級或未知指令一律拒');
});

test('stage1：classifyCommand 把每句話歸到矩陣的一個鍵，非指令一律視為通報', () => {
  assertEqual(['儀表板', '戰情', '負荷', '雷達', '調度 ICU N', '換班 N-01 8/3 N-02 8/5', '選單', 'help', '使用說明']
    .map(classifyCommand), ['dashboard', 'dashboard', 'retention', 'retention', 'dispatch', 'swap', 'menu', 'menu', 'guide']);
  assertEqual(classifyCommand('我明天大夜不能來'), 'report');
});

test('stage1：發碼可授權權責層——省略＝護理師、護理長／督導／主任各自對應、不認得的字直接拒', async () => {
  const r = () => fixedRand([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  const st = memStore();
  const a = await issueBindCodeFlow({ staffId: 'N-04', tierWord: '', adminHash: 'adm', now: T0, store: st, rand: r() });
  assert(/權責層：護理師/.test(a.text), a.text);
  assertEqual(st.codes.get('123456').tier, 'staff');
  assertEqual(st.audit.at(-1).payload.tier, 'staff', '發碼留痕記 tier');

  const st2 = memStore();
  const b = await issueBindCodeFlow({ staffId: 'N-04', tierWord: '護理長', adminHash: 'adm', now: T0, store: st2, rand: r() });
  assert(/權責層：護理長/.test(b.text));
  assertEqual(st2.codes.get('123456').tier, 'head');

  const st3 = memStore();
  await issueBindCodeFlow({ staffId: 'N-04', tierWord: '主任', adminHash: 'adm', now: T0, store: st3, rand: r() });
  assertEqual(st3.codes.get('123456').tier, 'exec', '「主任」與「督導」同義');

  const st4 = memStore();
  const d = await issueBindCodeFlow({ staffId: 'N-04', tierWord: '院長', adminHash: 'adm', now: T0, store: st4, rand: r() });
  assert(/不認得/.test(d.text) && st4.codes.size === 0 && st4.audit.length === 0, '不認得的層級：不發碼、不留痕、說清楚可用選項');
});

test('stage1：綁定把碼上的 tier 帶進 identity 與留痕，回覆明示權責層', async () => {
  const st = memStore();
  await issueBindCodeFlow({ staffId: 'N-04', tierWord: '督導', adminHash: 'adm', now: T0, store: st, rand: fixedRand([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) });
  const out = await bindFlow({ lineUserId: 'U1', lineUserHash: 'h1', staffId: 'N-04', code: '123456', now: T0, store: st });
  assert(/權責層：督導／主任/.test(out.text), out.text);
  assertEqual(st.idByUser.get('U1').tier, 'exec');
  assertEqual(st.audit.at(-1).payload.tier, 'exec');
});

test('stage1：tierDeniedText 說清楚屬哪一層、你是哪一層——不假裝指令不存在', () => {
  const t = tierDeniedText('dispatch', 'staff');
  assert(/調度棋盤/.test(t) && /督導／主任以上/.test(t) && /護理師/.test(t), t);
});

/* ══ Phase 1：替班迴路（§4）══════════════════════════════════════════
 * 記憶體 store 擴充：請求／詢問／身分清單／寫回，語義與 store-d1 一致（原子 answer／expire）。 */
function subStore() {
  const base = memStore();
  const reqs = new Map();
  const asks = [];            // {request_id, seq, staff_id, asked_at, expired_at, answered_at, answer}
  const subs = [];            // applySubstitution 呼叫紀錄
  const seed = (lineUserId, staffId, unit, tier) => base.idByUser.set(lineUserId, { line_user_id: lineUserId, staff_id: staffId, unit, role: '護理師', tier, bound_at: P0 });
  return Object.assign(base, {
    reqs, asks, subs, seed,
    async listIdentities({ unit, minTierRank }) {
      return [...base.idByUser.values()].filter((i) => TIERS[i.tier] >= (minTierRank || 0) && (!unit || i.unit === unit));
    },
    async getIdentityByStaff(staffId) { return [...base.idByUser.values()].find((i) => i.staff_id === staffId) || null; },
    async findOpenSubRequest({ unit, date, shift, originalStaffId }) {
      return [...reqs.values()].find((r) => r.unit === unit && r.date === date && r.shift === shift && r.original_staff_id === originalStaffId && ['REPORTED', 'APPROVED', 'ASKING'].includes(r.state)) || null;
    },
    async createSubRequest(r) { reqs.set(r.id, { ...r }); },
    async getSubRequest(id) { return reqs.get(id) ? { ...reqs.get(id) } : null; },
    async updateSubRequest(id, patch) { Object.assign(reqs.get(id), patch); },
    async listAsks(id) { return asks.filter((a) => a.request_id === id).sort((a, b) => a.seq - b.seq).map((a) => ({ ...a })); },
    async insertAsk({ requestId, seq, staffId, askedAt, expiredAt }) { asks.push({ request_id: requestId, seq, staff_id: staffId, asked_at: askedAt, expired_at: expiredAt, answered_at: null, answer: null }); },
    async answerAsk({ requestId, staffId, answer, answeredAt }) {
      const a = asks.find((x) => x.request_id === requestId && x.staff_id === staffId && x.answer === null);
      if (!a) return null;
      a.answer = answer; a.answered_at = answeredAt;
      return { request_id: a.request_id, seq: a.seq, staff_id: a.staff_id, answer: a.answer };
    },
    async cancelOpenAsk(requestId, now) {
      const a = asks.find((x) => x.request_id === requestId && x.answer === null);
      if (!a) return null;
      a.answer = 'cancelled'; a.answered_at = now;
      return { request_id: a.request_id, seq: a.seq, staff_id: a.staff_id };
    },
    async expireDueAsks(now) {
      const due = asks.filter((x) => x.answer === null && x.expired_at < now);
      due.forEach((a) => { a.answer = 'timeout'; a.answered_at = now; });
      return due.map((a) => ({ request_id: a.request_id, seq: a.seq, staff_id: a.staff_id }));
    },
    async applySubstitution(args) { subs.push(args); },
  });
}
const GAP_P = { d: '2026-08-09', s: 'D', u: 'MED-3A', c: '' };
const P0 = '2026-08-01T01:00:00.000Z';   // 示範缺班日 8/9 之前一週：逾時落在 >48h 的 4 小時檔
const rand6 = () => fixedRand([0.5]);
async function reported(st) {
  st.seed('Uhead', 'N-01', 'MED-3A', 'head');
  st.seed('Urep', 'N-05', 'MED-3A', 'staff');
  const rep = await st.getIdentityByUser('Urep');
  const out = await reportFlow({ p: GAP_P, reporter: rep, reasonType: '病假', now: P0, store: st, rand: rand6() });
  const id = /已通報 (R\w{6})/.exec(out.reply.text)[1];
  return { out, id, rep, head: await st.getIdentityByUser('Uhead') };
}

test('phase1：通報——建立 REPORTED 請求、候選 ≤5 含理由、逾時分級、推播核准給同單位護理長、留痕', async () => {
  const st = subStore();
  const { out, id } = await reported(st);
  const r = st.reqs.get(id);
  assertEqual(r.state, 'REPORTED');
  assertEqual(r.original_staff_id, 'N-05', '原班人員＝通報者');
  const cands = JSON.parse(r.candidates_json);
  assert(cands.length > 0 && cands.length <= SUB_TOP_N, '候選 1–5 位');
  assert(cands.every((c) => c.id && typeof c.total === 'number' && c.why), '每位有代號、分數、理由');
  assert(!cands.some((c) => c.id === 'N-05'), '原班人員不在候選內');
  assertEqual(r.timeout_min, 240, '缺班在 >48 小時後 → 4 小時檔');
  assertEqual(out.pushes.length, 1);
  assertEqual(out.pushes[0].staffId, 'N-01', '推給同單位護理長');
  assert(/待核准｜/.test(out.pushes[0].text) && out.pushes[0].items.some((i) => /核准/.test(i.label)) && out.pushes[0].items.some((i) => /駁回/.test(i.label)));
  assert(out.pushes[0].items.some((i) => i.label === `略過 ${cands[0].id}`), '每位候選有略過鍵');
  assertEqual(st.audit.at(-1).action, 'sub.reported');
  assertEqual(st.audit.at(-1).payload.candidates, cands.map((c) => c.id));
});

test('phase1：通報——同一缺口重複通報不建第二筆；單位無護理長時改推管理者並明說', async () => {
  const st = subStore();
  const { id, rep } = await reported(st);
  const again = await reportFlow({ p: GAP_P, reporter: rep, now: P0, store: st, rand: rand6() });
  assert(new RegExp(id).test(again.reply.text) && /不重複/.test(again.reply.text));
  assertEqual(st.reqs.size, 1);

  const st2 = subStore();
  st2.seed('Urep', 'N-05', 'MED-3A', 'staff');
  const out = await reportFlow({ p: GAP_P, reporter: await st2.getIdentityByUser('Urep'), now: P0, store: st2, rand: rand6() });
  assert(out.pushes.length === 1 && out.pushes[0].admin === true, '無護理長 → 推管理者');
  assert(/尚無護理長綁定/.test(out.reply.text));
});

test('phase1：核准——需同單位護理長或督導；核准後凍結序列、留痕 sequence、立刻問第 1 位（附接／不接）', async () => {
  const st = subStore();
  const { id, head, rep } = await reported(st);
  const cands = JSON.parse(st.reqs.get(id).candidates_json);

  const byStaff = await approveFlow({ rq: id, actor: rep, now: P0, store: st });
  assert(/需該單位護理長或督導/.test(byStaff.reply.text) && st.reqs.get(id).state === 'REPORTED', '護理師不得核准');
  st.seed('Uother', 'N-09', 'SUR-5B', 'head');
  const otherUnit = await approveFlow({ rq: id, actor: await st.getIdentityByUser('Uother'), now: P0, store: st });
  assert(/需該單位/.test(otherUnit.reply.text), '別單位的護理長不得核准');

  const ok = await approveFlow({ rq: id, actor: head, now: P0, store: st });
  assertEqual(st.reqs.get(id).state, 'ASKING');
  assertEqual(st.reqs.get(id).approved_by, 'N-01');
  const ap = st.audit.find((a) => a.action === 'sub.approved');
  assertEqual(ap.payload.sequence, cands.map((c) => c.id), '核准留痕＝完整序列（正本）');
  assertEqual(ap.payload.selfApproved, false);
  assertEqual(st.asks.length, 1);
  assertEqual(st.asks[0].staff_id, cands[0].id, '第 1 位＝序列第 1');
  assertEqual(st.asks[0].expired_at, isoPlusMinutes(P0, 240));
  assertEqual(ok.pushes.length, 1);
  assertEqual(ok.pushes[0].staffId, cands[0].id);
  assert(ok.pushes[0].items.map((i) => i.label).join() === '✅ 接,❌ 不接');
  assert(/第 1 位/.test(ok.reply.text));

  const twice = await approveFlow({ rq: id, actor: head, now: P0, store: st });
  assert(/不可再核准/.test(twice.reply.text));
});

test('phase1：略過——只在 REPORTED 可用、從序列移除並留痕、回新的核准訊息；核准後不可略過', async () => {
  const st = subStore();
  const { id, head } = await reported(st);
  const before = JSON.parse(st.reqs.get(id).candidates_json);
  const out = await skipFlow({ rq: id, who: before[0].id, actor: head, now: P0, store: st });
  const after = JSON.parse(st.reqs.get(id).candidates_json);
  assertEqual(after.length, before.length - 1);
  assert(!after.some((c) => c.id === before[0].id));
  assertEqual(st.audit.at(-1).action, 'sub.skipped');
  assert(out.reply.items.some((i) => /核准（/.test(i.label)), '回覆帶新的核准按鈕');
  const nobody = await skipFlow({ rq: id, who: 'N-99', actor: head, now: P0, store: st });
  assert(/不在/.test(nobody.reply.text));
  await approveFlow({ rq: id, actor: head, now: P0, store: st });
  const late = await skipFlow({ rq: id, who: after[0].id, actor: head, now: P0, store: st });
  assert(/序列已凍結/.test(late.reply.text));
});

test('phase1：駁回——ASKING 中駁回會取消正在等的詢問、通知該候選與通報人', async () => {
  const st = subStore();
  const { id, head } = await reported(st);
  await approveFlow({ rq: id, actor: head, now: P0, store: st });
  const asked = st.asks[0].staff_id;
  const out = await rejectFlow({ rq: id, actor: head, now: P0, store: st });
  assertEqual(st.reqs.get(id).state, 'REJECTED');
  assertEqual(st.asks[0].answer, 'cancelled');
  assert(out.pushes.some((p) => p.staffId === 'N-05' && /駁回/.test(p.text)), '通報人收到駁回');
  assert(out.pushes.some((p) => p.staffId === asked && /取消/.test(p.text)), '被問的人收到取消');
});

test('phase1：不接——留痕、不扣分、立刻問下一位；最後一位也不接 → EXHAUSTED，推播護理長與通報人並附統計', async () => {
  const st = subStore();
  const { id, head } = await reported(st);
  await approveFlow({ rq: id, actor: head, now: P0, store: st });
  const cands = JSON.parse(st.reqs.get(id).candidates_json);
  for (let i = 0; i < cands.length; i += 1) {
    st.seed(`Uc${i}`, cands[i].id, 'MED-3A', 'staff');
    const actor = await st.getIdentityByUser(`Uc${i}`);
    const out = await answerFlow({ rq: id, answer: 'decline', actor, now: P0, store: st });
    assert(/不影響評分/.test(out.reply.text));
    if (i < cands.length - 1) {
      assertEqual(st.asks.length, i + 2, '問下一位');
      assertEqual(st.asks[i + 1].staff_id, cands[i + 1].id);
      assertEqual(out.pushes[0].staffId, cands[i + 1].id);
    } else {
      assertEqual(st.reqs.get(id).state, 'EXHAUSTED');
      assert(out.pushes.some((p) => p.staffId === 'N-01' && /無人可補/.test(p.text) && new RegExp(`拒絕 ${cands.length}`).test(p.text)));
      assert(out.pushes.some((p) => p.staffId === 'N-05' && /皆未接/.test(p.text)));
    }
  }
  assertEqual(st.subs.length, 0, '從頭到尾沒有寫回班表');
  assert(st.audit.filter((a) => a.action === 'sub.declined').length === cands.length);
});

test('phase1：接——寫回班表（原班移除、替補新增、代班 +1）、FILLED、通知通報人與護理長、回覆含前面誰逾時／不接', async () => {
  const st = subStore();
  const { id, head } = await reported(st);
  await approveFlow({ rq: id, actor: head, now: P0, store: st });
  const cands = JSON.parse(st.reqs.get(id).candidates_json);
  st.seed('Uc0', cands[0].id, 'MED-3A', 'staff');
  st.seed('Uc1', cands[1].id, 'MED-3A', 'staff');
  await answerFlow({ rq: id, answer: 'decline', actor: await st.getIdentityByUser('Uc0'), now: P0, store: st });
  const out = await answerFlow({ rq: id, answer: 'accept', actor: await st.getIdentityByUser('Uc1'), now: P0, store: st });
  assertEqual(st.reqs.get(id).state, 'FILLED');
  assertEqual(st.reqs.get(id).filled_by, cands[1].id);
  assertEqual(st.subs.length, 1);
  assertEqual(st.subs[0].originalStaffId, 'N-05');
  assertEqual(st.subs[0].substituteStaffId, cands[1].id);
  assertEqual(st.subs[0].date, '2026-08-09');
  assert(/班表已更新/.test(out.reply.text));
  assert(out.pushes.some((p) => p.staffId === 'N-05' && new RegExp(`由 ${cands[1].id} 接下`).test(p.text)));
  const toHead = out.pushes.find((p) => p.staffId === 'N-01');
  assert(/已補上/.test(toHead.text) && /第 2 位/.test(toHead.text) && new RegExp(`${cands[0].id}（不接）`).test(toHead.text), toHead.text);
  assertEqual(st.audit.at(-1).action, 'sub.filled');
});

test('phase1：遲到的接不算數——cron 已標逾時後再按接：不寫回、留痕 answer_ignored、回覆明說', async () => {
  const st = subStore();
  const { id, head } = await reported(st);
  await approveFlow({ rq: id, actor: head, now: P0, store: st });
  const cands = JSON.parse(st.reqs.get(id).candidates_json);
  const later = isoPlusMinutes(P0, 241);
  const ex = await expireFlow({ now: later, store: st });
  assertEqual(ex.expired, 1);
  assertEqual(st.asks[0].answer, 'timeout');
  assertEqual(st.asks[1].staff_id, cands[1].id, '逾時後自動問第 2 位');
  assert(ex.pushes.some((p) => p.staffId === cands[0].id && /已逾時/.test(p.text)));
  assert(ex.pushes.some((p) => p.staffId === cands[1].id && /替班詢問/.test(p.text)));

  st.seed('Uc0', cands[0].id, 'MED-3A', 'staff');
  const late = await answerFlow({ rq: id, answer: 'accept', actor: await st.getIdentityByUser('Uc0'), now: later, store: st });
  assert(/已逾時/.test(late.reply.text) && /不算數/.test(late.reply.text), late.reply.text);
  assertEqual(st.subs.length, 0);
  assertEqual(st.reqs.get(id).state, 'ASKING', '仍在問第 2 位');
  assertEqual(st.audit.at(-1).action, 'sub.answer_ignored');
});

test('phase1：不是問你的那一筆——第 2 位在第 1 位還在等時搶答，被拒且不影響序列', async () => {
  const st = subStore();
  const { id, head } = await reported(st);
  await approveFlow({ rq: id, actor: head, now: P0, store: st });
  const cands = JSON.parse(st.reqs.get(id).candidates_json);
  st.seed('Uc1', cands[1].id, 'MED-3A', 'staff');
  const out = await answerFlow({ rq: id, answer: 'accept', actor: await st.getIdentityByUser('Uc1'), now: P0, store: st });
  assert(/不是目前問你的/.test(out.reply.text));
  assertEqual(st.asks.length, 1);
  assertEqual(st.asks[0].answer, null, '第 1 位的詢問不受影響');
});

test('phase1：核准時無候選 → 直接 EXHAUSTED，不會空轉', async () => {
  const st = subStore();
  const { id, head } = await reported(st);
  await st.updateSubRequest(id, { candidates_json: '[]' });
  const out = await approveFlow({ rq: id, actor: head, now: P0, store: st });
  assertEqual(st.reqs.get(id).state, 'EXHAUSTED');
  assert(/無合格候選/.test(out.reply.text));
  assertEqual(st.asks.length, 0);
});

test('phase1：核准訊息的按鈕資料能被 decodeParams 還原（rq／act／who）', () => {
  const req = { id: 'RTESP01', unit: 'MED-3A', date: '2026-08-09', shift: 'D', required_certs_json: '[]', original_staff_id: 'N-05',
    reporter_staff_id: 'N-05', reason_type: '病假', timeout_min: 60, candidates_json: JSON.stringify([{ id: 'N-04', total: 100, max: 100, why: 'x' }]) };
  const m = approvalMessage(req);
  const parsed = m.items.map((i) => decodeParams(i.dataStr));
  assertEqual(parsed.map((p) => p.act), ['approve', 'reject', 'skip']);
  assert(parsed.every((p) => p.rq === 'RTESP01'));
  assertEqual(parsed[2].who, 'N-04');
});
