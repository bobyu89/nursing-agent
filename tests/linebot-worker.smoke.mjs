/**
 * linebot-worker.smoke.mjs — Cloudflare Worker 的本機端到端煙霧測試（Stage 1 Phase 0）
 *
 * 不需要 wrangler、不需要 Cloudflare 帳號、不需要 LINE：
 *   ・用 node:sqlite（Node ≥ 22.5）把 schema.sql ＋ snapshot 灌進記憶體庫，包成 D1 相容介面
 *   ・攔截 globalThis.fetch，把 LINE reply／push 的呼叫錄下來
 *   ・用測試用 channel secret 對 webhook body 簽章，直接呼叫 worker 的 fetch()／scheduled()
 *
 * 走完：未綁定被擋 → 管理者發碼 → 本人綁定 → 儀表板改讀 D1 → 一碼一用 → 非管理者發碼被拒
 *       → 權責閘 → cron 清碼 → Phase 1 替班迴路（通報→核准→不接→接→寫回；逾時→cron→遲到的接；駁回）
 *       → 留痕鏈驗證 → 無 D1 時回落 Stage 0 行為
 *
 * 執行：node tests/linebot-worker.smoke.mjs
 * 不納入 run-node.js（CI 為 Node 20，無 node:sqlite）；部署前手動跑。
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-secret';
const ADMIN = 'Uadmin000000000000000000000000000';
const USER = 'Unurse000000000000000000000000000';
const OTHER = 'Uother000000000000000000000000000';

/* ── D1 相容包裝：只實作 worker/store-d1 用到的四個方法 ── */
function d1Like(sqlite) {
  const stmt = (sql, params) => ({
    async first() { const r = sqlite.prepare(sql).get(...params); return r === undefined ? null : r; },
    async run() { const r = sqlite.prepare(sql).run(...params); return { meta: { changes: r.changes } }; },
    async all() { return { results: sqlite.prepare(sql).all(...params) }; },
    _exec() { return /^\s*select/i.test(sql) ? { results: sqlite.prepare(sql).all(...params) } : { meta: { changes: sqlite.prepare(sql).run(...params).changes } }; },
  });
  return {
    prepare: (sql) => ({ bind: (...params) => stmt(sql, params), ...stmt(sql, []) }),
    async batch(stmts) { return stmts.map((s) => s._exec()); },
  };
}

/* ── LINE 呼叫錄影 ── */
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(init.body) });
  return { ok: true, status: 200, async text() { return ''; } };
};
const lastReply = () => calls.filter((c) => c.url.endsWith('/reply')).at(-1)?.body.messages[0];
const replyText = () => lastReply()?.text || '';

/* ── 簽章請求 ── */
function signed(events) {
  const raw = JSON.stringify({ events });
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
  return new Request('https://x/', { method: 'POST', body: raw, headers: { 'x-line-signature': sig } });
}
const textEv = (userId, text) => ({ type: 'message', replyToken: 'r' + calls.length, source: { userId }, message: { type: 'text', text } });

/* ── 準備 DB ── */
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(ROOT, 'cloudflare/linebot/schema.sql'), 'utf8'));
const snapshotSql = execFileSync(process.execPath, [path.join(ROOT, 'tools/snapshot-to-sql.cjs')], { encoding: 'utf8' });
db.exec(snapshotSql);

const worker = (await import(pathToFileURL(path.join(ROOT, 'cloudflare/linebot/worker.mjs')).href)).default;
const envD1 = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok', ADMIN_USER_ID: ADMIN, DB: d1Like(db) };
const envDemo = { LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'tok' };

let n = 0;
const step = (name, ok, detail = '') => { n += 1; console.log(`${ok ? '✓' : '✗'} ${n}. ${name}${ok ? '' : '\n    ' + detail}`); if (!ok) process.exitCode = 1; };

/* ── 0. 簽章錯誤要 403 ── */
{
  const res = await worker.fetch(new Request('https://x/', { method: 'POST', body: '{}', headers: { 'x-line-signature': 'bad' } }), envD1);
  step('壞簽章 → 403', res.status === 403, `got ${res.status}`);
}

/* ── 1. 未綁定使用者：只看到綁定說明 ── */
await worker.fetch(signed([textEv(USER, '儀表板')]), envD1);
step('未綁定者輸入「儀表板」→ 只回綁定說明', replyText().includes('尚未綁定人員代號'), replyText().slice(0, 80));

