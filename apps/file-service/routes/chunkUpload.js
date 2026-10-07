const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { loadOwnedFile } = require('../lib/files');
const { calculatePartCount, remainingParts } = require('../lib/chunking');
const { validatePartNumber, validateRecordPart } = require('@cloudstore/validation');
const { AppError } = require('@cloudstore/http-utils');
const { ok } = require('@cloudstore/shared-types');

// Shared preconditions for the per-part routes: the caller's chunked upload,
// still in progress, and a part number that exists for its size.
async function loadPartTarget(req) {
  const file = await loadOwnedFile(req.params.fileId, req.userId);
  if (!file.upload_id) {
    throw new AppError(400, 'NOT_CHUNKED_UPLOAD', 'this file was not initiated as a chunked upload');
  }
  if (file.status !== 'uploading') {
    throw new AppError(409, 'UPLOAD_NOT_IN_PROGRESS', `upload is already ${file.status}`);
  }
  const partNumber = validatePartNumber(req.params.partNumber, calculatePartCount(file.size_bytes));
  return { file, partNumber };
}

async function getPartUploadUrl(req, res) {
  const { file, partNumber } = await loadPartTarget(req);
  const url = await storage.getPresignedPartUploadUrl(file.storage_key, file.upload_id, partNumber);
  return res.json(ok({ partNumber, uploadUrl: url }));
}

async function recordPartUploaded(req, res) {
  const { etag } = validateRecordPart(req.body);
  const { file, partNumber } = await loadPartTarget(req);

  await pool.query(
    `INSERT INTO upload_parts (file_id, part_number, etag) VALUES ($1, $2, $3)
     ON CONFLICT (file_id, part_number) DO UPDATE SET etag = EXCLUDED.etag`,
    [file.id, partNumber, etag]
  );
  return res.json(ok({ recorded: true }));
}

async function getRecordedParts(fileId) {
  const { rows } = await pool.query(
    'SELECT part_number, etag FROM upload_parts WHERE file_id = $1 ORDER BY part_number',
    [fileId]
  );
  return rows;
}

async function getUploadStatus(req, res) {
  const file = await loadOwnedFile(req.params.fileId, req.userId);
  const uploadedPartNumbers = (await getRecordedParts(file.id)).map(r => r.part_number);
  const totalParts = calculatePartCount(file.size_bytes);

  return res.json(ok({
    status: file.status,
    totalParts,
    uploadedPartNumbers,
    remainingPartNumbers: remainingParts(totalParts, uploadedPartNumbers),
  }));
}

// Client gives up on an upload: free the stored parts and close the row.
async function abortUpload(req, res) {
  const file = await loadOwnedFile(req.params.fileId, req.userId);
  if (file.status !== 'uploading') {
    throw new AppError(409, 'UPLOAD_NOT_IN_PROGRESS', `upload is ${file.status}`);
  }
  if (file.upload_id) await storage.abortMultipartUpload(file.storage_key, file.upload_id);
  await pool.query(`UPDATE files SET status = 'failed' WHERE id = $1 AND status = 'uploading'`, [file.id]);
  return res.json(ok({ fileId: file.id, status: 'aborted' }));
}

module.exports = { getPartUploadUrl, recordPartUploaded, getUploadStatus, abortUpload, getRecordedParts };
