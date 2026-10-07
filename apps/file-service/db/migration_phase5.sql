-- Phase 5: the dashboard lists a user's files newest first, a page at a time
-- with a keyset cursor (created_at, id). This index serves exactly that
-- ORDER BY, so every page is an index range scan, however deep.
CREATE INDEX IF NOT EXISTS idx_files_owner_created
  ON files (owner_id, created_at DESC, id DESC);
