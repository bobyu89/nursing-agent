-- schema.sql — 班守 LINE bot Stage 1 資料表（Cloudflare D1 / SQLite）
--
-- 對應 docs/LINEBOT-STAGE1.md §5。建立方式見 README.md「D1 設定」。
-- 原則：D1 只存代號（staff_id），永不存姓名；事由只存類別，不存自由文字。
-- 所有 CREATE 皆 IF NOT EXISTS——重跑不會清資料；要重置請自行 DROP。

-- ── 身分 ────────────────────────────────────────────────
-- line_user_id 需存原值（推播要用）；留痕裡只放雜湊。
CREATE TABLE IF NOT EXISTS identity (
  line_user_id TEXT PRIMARY KEY,
  staff_id     TEXT NOT NULL UNIQUE,
  unit         TEXT NOT NULL,
  role         TEXT NOT NULL,             -- 職級（引擎判資格用）：護佐 | 護理師 | 資深護理師
  tier         TEXT NOT NULL DEFAULT 'staff',  -- 權責層（bot 判權限用）：staff | head | exec，管理者發碼時授權
  bound_at     TEXT NOT NULL
);

-- 一次性綁定碼：管理者「發碼 N-04」產生，30 分鐘失效，用過即作廢。
CREATE TABLE IF NOT EXISTS bind_code (
  code       TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL,
  tier       TEXT NOT NULL DEFAULT 'staff',   -- 發碼時授權的權責層，綁定時原樣進 identity
  issued_by  TEXT NOT NULL,        -- 管理者 line_user_id 的雜湊
  issued_at  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

-- ── 人員與班表快照（Stage 1 由 tools/snapshot-to-sql.cjs 上傳）─────
-- 形狀與 src/data.js 的 STAFF / SHIFTS 一致，引擎不需改動。
CREATE TABLE IF NOT EXISTS staff (
  staff_id        TEXT PRIMARY KEY,
  role            TEXT NOT NULL,
  ladder          TEXT,
  unit            TEXT NOT NULL,
  certs_json      TEXT NOT NULL DEFAULT '{}',   -- {ACLS:'2027-05-31',...}
  willing_json    TEXT NOT NULL DEFAULT '[]',   -- ['D','E']
  familiar_json   TEXT NOT NULL DEFAULT '[]',   -- ['MED-3A']
  standby_30d     INTEGER NOT NULL DEFAULT 0,
  attrs_json      TEXT NOT NULL DEFAULT '{}',   -- 其餘欄位（note、母性保護等）原樣保留
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shift (
  staff_id   TEXT NOT NULL,
  date       TEXT NOT NULL,        -- YYYY-MM-DD
  shift      TEXT NOT NULL,        -- D | E | N
  unit       TEXT NOT NULL,
  source     TEXT NOT NULL,        -- imported | generated | substitution | manual
  written_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, date, shift)
);
CREATE INDEX IF NOT EXISTS shift_date_unit ON shift (date, unit);

CREATE TABLE IF NOT EXISTS leave (
  staff_id   TEXT NOT NULL,
  from_date  TEXT NOT NULL,
  to_date    TEXT NOT NULL,
  type       TEXT NOT NULL,        -- 預假 | 病假 | 事假 | 特休 | ...
  source     TEXT NOT NULL,        -- imported | prebook | substitution
  created_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, from_date, type)
);

-- ── 迴路 A：預班（Phase 2 使用，schema 先落）───────────────
CREATE TABLE IF NOT EXISTS prebook_cycle (
  id         TEXT PRIMARY KEY,     -- 例：MED-3A:2026-10
  unit       TEXT NOT NULL,
  month      TEXT NOT NULL,        -- YYYY-MM
  deadline   TEXT NOT NULL,
  max_days   INTEGER NOT NULL DEFAULT 4,
  state      TEXT NOT NULL,        -- OPEN | CLOSED | GENERATED | REVIEW | PUBLISHED
  opened_by  TEXT NOT NULL,
  opened_at  TEXT NOT NULL,
  closed_at  TEXT,
  draft_json     TEXT NOT NULL DEFAULT '[]',   -- 生成器排出的草稿 [{staffId,date,shift,unit}]；核准時寫入 shift（source:'generated'）
  uncovered_json TEXT NOT NULL DEFAULT '[]',   -- 排不出的格子連同阻擋規則 [{date,shift,unit,blockers:[{code,count}]}]——不硬塞
  generated_at   TEXT,
  published_at   TEXT,
  published_by   TEXT
);

CREATE TABLE IF NOT EXISTS prebook_request (
  cycle_id         TEXT NOT NULL,
  staff_id         TEXT NOT NULL,
  dates_json       TEXT NOT NULL DEFAULT '[]',
  state            TEXT NOT NULL,  -- PENDING | SUBMITTED | NO_REQUEST
  submitted_at     TEXT,
  reminded_count   INTEGER NOT NULL DEFAULT 0,
  last_reminded_at TEXT,
  PRIMARY KEY (cycle_id, staff_id)
);

-- ── 迴路 B：替班（Phase 1 使用，schema 先落）───────────────
CREATE TABLE IF NOT EXISTS sub_request (
  id                  TEXT PRIMARY KEY,
  unit                TEXT NOT NULL,
  date                TEXT NOT NULL,
  shift               TEXT NOT NULL,
  required_certs_json TEXT NOT NULL DEFAULT '[]',
  original_staff_id   TEXT,
  reason_type         TEXT,        -- 病假 | 事假 | 公假 | 其他（不存自由文字）
  reporter_staff_id   TEXT NOT NULL,
  state               TEXT NOT NULL,  -- REPORTED | APPROVED | ASKING | FILLED | EXHAUSTED | REJECTED | CANCELLED
  candidates_json     TEXT NOT NULL DEFAULT '[]',  -- 通報時引擎排出的候選序列 [{id,total,max,why}]；核准時凍結＝「為什麼是找你不找他」正本
  timeout_min         INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  approved_at         TEXT,
  approved_by         TEXT,
  filled_by           TEXT,
  closed_at           TEXT
);
CREATE INDEX IF NOT EXISTS sub_request_open ON sub_request (state, unit, date);

CREATE TABLE IF NOT EXISTS sub_ask (
  request_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  staff_id    TEXT NOT NULL,
  asked_at    TEXT NOT NULL,
  expired_at  TEXT NOT NULL,
  answered_at TEXT,
  answer      TEXT,                -- accept | decline | timeout | cancelled；NULL＝仍在等
  PRIMARY KEY (request_id, seq)
);
CREATE INDEX IF NOT EXISTS sub_ask_pending ON sub_ask (expired_at) WHERE answer IS NULL;

-- ── 留痕：append-only 雜湊鏈 ───────────────────────────────
-- hash = sha256(prev_hash | ts | actor | action | payload_json)
-- 平台端 chainValid 的伺服器版；改任何一筆，後續整條鏈驗證失敗。
CREATE TABLE IF NOT EXISTS audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  actor_staff_id TEXT,             -- 系統動作（cron）為 NULL
  action         TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL UNIQUE
);
