-- 0003-prebook-draft.sql — 預班週期補草稿與公告欄位（docs/LINEBOT-STAGE1.md §3）
-- 新建的庫直接跑 schema.sql 即含此欄。已建庫者：
--   npx wrangler d1 execute shiftguard --remote --file=migrations/0003-prebook-draft.sql
ALTER TABLE prebook_cycle ADD COLUMN draft_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE prebook_cycle ADD COLUMN uncovered_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE prebook_cycle ADD COLUMN generated_at TEXT;
ALTER TABLE prebook_cycle ADD COLUMN published_at TEXT;
ALTER TABLE prebook_cycle ADD COLUMN published_by TEXT;
