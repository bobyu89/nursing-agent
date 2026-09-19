-- 0001-tier.sql — 既有 D1 補上權責層欄位（docs/LINEBOT-STAGE1.md §2.5）
-- 新建的庫直接跑 schema.sql 即含此欄，不需本檔。已建庫者跑：
--   npx wrangler d1 execute shiftguard --remote --file=migrations/0001-tier.sql
-- SQLite 的 ADD COLUMN 不支援 IF NOT EXISTS；重跑會報 duplicate column，屬預期。
ALTER TABLE identity  ADD COLUMN tier TEXT NOT NULL DEFAULT 'staff';
ALTER TABLE bind_code ADD COLUMN tier TEXT NOT NULL DEFAULT 'staff';
