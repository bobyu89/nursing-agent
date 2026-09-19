/**
 * store-d1.mjs — botcore 狀態介面的 Cloudflare D1 實作（Stage 1 地基）
 *
 * 介面規格在 src/botcore.js「Stage 1 地基」段落。本檔只做兩件事：
 * SQL 與雜湊。決定與訊息一律在 botcore，宿主與本檔不含任何業務判斷。
 *
 * 留痕鏈：hash = sha256(auditCanonical({prevHash, ts, actor, action, payloadJson}))
 * 已知取捨：同一毫秒兩筆並發 append 可能讀到同一 prev_hash（鏈分叉）。
 * Stage 1 流量下機率極低，verifyAuditChain 會誠實回報分叉點；Stage 2 改 Durable Object 序列化。
 *
 * D1 只存代號，永不存姓名；line_user_id 原值只在 identity（推播要用），留痕一律雜湊。
 */
import crypto from 'node:crypto';

export function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** line_user_id → 留痕用雜湊（前 16 hex 夠辨識、不可逆） */
export function userHash(lineUserId) {
  return sha256Hex('line:' + lineUserId).slice(0, 16);
}

export function createD1Store(db, { auditCanonical }) {
  if (typeof auditCanonical !== 'function') throw new Error('createD1Store 需要 botcore.auditCanonical');

  return {
    /* ── 身分 ─────────────────────────────────────── */
    async getIdentityByUser(lineUserId) {
      return db.prepare('SELECT line_user_id, staff_id, unit, role, tier, bound_at FROM identity WHERE line_user_id = ?')
        .bind(lineUserId).first();
    },
    async getIdentityByStaff(staffId) {
      return db.prepare('SELECT line_user_id, staff_id, unit, role, tier, bound_at FROM identity WHERE staff_id = ?')
        .bind(staffId).first();
    },
    async bindIdentity({ lineUserId, staffId, unit, role, tier, boundAt }) {
      const prev = await this.getIdentityByStaff(staffId);
      const replacedLineUserId = prev && prev.line_user_id !== lineUserId ? prev.line_user_id : null;
      await db.batch([
        db.prepare('DELETE FROM identity WHERE staff_id = ? OR line_user_id = ?').bind(staffId, lineUserId),
        db.prepare('INSERT INTO identity (line_user_id, staff_id, unit, role, tier, bound_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(lineUserId, staffId, unit, role, tier || 'staff', boundAt),
      ]);
      return { replacedLineUserId };
    },

    /* ── 綁定碼 ───────────────────────────────────── */
    async issueBindCode({ code, staffId, tier, issuedBy, issuedAt, expiresAt }) {
      await db.prepare('INSERT INTO bind_code (code, staff_id, tier, issued_by, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(code, staffId, tier || 'staff', issuedBy, issuedAt, expiresAt).run();
    },
    /** 原子消耗：只有 used_at 仍為 NULL 的那一筆會被標記並回傳；否則 null */
    async consumeBindCode(code, nowIso) {
      return db.prepare('UPDATE bind_code SET used_at = ? WHERE code = ? AND used_at IS NULL RETURNING staff_id, tier, expires_at, used_at')
        .bind(nowIso, code).first();
    },
    async purgeExpiredBindCodes(nowIso) {
      const r = await db.prepare('DELETE FROM bind_code WHERE expires_at < ? OR used_at IS NOT NULL').bind(nowIso).run();
      return (r.meta && r.meta.changes) || 0;
    },

    /* ── 留痕鏈 ───────────────────────────────────── */
    async appendAudit({ ts, actor, action, payload }) {
      const last = await db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').first();
      const prevHash = last ? last.hash : '';
      const payloadJson = JSON.stringify(payload || {});
      const hash = sha256Hex(auditCanonical({ prevHash, ts, actor, action, payloadJson }));
      await db.prepare('INSERT INTO audit (ts, actor_staff_id, action, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(ts, actor === undefined ? null : actor, action, payloadJson, prevHash, hash).run();
      return hash;
    },
    /** 從頭重算整條鏈；回 { ok, length, brokenAt }（brokenAt 為第一筆對不上的 id） */
    async verifyAuditChain() {
      const { results } = await db.prepare('SELECT id, ts, actor_staff_id, action, payload_json, prev_hash, hash FROM audit ORDER BY id').all();
      let prev = '';
      for (const r of results) {
        const expect = sha256Hex(auditCanonical({ prevHash: prev, ts: r.ts, actor: r.actor_staff_id, action: r.action, payloadJson: r.payload_json }));
        if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, length: results.length, brokenAt: r.id };
        prev = r.hash;
      }
      return { ok: true, length: results.length, brokenAt: null };
    },

    /* ── 人員與班表快照 → 引擎用的 db 形狀（與 data.js 相同）──── */
    async loadDb() {
      const [staffRes, shiftRes, leaveRes] = await db.batch([
        db.prepare('SELECT * FROM staff ORDER BY staff_id'),
        db.prepare('SELECT staff_id, date, shift, unit FROM shift ORDER BY date, staff_id'),
        db.prepare('SELECT staff_id, from_date, to_date, type FROM leave ORDER BY staff_id, from_date'),
      ]);
      const leavesBy = {};
      for (const l of leaveRes.results) {
        (leavesBy[l.staff_id] = leavesBy[l.staff_id] || []).push({ from: l.from_date, to: l.to_date, type: l.type });
      }
      const staff = staffRes.results.map((r) => ({
        ...JSON.parse(r.attrs_json || '{}'),
        id: r.staff_id, role: r.role, ladder: r.ladder || undefined, unit: r.unit,
        certs: JSON.parse(r.certs_json || '{}'),
        willingShifts: JSON.parse(r.willing_json || '[]'),
        familiarUnits: JSON.parse(r.familiar_json || '[]'),
        standbyCount30d: r.standby_30d || 0,
        leaves: leavesBy[r.staff_id] || [],
      }));
      const shifts = shiftRes.results.map((r) => ({ staffId: r.staff_id, date: r.date, shift: r.shift, unit: r.unit }));
      return { staff, shifts, empty: staff.length === 0 };
    },
  };
}
