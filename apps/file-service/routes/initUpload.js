const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { shouldUseChunkedUpload, calculatePartCount, CHUNK_SIZE_BYTES } = require('../lib/chunking');
const { ok, fail } = require('@cloudstore/shared-types');

async function initUpload(req, res) {
  const ownerId = req.headers['x-user-id']; // set by the Gateway after JWT verification
  const { filename, sizeBytes, contentType } = req.body;

  if (!filename || !sizeBytes || sizeBytes <= 0) {
    return res.status(400).json(fail('INVALID_INPUT', 'filename and a positive sizeBytes are required'));
  }

  const storageKey = storage.buildKey(ownerId, filename);
  const chunked = shouldUseChunkedUpload(sizeBytes);

  const { rows } = await pool.query(
    `INSERT INTO files (owner_id, filename, size_bytes, storage_key, status)
     VALUES ($1, $2, $3, $4, 'uploading') RETURNING id`,
    [ownerId, filename, sizeBytes, storageKey]
  );
  const fileId = rows[0].id;

  if (!chunked) {
    const uploadUrl = await storage.getPresignedUploadUrl(storageKey, contentType);
    return res.status(201).json(ok({ fileId, strategy: 'single', uploadUrl }));
  }

  const uploadId = await storage.createMultipartUpload(storageKey, contentType);
  await pool.query('UPDATE files SET upload_id = $1 WHERE id = $2', [uploadId, fileId]);
  const totalParts = calculatePartCount(sizeBytes);
  return res.status(201).json(ok({ fileId, strategy: 'chunked', totalParts, chunkSizeBytes: CHUNK_SIZE_BYTES }));
}

module.exports = { initUpload };
