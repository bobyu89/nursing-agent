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

/** 與 botcore.TIERS 同一份順序；store 只用來展開「minTierRank 以上」的層級清單 */
const TIER_RANK = { staff: 0, head: 1, exec: 2 };

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

    /* ── Phase 1：替班迴路（docs/LINEBOT-STAGE1.md §4）────────── */
    async listIdentities({ unit, minTierRank }) {
      const tiers = Object.entries(TIER_RANK).filter(([, r]) => r >= (minTierRank || 0)).map(([t]) => t);
      const marks = tiers.map(() => '?').join(',');
      const sql = `SELECT line_user_id, staff_id, unit, role, tier FROM identity WHERE tier IN (${marks})` + (unit ? ' AND unit = ?' : '') + ' ORDER BY staff_id';
      const { results } = await db.prepare(sql).bind(...tiers, ...(unit ? [unit] : [])).all();
      return results;
    },
    async findOpenSubRequest({ unit, date, shift, originalStaffId }) {
      return db.prepare("SELECT * FROM sub_request WHERE unit = ? AND date = ? AND shift = ? AND original_staff_id IS ? AND state IN ('REPORTED','APPROVED','ASKING') LIMIT 1")
        .bind(unit, date, shift, originalStaffId).first();
    },
    async createSubRequest(r) {
      await db.prepare(`INSERT INTO sub_request (id, unit, date, shift, required_certs_json, original_staff_id, reason_type,
          reporter_staff_id, state, candidates_json, timeout_min, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(r.id, r.unit, r.date, r.shift, r.required_certs_json, r.original_staff_id, r.reason_type,
          r.reporter_staff_id, r.state, r.candidates_json, r.timeout_min, r.created_at).run();
    },
    async getSubRequest(id) {
      return db.prepare('SELECT * FROM sub_request WHERE id = ?').bind(id).first();
    },
    async updateSubRequest(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return;
      await db.prepare(`UPDATE sub_request SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .bind(...keys.map((k) => patch[k]), id).run();
    },
    /** Phase 1.5：待核准清單（unit 為 null＝全院）；依建立時間 */
    async listSubRequests({ unit, state }) {
      const conds = []; const args = [];
      if (unit) { conds.push('unit = ?'); args.push(unit); }
      if (state) { conds.push('state = ?'); args.push(state); }
      const { results } = await db.prepare(`SELECT * FROM sub_request${conds.length ? ' WHERE ' + conds.join(' AND ') : ''} ORDER BY created_at`).bind(...args).all();
      return results;
    },
    /** Phase 1.5：正在等某人回覆、且未逾時的那一筆 */
    async findOpenAskFor(staffId, nowIso) {
      return db.prepare('SELECT * FROM sub_ask WHERE staff_id = ? AND answer IS NULL AND expired_at > ? ORDER BY asked_at DESC LIMIT 1')
        .bind(staffId, nowIso).first();
    },
    async listAsks(requestId) {
      const { results } = await db.prepare('SELECT * FROM sub_ask WHERE request_id = ? ORDER BY seq').bind(requestId).all();
      return results;
    },
    async insertAsk({ requestId, seq, staffId, askedAt, expiredAt }) {
      await db.prepare('INSERT INTO sub_ask (request_id, seq, staff_id, asked_at, expired_at) VALUES (?,?,?,?,?)')
        .bind(requestId, seq, staffId, askedAt, expiredAt).run();
    },
    /** 原子：只有「仍在等」且問的就是這個人的那筆才會被寫入 */
    async answerAsk({ requestId, staffId, answer, answeredAt }) {
      return db.prepare('UPDATE sub_ask SET answer = ?, answered_at = ? WHERE request_id = ? AND staff_id = ? AND answer IS NULL RETURNING request_id, seq, staff_id, answer')
        .bind(answer, answeredAt, requestId, staffId).first();
    },
    async cancelOpenAsk(requestId, nowIso) {
      return db.prepare("UPDATE sub_ask SET answer = 'cancelled', answered_at = ? WHERE request_id = ? AND answer IS NULL RETURNING request_id, seq, staff_id")
        .bind(nowIso, requestId).first();
    },
    /** 原子：仍在等且已逾時者全部標 timeout；回傳被標的那些（cron 據此逐筆推進） */
    async expireDueAsks(nowIso) {
      const { results } = await db.prepare("UPDATE sub_ask SET answer = 'timeout', answered_at = ? WHERE answer IS NULL AND expired_at < ? RETURNING request_id, seq, staff_id")
        .bind(nowIso, nowIso).all();
      return results;
    },
    /** FILLED 寫回：原班移除＋替補新增（同一批次）、原人請假、替補者代班 +1（§4.2 只在此處 +1） */
    async applySubstitution({ date, shift, unit, originalStaffId, substituteStaffId, reasonType, now }) {
      const stmts = [
        db.prepare('INSERT OR REPLACE INTO shift (staff_id, date, shift, unit, source, written_at) VALUES (?,?,?,?,?,?)')
          .bind(substituteStaffId, date, shift, unit, 'substitution', now),
        db.prepare('UPDATE staff SET standby_30d = standby_30d + 1, updated_at = ? WHERE staff_id = ?').bind(now, substituteStaffId),
      ];
      if (originalStaffId) {
        stmts.unshift(db.prepare('DELETE FROM shift WHERE staff_id = ? AND date = ? AND shift = ?').bind(originalStaffId, date, shift));
        stmts.push(db.prepare('INSERT OR REPLACE INTO leave (staff_id, from_date, to_date, type, source, created_at) VALUES (?,?,?,?,?,?)')
          .bind(originalStaffId, date, date, reasonType || '缺班', 'substitution', now));
      }
      await db.batch(stmts);
    },

    /* ── 系統設定 key/value（圖文選單 id 等）──────────────── */
    async getSetting(key) {
      const r = await db.prepare('SELECT value FROM setting WHERE key = ?').bind(key).first();
      return r ? r.value : null;
    },
    async setSetting(key, value, nowIso) {
      await db.prepare('INSERT OR REPLACE INTO setting (key, value, updated_at) VALUES (?,?,?)').bind(key, value, nowIso).run();
    },
    async deleteSetting(key) {
      await db.prepare('DELETE FROM setting WHERE key = ?').bind(key).run();
    },
    /** 全部已綁定者（建選單後整批重掛用） */
    async listAllIdentities() {
      const { results } = await db.prepare('SELECT line_user_id, staff_id, unit, tier FROM identity').all();
      return results;
    },

    /* ── Phase 2：預班迴路（docs/LINEBOT-STAGE1.md §3）──────── */
    async createCycle(c) {
      await db.prepare('INSERT INTO prebook_cycle (id, unit, month, deadline, max_days, state, opened_by, opened_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(c.id, c.unit, c.month, c.deadline, c.max_days, c.state, c.opened_by, c.opened_at).run();
    },
    async getCycle(id) {
      return db.prepare('SELECT * FROM prebook_cycle WHERE id = ?').bind(id).first();
    },
    async updateCycle(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return;
      await db.prepare(`UPDATE prebook_cycle SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .bind(...keys.map((k) => patch[k]), id).run();
    },
    /** 該單位最近一個處於指定狀態的週期（依開啟時間倒序） */
    async findCycle({ unit, states }) {
      const marks = states.map(() => '?').join(',');
      return db.prepare(`SELECT * FROM prebook_cycle WHERE unit = ? AND state IN (${marks}) ORDER BY opened_at DESC LIMIT 1`)
        .bind(unit, ...states).first();
    },
    async listCycles({ states }) {
      const marks = states.map(() => '?').join(',');
      const { results } = await db.prepare(`SELECT * FROM prebook_cycle WHERE state IN (${marks}) ORDER BY deadline`).bind(...states).all();
      return results;
    },
    /** 開啟時為全單位建 PENDING；已存在者不動（INSERT OR IGNORE） */
    async upsertPrebookRequests(cycleId, staffIds, nowIso) {
      if (!staffIds.length) return;
      await db.batch(staffIds.map((sid) =>
        db.prepare("INSERT OR IGNORE INTO prebook_request (cycle_id, staff_id, dates_json, state) VALUES (?,?,'[]','PENDING')").bind(cycleId, sid)));
    },
    async getPrebookRequest(cycleId, staffId) {
      return db.prepare('SELECT * FROM prebook_request WHERE cycle_id = ? AND staff_id = ?').bind(cycleId, staffId).first();
    },
    async updatePrebookRequest(cycleId, staffId, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return;
      await db.prepare(`UPDATE prebook_request SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE cycle_id = ? AND staff_id = ?`)
        .bind(...keys.map((k) => patch[k]), cycleId, staffId).run();
    },
    async listPrebookRequests(cycleId, state) {
      const { results } = await (state
        ? db.prepare('SELECT * FROM prebook_request WHERE cycle_id = ? AND state = ? ORDER BY staff_id').bind(cycleId, state)
        : db.prepare('SELECT * FROM prebook_request WHERE cycle_id = ? ORDER BY staff_id').bind(cycleId)).all();
      return results;
    },
    /** 截止時預假入 leave（type:'預假'、source:'prebook'）；同人同日同類型重送即覆蓋 */
    async insertLeaves(rows) {
      if (!rows.length) return;
      await db.batch(rows.map((l) =>
        db.prepare('INSERT OR REPLACE INTO leave (staff_id, from_date, to_date, type, source, created_at) VALUES (?,?,?,?,?,?)')
          .bind(l.staffId, l.from, l.to, l.type, l.source, l.createdAt)));
    },
    /** 公告時草稿入正式班表（source:'generated'） */
    async insertShifts(rows) {
      if (!rows.length) return;
      await db.batch(rows.map((s) =>
        db.prepare('INSERT OR REPLACE INTO shift (staff_id, date, shift, unit, source, written_at) VALUES (?,?,?,?,?,?)')
          .bind(s.staffId, s.date, s.shift, s.unit, s.source, s.writtenAt)));
    },

    /* ── Phase 3d：平台編輯寫回（差異由 botcore.diffShifts 算，這裡只批次寫）── */
    async listShifts(unit) {
      const { results } = await (unit
        ? db.prepare('SELECT staff_id, date, shift, unit, source, written_at FROM shift WHERE unit = ? ORDER BY date, staff_id, shift').bind(unit)
        : db.prepare('SELECT staff_id, date, shift, unit, source, written_at FROM shift ORDER BY date, staff_id, shift')).all();
      return results.map((r) => ({ staffId: r.staff_id, date: r.date, shift: r.shift, unit: r.unit, source: r.source, writtenAt: r.written_at }));
    },
    async replaceShifts({ deletes, inserts, now }) {
      const stmts = [
        ...deletes.map((d) => db.prepare('DELETE FROM shift WHERE staff_id = ? AND date = ? AND shift = ?').bind(d.staffId, d.date, d.shift)),
        ...inserts.map((s) => db.prepare('INSERT OR REPLACE INTO shift (staff_id, date, shift, unit, source, written_at) VALUES (?,?,?,?,?,?)')
          .bind(s.staffId, s.date, s.shift, s.unit, s.source, now)),
      ];
      if (stmts.length) await db.batch(stmts);
    },

    /* ── 人員與班表快照 → 引擎用的 db 形狀（與 data.js 相同）──── */
    async loadDb() {
      const [staffRes, shiftRes, leaveRes] = await db.batch([
        db.prepare('SELECT * FROM staff ORDER BY staff_id'),
        db.prepare('SELECT staff_id, date, shift, unit, source FROM shift ORDER BY date, staff_id'),
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
      const shifts = shiftRes.results.map((r) => ({ staffId: r.staff_id, date: r.date, shift: r.shift, unit: r.unit, source: r.source }));
      return { staff, shifts, empty: staff.length === 0 };
    },
  };
}
