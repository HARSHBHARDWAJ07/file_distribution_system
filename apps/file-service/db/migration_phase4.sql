-- Phase 4: an image the worker cannot decode is a permanent condition, not a
-- transient failure. Recording it stops every redelivery from retrying the
-- thumbnail, and lets replication proceed instead of being blocked behind it.
ALTER TABLE files ADD COLUMN IF NOT EXISTS thumbnail_error TEXT;

-- Defence in depth: application validation can have bugs; a CHECK constraint
-- cannot be bypassed. Run BEFORE deploying the Phase 4 code, which writes the
-- new 'completing' status.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_status_check;
ALTER TABLE files ADD CONSTRAINT files_status_check
  CHECK (status IN ('pending', 'uploading', 'completing', 'complete', 'failed'));

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_size_positive;
ALTER TABLE files ADD CONSTRAINT files_size_positive CHECK (size_bytes > 0);

-- Powers the worker's reconciliation sweep: "complete, but never processed".
CREATE INDEX IF NOT EXISTS idx_files_unprocessed
  ON files (completed_at) WHERE status = 'complete' AND replicated_at IS NULL;
