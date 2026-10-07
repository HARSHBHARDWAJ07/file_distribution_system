const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { shouldUseChunkedUpload, calculatePartCount, CHUNK_SIZE_BYTES } = require('../lib/chunking');
const { validateInitUpload } = require('@cloudstore/validation');
const { ok } = require('@cloudstore/shared-types');

async function initUpload(req, res) {
  const ownerId = req.userId; // set by requireInternal from the gateway's verified JWT
  const { filename, sizeBytes, contentType } = validateInitUpload(req.body);

  const storageKey = storage.buildKey(ownerId, filename);
  const chunked = shouldUseChunkedUpload(sizeBytes);

  const { rows } = await pool.query(
    `INSERT INTO files (owner_id, filename, size_bytes, storage_key, status, content_type)
     VALUES ($1, $2, $3, $4, 'uploading', $5) RETURNING id`,
    [ownerId, filename, sizeBytes, storageKey, contentType || null]
  );
  const fileId = rows[0].id;

  // The row exists before storage is asked for anything. If storage fails,
  // mark the row failed rather than leave a phantom "uploading" file.
  try {
    if (!chunked) {
      const uploadUrl = await storage.getPresignedUploadUrl(storageKey, contentType);
      return res.status(201).json(ok({ fileId, strategy: 'single', uploadUrl }));
    }
    const uploadId = await storage.createMultipartUpload(storageKey, contentType);
    await pool.query('UPDATE files SET upload_id = $1 WHERE id = $2', [uploadId, fileId]);
  } catch (err) {
    await pool.query(`UPDATE files SET status = 'failed' WHERE id = $1`, [fileId]);
    throw err;
  }

  const totalParts = calculatePartCount(sizeBytes);
  return res.status(201).json(ok({ fileId, strategy: 'chunked', totalParts, chunkSizeBytes: CHUNK_SIZE_BYTES }));
}

module.exports = { initUpload };
