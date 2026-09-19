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
