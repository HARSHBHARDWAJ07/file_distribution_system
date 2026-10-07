-- Phase 4: an image the worker cannot decode is a permanent condition, not a
-- transient failure. Recording it stops every redelivery from retrying the
-- thumbnail, and lets replication proceed instead of being blocked behind it.
ALTER TABLE files ADD COLUMN IF NOT EXISTS thumbnail_error TEXT;
