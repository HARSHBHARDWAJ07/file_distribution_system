-- Phase 3: state the async worker reads and writes.
ALTER TABLE files ADD COLUMN IF NOT EXISTS content_type TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS thumbnail_key TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS replicated_at TIMESTAMPTZ;
