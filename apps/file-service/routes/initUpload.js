const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { shouldUseChunkedUpload, calculatePartCount, CHUNK_SIZE_BYTES } = require('../lib/chunking');
const { initUploadBody } = require('../lib/schemas');
const { ok, validate } = require('@cloudstore/shared-types');

async function initUpload(req, res) {
  const ownerId = req.userId; // set by requireInternal from the gateway's verified JWT
  const { data: body, error } = validate(initUploadBody, req.body);
  if (error) return res.status(400).json(error);
  const { filename, sizeBytes, contentType } = body;

  const storageKey = storage.buildKey(ownerId, filename);
  const chunked = shouldUseChunkedUpload(sizeBytes);

  const { rows } = await pool.query(
    `INSERT INTO files (owner_id, filename, size_bytes, storage_key, status, content_type)
     VALUES ($1, $2, $3, $4, 'uploading', $5) RETURNING id`,
    [ownerId, filename, sizeBytes, storageKey, contentType || null]
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
