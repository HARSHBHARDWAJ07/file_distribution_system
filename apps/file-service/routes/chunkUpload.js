const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { getFileById } = require('../lib/files');
const { calculatePartCount, remainingParts } = require('../lib/chunking');
const { ok, fail } = require('@cloudstore/shared-types');

async function getPartUploadUrl(req, res) {
  const ownerId = req.headers['x-user-id'];
  const { fileId, partNumber } = req.params;

  const file = await getFileById(fileId);
  if (!file) {
    return res.status(404).json(fail('FILE_NOT_FOUND', 'no file with that id'));
  }
  if (file.owner_id !== ownerId) {
    return res.status(403).json(fail('FORBIDDEN', 'you do not have access to this file'));
  }
  if (!file.upload_id) {
    return res.status(400).json(fail('NOT_CHUNKED_UPLOAD', 'this file was not initiated as a chunked upload'));
  }

  const url = await storage.getPresignedPartUploadUrl(file.storage_key, file.upload_id, Number(partNumber));
  return res.json(ok({ partNumber: Number(partNumber), uploadUrl: url }));
}

async function recordPartUploaded(req, res) {
  const ownerId = req.headers['x-user-id'];
  const { fileId, partNumber } = req.params;
  const { etag } = req.body || {};

  if (!etag) {
    return res.status(400).json(fail('INVALID_INPUT', 'etag is required'));
  }

  const file = await getFileById(fileId);
  if (!file) {
    return res.status(404).json(fail('FILE_NOT_FOUND', 'no file with that id'));
  }
  if (file.owner_id !== ownerId) {
    return res.status(403).json(fail('FORBIDDEN', 'you do not have access to this file'));
  }

  await pool.query(
    `INSERT INTO upload_parts (file_id, part_number, etag) VALUES ($1, $2, $3)
     ON CONFLICT (file_id, part_number) DO UPDATE SET etag = EXCLUDED.etag`,
    [fileId, Number(partNumber), etag]
  );
  return res.json(ok({ recorded: true }));
}

async function getUploadStatus(req, res) {
  const ownerId = req.headers['x-user-id'];
  const { fileId } = req.params;

  const file = await getFileById(fileId);
  if (!file) {
    return res.status(404).json(fail('FILE_NOT_FOUND', 'no file with that id'));
  }
  if (file.owner_id !== ownerId) {
    return res.status(403).json(fail('FORBIDDEN', 'you do not have access to this file'));
  }

  const { rows } = await pool.query(
    'SELECT part_number FROM upload_parts WHERE file_id = $1 ORDER BY part_number',
    [fileId]
  );
  const uploadedPartNumbers = rows.map(r => r.part_number);
  const totalParts = calculatePartCount(file.size_bytes);

  return res.json(ok({
    status: file.status,
    totalParts,
    uploadedPartNumbers,
    remainingPartNumbers: remainingParts(totalParts, uploadedPartNumbers),
  }));
}

module.exports = { getPartUploadUrl, recordPartUploaded, getUploadStatus };