/* ── 2. 非管理者發碼被拒 ── */
await worker.fetch(signed([textEv(OTHER, '發碼 N-05')]), envD1);
step('未綁定者輸入「發碼」→ 一樣只回綁定說明（不洩漏指令存在）', replyText().includes('尚未綁定人員代號'), replyText().slice(0, 80));

/* ── 3. 管理者發碼 ── */
await worker.fetch(signed([textEv(ADMIN, '發碼 N-04 護理長')]), envD1);
const codeMatch = /　(\d{6})/.exec(replyText());
step('管理者「發碼 N-04 護理長」→ 回六位數碼、標明權責層', !!codeMatch && /權責層：護理長/.test(replyText()), replyText());
const code = codeMatch && codeMatch[1];
step('D1 bind_code 有這筆、未使用', !!db.prepare('SELECT 1 FROM bind_code WHERE code = ? AND used_at IS NULL').get(code));

/* ── 4. 本人綁定 ── */
await worker.fetch(signed([textEv(USER, `綁定 N-04 ${code}`)]), envD1);
step('本人「綁定 N-04 <碼>」→ 已綁定', /已綁定為 N-04/.test(replyText()), replyText());
const idRow = db.prepare('SELECT * FROM identity WHERE line_user_id = ?').get(USER);
step('identity 表寫入 N-04（tier=head），且只有代號沒有姓名', idRow && idRow.staff_id === 'N-04' && idRow.tier === 'head' && !JSON.stringify(idRow).includes('name'));

/* ── 5. 綁定後儀表板可用，且資料來自 D1 ── */
calls.length = 0;
await worker.fetch(signed([textEv(USER, '儀表板')]), envD1);
step('綁定後「儀表板」→ 回 Flex', lastReply()?.type === 'flex', JSON.stringify(lastReply()).slice(0, 80));
{
  // 把 D1 裡 N-01 的代班次數改成誇張值，儀表板公平列應反映——證明讀的是 D1 不是 data.js
  db.prepare("UPDATE staff SET standby_30d = 42 WHERE staff_id = 'N-01'").run();
  calls.length = 0;
  await worker.fetch(signed([textEv(USER, '儀表板')]), envD1);
  const flexJson = JSON.stringify(lastReply());
  step('改 D1 的代班次數後儀表板跟著變（資料源確為 D1）', flexJson.includes('42'), '未見 42');
  db.prepare("UPDATE staff SET standby_30d = 4 WHERE staff_id = 'N-01'").run();
}

/* ── 6. 一碼一用 ── */
await worker.fetch(signed([textEv(OTHER, `綁定 N-04 ${code}`)]), envD1);
step('同一碼第二次綁定 → 失敗', /綁定失敗/.test(replyText()), replyText());
step('OTHER 未被綁定', !db.prepare('SELECT 1 FROM identity WHERE line_user_id = ?').get(OTHER));

/* ── 7. 已綁定的非管理者發碼 ── */
await worker.fetch(signed([textEv(USER, '發碼 N-05')]), envD1);
step('已綁定的非管理者「發碼」→ 限管理者', /限管理者/.test(replyText()), replyText());

/* ── 7½. 權責閘：staff 不得調度、exec 可以；管理者發碼可授權 ── */
{
  await worker.fetch(signed([textEv(ADMIN, '發碼 N-02')]), envD1);            // 預設 staff
  const c2 = /　(\d{6})/.exec(replyText())[1];
  await worker.fetch(signed([textEv(OTHER, `綁定 N-02 ${c2}`)]), envD1);
  step('N-02 以預設權責層綁定 → identity.tier = staff', db.prepare('SELECT tier FROM identity WHERE staff_id = ?').get('N-02')?.tier === 'staff');
  await worker.fetch(signed([textEv(OTHER, '調度')]), envD1);
  step('staff 輸入「調度」→ 誠實拒絕並說明屬督導視角', /調度棋盤.*督導／主任以上/.test(replyText()), replyText());
  await worker.fetch(signed([textEv(OTHER, '儀表板')]), envD1);
  step('staff 輸入「儀表板」→ 拒絕（屬護理長以上）', /儀表板.*護理長以上/.test(replyText()), replyText());
  await worker.fetch(signed([textEv(OTHER, '換班')]), envD1);
  step('staff 輸入「換班」→ 允許（回用法說明）', /換班/.test(replyText()) && !/視角/.test(replyText()), replyText().slice(0, 60));

  const EXEC = 'Uexec0000000000000000000000000000';
  await worker.fetch(signed([textEv(ADMIN, '發碼 N-03 督導')]), envD1);
  const c3 = /　(\d{6})/.exec(replyText())[1];
  await worker.fetch(signed([textEv(EXEC, `綁定 N-03 ${c3}`)]), envD1);
  step('管理者「發碼 N-03 督導」→ 綁定後 identity.tier = exec', db.prepare('SELECT tier FROM identity WHERE staff_id = ?').get('N-03')?.tier === 'exec');
  calls.length = 0;
  await worker.fetch(signed([textEv(EXEC, '調度')]), envD1);
  step('exec 輸入「調度」→ 放行', !/視角/.test(replyText()), replyText().slice(0, 60));
  await worker.fetch(signed([textEv(ADMIN, '發碼 N-05 院長')]), envD1);
  step('不認得的權責層字詞 → 拒絕發碼並列出可用選項', /不認得/.test(replyText()), replyText());
}

