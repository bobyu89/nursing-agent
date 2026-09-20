-- 0004-setting.sql — 系統設定表（圖文選單 id 由 Worker「建立選單」寫入）
-- 新建的庫直接跑 schema.sql 即含此表。已建庫者：
--   npx wrangler d1 execute shiftguard --remote --file=migrations/0004-setting.sql
CREATE TABLE IF NOT EXISTS setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
