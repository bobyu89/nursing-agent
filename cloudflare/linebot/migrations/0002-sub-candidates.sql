-- 0002-sub-candidates.sql — 替班請求補候選序列欄位（docs/LINEBOT-STAGE1.md §4）
-- 新建的庫直接跑 schema.sql 即含此欄。已建庫者：
--   npx wrangler d1 execute shiftguard --remote --file=migrations/0002-sub-candidates.sql
ALTER TABLE sub_request ADD COLUMN candidates_json TEXT NOT NULL DEFAULT '[]';
