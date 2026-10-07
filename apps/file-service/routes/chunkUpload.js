const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { loadOwnedFile } = require('../lib/files');
const { calculatePartCount, remainingParts } = require('../lib/chunking');
const { partParams, recordPartBody } = require('../lib/schemas');
const { ok, fail, validate } = require('@cloudstore/shared-types');

// Shared preconditions for the per-part routes: a chunked upload that is
// still in progress, and a part number that exists for its size.
async function loadPartTarget(req, res) {
  const loaded = await loadOwnedFile(req, res, partParams);
  if (!loaded) return null;
  const { file, params } = loaded;

  if (!file.upload_id) {
    res.status(400).json(fail('NOT_CHUNKED_UPLOAD', 'this file was not initiated as a chunked upload'));
    return null;
  }
  if (file.status !== 'uploading') {
    res.status(409).json(fail('UPLOAD_NOT_IN_PROGRESS', `upload is already ${file.status}`));
    return null;
  }
  const totalParts = calculatePartCount(file.size_bytes);
  if (params.partNumber > totalParts) {
    res.status(400).json(fail('INVALID_INPUT', `partNumber must be between 1 and ${totalParts}`));
    return null;
  }
  return { file, partNumber: params.partNumber };
}

async function getPartUploadUrl(req, res) {
  const target = await loadPartTarget(req, res);
  if (!target) return;
  const { file, partNumber } = target;

  const url = await storage.getPresignedPartUploadUrl(file.storage_key, file.upload_id, partNumber);
  return res.json(ok({ partNumber, uploadUrl: url }));
}

async function recordPartUploaded(req, res) {
  const { data: body, error } = validate(recordPartBody, req.body);
  if (error) return res.status(400).json(error);

  const target = await loadPartTarget(req, res);
  if (!target) return;

  await pool.query(
    `INSERT INTO upload_parts (file_id, part_number, etag) VALUES ($1, $2, $3)
     ON CONFLICT (file_id, part_number) DO UPDATE SET etag = EXCLUDED.etag`,
    [target.file.id, target.partNumber, body.etag]
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
  const loaded = await loadOwnedFile(req, res);
  if (!loaded) return;
  const { file } = loaded;

  const uploadedPartNumbers = (await getRecordedParts(file.id)).map(r => r.part_number);
  const totalParts = calculatePartCount(file.size_bytes);

  return res.json(ok({
    status: file.status,
    totalParts,
    uploadedPartNumbers,
    remainingPartNumbers: remainingParts(totalParts, uploadedPartNumbers),
  }));
}

module.exports = { getPartUploadUrl, recordPartUploaded, getUploadStatus, getRecordedParts };
