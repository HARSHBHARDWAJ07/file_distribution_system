CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes BIGINT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending -> uploading -> complete -> failed
  upload_id TEXT,                          -- S3 multipart id, null for single-shot
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  thumbnail_key TEXT,                      -- set by the worker once a thumbnail exists
  thumbnail_error TEXT,                    -- set by the worker if the image cannot be decoded
  replicated_at TIMESTAMPTZ                -- set by the worker once the replica copy exists
);

CREATE INDEX IF NOT EXISTS idx_files_owner ON files (owner_id);

-- Tracks which parts of a chunked upload have landed, so a client can
-- resume after a dropped connection instead of restarting from zero.
CREATE TABLE IF NOT EXISTS upload_parts (
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  part_number INT NOT NULL,
  etag TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, part_number)
);