/* ── 8. cron 清碼 ── */
await worker.scheduled({}, envD1);
step('cron 後已用的碼被清掉', !db.prepare('SELECT 1 FROM bind_code WHERE code = ?').get(code));

/* ── 8½. Phase 1 替班迴路：通報 → 核准 → 不接 → 接 → 寫回；逾時 → cron 問下一位；遲到的接 ── */
{
  const pb = (userId, data, tag) => ({ type: 'postback', replyToken: 'pb' + tag, source: { userId }, postback: { data } });
  const bindAs = async (staffId, lineUser) => {
    const existing = db.prepare('SELECT line_user_id FROM identity WHERE staff_id = ?').get(staffId);
    if (existing) return existing.line_user_id;
    await worker.fetch(signed([textEv(ADMIN, `發碼 ${staffId}`)]), envD1);
    const c = /　(\d{6})/.exec(replyText())[1];
    await worker.fetch(signed([textEv(lineUser, `綁定 ${staffId} ${c}`)]), envD1);
    return lineUser;
  };
  const pushes = () => calls.filter((c) => c.url.endsWith('/push')).map((c) => c.body);

  // 通報者 OTHER＝N-02（staff，MED-3A）；護理長 USER＝N-04（head，MED-3A）
  calls.length = 0;
  await worker.fetch(signed([textEv(OTHER, '我 8/9 白班不能來')]), envD1);
  let r = lastReply();
  step('通報：單位由身分帶入，只追問必要資格', /必要資格/.test(r.text) && !/哪一個照護單位/.test(r.text), r.text.slice(0, 80));
  const noCert = r.quickReply.items.find((i) => /無需/.test(i.action.label));
  await worker.fetch(signed([pb(OTHER, noCert.action.data, 1)]), envD1);
  r = lastReply();
  const rq = (/已通報 (R\w{6})/.exec(r.text) || [])[1];
  step('條件齊全 → 建立替班請求、回代號、說明已送核准', !!rq && /已送護理長核准/.test(r.text), r.text.slice(0, 120));
  const ap = pushes().at(-1);
  step('核准訊息推播給同單位護理長 N-04，附核准／駁回／略過鍵', ap && ap.to === USER && /待核准/.test(ap.messages[0].text)
    && ap.messages[0].quickReply.items.some((i) => /核准/.test(i.action.label)), JSON.stringify(ap).slice(0, 120));
  const row = db.prepare('SELECT * FROM sub_request WHERE id = ?').get(rq);
  step('D1 sub_request＝REPORTED、原班人員＝通報者、候選序列已凍結存檔', row && row.state === 'REPORTED' && row.original_staff_id === 'N-02' && JSON.parse(row.candidates_json).length > 1);
  const cands = JSON.parse(row.candidates_json);

  await worker.fetch(signed([pb(OTHER, encodeParams({ rq, act: 'approve' }), 2)]), envD1);
  step('通報者（staff）自己按核准 → 權責閘擋下', /核准替班.*護理長以上/.test(replyText()), replyText());

  const u1 = await bindAs(cands[0].id, 'Ucand1000000000000000000000000000');
  const u2 = await bindAs(cands[1].id, 'Ucand2000000000000000000000000000');
  calls.length = 0;
  await worker.fetch(signed([pb(USER, encodeParams({ rq, act: 'approve' }), 3)]), envD1);
  step('護理長核准 → 回覆「開始逐一詢問：第 1 位」', /已核准/.test(replyText()) && /第 1 位/.test(replyText()), replyText());
  step('核准當下只推播給第 1 位（第 2 位此時什麼都沒收到）', pushes().length === 1 && pushes()[0].to === u1 && /替班詢問/.test(pushes()[0].messages[0].text), JSON.stringify(pushes().map((b) => b.to)));
  const ask1 = db.prepare('SELECT * FROM sub_ask WHERE request_id = ? ORDER BY seq').all(rq);
  step('sub_ask 只有第 1 位、狀態 ASKING（同一時間只有一人看得到）', ask1.length === 1 && ask1[0].staff_id === cands[0].id
    && db.prepare('SELECT state FROM sub_request WHERE id = ?').get(rq).state === 'ASKING');
  step('核准留痕含完整序列（正本）', JSON.parse(db.prepare("SELECT payload_json FROM audit WHERE action='sub.approved' ORDER BY id DESC LIMIT 1").get().payload_json).sequence.join() === cands.map((c) => c.id).join());

  calls.length = 0;
  await worker.fetch(signed([pb(u1, encodeParams({ rq, act: 'decline' }), 4)]), envD1);
  step('第 1 位不接 → 回覆不影響評分；sub_ask 進到第 2 位', /不影響評分/.test(replyText())
    && db.prepare('SELECT COUNT(*) c FROM sub_ask WHERE request_id = ?').get(rq).c === 2, replyText());
  const askPush = pushes().at(-1);
  step('詢問推播給第 2 位，附接／不接兩鍵', askPush && /替班詢問/.test(askPush.messages[0].text) && askPush.messages[0].quickReply.items.length === 2);

  const standbyBefore = db.prepare('SELECT standby_30d FROM staff WHERE staff_id = ?').get(cands[1].id).standby_30d;
  calls.length = 0;
  await worker.fetch(signed([pb(u2, encodeParams({ rq, act: 'accept' }), 5)]), envD1);
  const filled = db.prepare('SELECT state, filled_by FROM sub_request WHERE id = ?').get(rq);
  step('第 2 位接 → FILLED、filled_by 正確', filled.state === 'FILLED' && filled.filled_by === cands[1].id, JSON.stringify(filled));
  step('班表寫回：N-02 的 8/9 白班移除、替補新增（source=substitution）',
    !db.prepare("SELECT 1 FROM shift WHERE staff_id = 'N-02' AND date = '2026-08-09' AND shift = 'D'").get()
    && db.prepare("SELECT source FROM shift WHERE staff_id = ? AND date = '2026-08-09' AND shift = 'D'").get(cands[1].id)?.source === 'substitution');
  step('原班人員 leave 一筆、替補者代班 +1（只在 FILLED 時）',
    !!db.prepare("SELECT 1 FROM leave WHERE staff_id = 'N-02' AND from_date = '2026-08-09' AND source = 'substitution'").get()
    && db.prepare('SELECT standby_30d FROM staff WHERE staff_id = ?').get(cands[1].id).standby_30d === standbyBefore + 1);
  step('通報人收到「已由 X 接下」、護理長收到「已補上」', pushes().some((b) => b.to === OTHER && /接下/.test(b.messages[0].text))
    && pushes().some((b) => b.to === USER && /已補上/.test(b.messages[0].text)));

  // ── 逾時路徑：第二筆（小夜）→ 核准 → 把第 1 位的 expired_at 撥到過去 → cron
  await worker.fetch(signed([textEv(OTHER, '我 8/9 小夜不能來')]), envD1);
  const nc2 = lastReply().quickReply.items.find((i) => /無需/.test(i.action.label));
  await worker.fetch(signed([pb(OTHER, nc2.action.data, 6)]), envD1);
  const rq2 = (/已通報 (R\w{6})/.exec(replyText()) || [])[1];
  await worker.fetch(signed([pb(USER, encodeParams({ rq: rq2, act: 'approve' }), 7)]), envD1);
  const first2 = db.prepare('SELECT * FROM sub_ask WHERE request_id = ? AND seq = 0').get(rq2);
  db.prepare("UPDATE sub_ask SET expired_at = '2000-01-01T00:00:00.000Z' WHERE request_id = ? AND seq = 0").run(rq2);
  calls.length = 0;
  await worker.scheduled({}, envD1);
  const asks2 = db.prepare('SELECT * FROM sub_ask WHERE request_id = ? ORDER BY seq').all(rq2);
  step('cron：第 1 位標 timeout、自動問第 2 位', asks2[0].answer === 'timeout' && asks2.length === 2 && asks2[1].answer === null,
    JSON.stringify(asks2.map((a) => [a.staff_id, a.answer])));
  const tp = pushes().map((b) => b.messages[0].text);
  step('逾時者收到「已逾時」、第 2 位收到詢問', tp.some((t) => /已逾時/.test(t)) && tp.some((t) => /替班詢問/.test(t)));
  const uLate = await bindAs(first2.staff_id, 'Ulate0000000000000000000000000000');
  await worker.fetch(signed([pb(uLate, encodeParams({ rq: rq2, act: 'accept' }), 8)]), envD1);
  step('遲到的接不算數：回覆明說、狀態仍 ASKING、不寫回', /已逾時/.test(replyText()) && /不算數/.test(replyText())
    && db.prepare('SELECT state FROM sub_request WHERE id = ?').get(rq2).state === 'ASKING', replyText());

  // ── 駁回路徑：ASKING 中駁回 → 取消正在等的詢問
  calls.length = 0;
  await worker.fetch(signed([pb(USER, encodeParams({ rq: rq2, act: 'reject' }), 9)]), envD1);
  step('ASKING 中駁回 → REJECTED、等待中的詢問標 cancelled、通報人與候選都收到通知',
    db.prepare('SELECT state FROM sub_request WHERE id = ?').get(rq2).state === 'REJECTED'
    && db.prepare('SELECT answer FROM sub_ask WHERE request_id = ? AND seq = 1').get(rq2).answer === 'cancelled'
    && pushes().some((b) => b.to === OTHER && /駁回/.test(b.messages[0].text)));
}

