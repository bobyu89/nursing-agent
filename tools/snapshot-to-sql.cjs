/* snapshot-to-sql.cjs — 把人員與班表快照轉成 D1 可執行的 SQL（Stage 1 Phase 0）
 *
 * 來源二選一：
 *   （預設）src/data.js 的 STAFF／SHIFTS——示範資料，用來把 D1 開機、跑通綁定與儀表板
 *   --json <path>  由平台匯出的 { staff:[...], shifts:[...] } JSON（形狀與 data.js 相同）
 *
 * 輸出：純 SQL 到 stdout（或 --out <file>）。全量覆蓋語義：先 DELETE 三張表再 INSERT。
 * 不寫 BEGIN／COMMIT——D1 拒絕 SQL 交易語句，`d1 execute --file` 本身就把整批當原子批次執行；
 * 本機 sqlite 驗證時亦以 executescript 整批跑。快照就是快照，不做增量合併
 * （Stage 3 平台改讀 D1 即時資料後，本工具退場）。
 *
 * 用法：
 *   node tools/snapshot-to-sql.cjs --out cloudflare/linebot/snapshot.sql
 *   cd cloudflare/linebot && npx wrangler d1 execute shiftguard --remote --file=snapshot.sql
 *
 * 原則：只寫代號，不寫姓名。STAFF 裡的 note 等描述欄位原樣進 attrs_json（示範資料本來就無姓名）；
 * 正式導入時匯出端請自行剔除任何可識別個人之欄位。
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

let staff, shifts;
const jsonPath = opt('--json');
if (jsonPath) {
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  staff = j.staff; shifts = j.shifts;
} else {
  const d = require(path.join(__dirname, '..', 'src', 'data.js'));
  staff = d.STAFF; shifts = d.SHIFTS;
}
if (!Array.isArray(staff) || !Array.isArray(shifts)) throw new Error('需要 staff[] 與 shifts[]');

/** SQL 字串字面值：單引號翻倍；null/undefined → NULL */
function q(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
const J = (v) => q(JSON.stringify(v === undefined ? null : v));

const STD = new Set(['id', 'role', 'ladder', 'unit', 'certs', 'willingShifts', 'familiarUnits', 'standbyCount30d', 'leaves']);
const now = new Date().toISOString();
const out = [];

out.push('-- snapshot.sql — 由 tools/snapshot-to-sql.cjs 產生於 ' + now);
out.push('-- 全量覆蓋：staff / shift / leave 三張表');
out.push('DELETE FROM leave; DELETE FROM shift; DELETE FROM staff;');

for (const s of staff) {
  const attrs = {};
  Object.keys(s).forEach((k) => { if (!STD.has(k)) attrs[k] = s[k]; });
  out.push(
    'INSERT INTO staff (staff_id, role, ladder, unit, certs_json, willing_json, familiar_json, standby_30d, attrs_json, updated_at) VALUES (' +
    [q(s.id), q(s.role), q(s.ladder || null), q(s.unit), J(s.certs || {}), J(s.willingShifts || []),
      J(s.familiarUnits || []), String(Number(s.standbyCount30d) || 0), J(attrs), q(now)].join(', ') + ');'
  );
  for (const l of (s.leaves || [])) {
    out.push(
      'INSERT INTO leave (staff_id, from_date, to_date, type, source, created_at) VALUES (' +
      [q(s.id), q(l.from), q(l.to), q(l.type || '假'), q('imported'), q(now)].join(', ') + ');'
    );
  }
}

for (const r of shifts) {
  out.push(
    'INSERT OR REPLACE INTO shift (staff_id, date, shift, unit, source, written_at) VALUES (' +
    [q(r.staffId), q(r.date), q(r.shift), q(r.unit), q('imported'), q(now)].join(', ') + ');'
  );
}

const sql = out.join('\n') + '\n';
const outPath = opt('--out');
if (outPath) {
  fs.writeFileSync(outPath, sql, 'utf8');
  console.error(`寫入 ${outPath}：staff ${staff.length}、shift ${shifts.length}、leave ${staff.reduce((n, s) => n + (s.leaves || []).length, 0)}`);
} else {
  process.stdout.write(sql);
}

module.exports = { q, J };
