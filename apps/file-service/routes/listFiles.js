const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { validateListQuery, encodeCursor } = require('@cloudstore/validation');
const { ok } = require('@cloudstore/shared-types');

// The dashboard list: the caller's files, newest first, one keyset page at a
// time. Aborted uploads ('failed') are hidden; unfinished ones are included
// so the UI can offer to resume them.
async function listFiles(req, res) {
  const { limit, cursor } = validateListQuery(req.query);

  const params = [req.userId, limit + 1]; // one extra row says whether there's a next page
  let after = '';
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    after = 'AND (created_at, id) < ($3::timestamptz, $4::uuid)';
  }
  const { rows } = await pool.query(
    `SELECT id, filename, size_bytes, content_type, status, upload_id, thumbnail_key,
            replicated_at, created_at, completed_at, created_at::text AS cursor_ts
       FROM files
      WHERE owner_id = $1 AND status <> 'failed' ${after}
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    params
  );

  const page = rows.slice(0, limit);
  const items = await Promise.all(page.map(async f => ({
    id: f.id,
    filename: f.filename,
    sizeBytes: Number(f.size_bytes),
    contentType: f.content_type,
    status: f.status,
    strategy: f.upload_id ? 'chunked' : 'single',
    createdAt: f.created_at,
    completedAt: f.completed_at,
    replicated: Boolean(f.replicated_at),
    thumbnailUrl: f.thumbnail_key ? await storage.getPresignedThumbnailUrl(f.thumbnail_key) : null,
  })));
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit ? encodeCursor(last.cursor_ts, last.id) : null;

  return res.json(ok({ items, nextCursor }));
}

module.exports = { listFiles };