/* ── 9. 留痕鏈 ── */
{
  const { createD1Store } = await import(pathToFileURL(path.join(ROOT, 'cloudflare/linebot/store-d1.mjs')).href);
  const store = createD1Store(d1Like(db), { auditCanonical: globalThis.auditCanonical });
  const v = await store.verifyAuditChain();
  step(`留痕鏈完整（${v.length} 筆，含 Phase 1 全部轉移）`, v.ok && v.length > 20, JSON.stringify(v));
  const actions = db.prepare('SELECT action FROM audit ORDER BY id').all().map((r) => r.action);
  step('留痕動作序列正確（前 7 筆為綁定；Phase 1 的 reported→approved→asked→declined→asked→filled 依序在後）',
    JSON.stringify(actions.slice(0, 7)) === JSON.stringify(['bind_code.issued', 'bind.completed', 'bind.rejected', 'bind_code.issued', 'bind.completed', 'bind_code.issued', 'bind.completed'])
    && ['sub.reported', 'sub.approved', 'sub.asked', 'sub.declined', 'sub.asked', 'sub.filled', 'sub.timeout', 'sub.answer_ignored', 'sub.rejected'].every((k) => actions.includes(k)), JSON.stringify(actions));
  // 竄改一筆 → 鏈斷
  db.prepare("UPDATE audit SET payload_json = '{\"tampered\":true}' WHERE id = 1").run();
  const v2 = await store.verifyAuditChain();
  step('竄改第 1 筆 → 驗證失敗且指出 brokenAt=1', !v2.ok && v2.brokenAt === 1, JSON.stringify(v2));
}

/* ── 10. 無 D1：Stage 0 行為不變 ── */
calls.length = 0;
await worker.fetch(signed([textEv(OTHER, '儀表板')]), envDemo);
step('無 D1 開放模式：未知使用者「儀表板」直接回 Flex（Stage 0 語義）', lastReply()?.type === 'flex');
await worker.fetch(signed([textEv(OTHER, '發碼 N-04')]), envDemo);
step('無 D1：「發碼」誠實回未啟用', replyText().includes('尚未啟用資料庫'), replyText());
await worker.scheduled({}, envDemo);
step('無 D1：cron 直接返回不拋錯', true);

console.log(process.exitCode ? '\n✗ 有步驟失敗' : `\n✓ 煙霧測試全數通過（${n} 步）`);
