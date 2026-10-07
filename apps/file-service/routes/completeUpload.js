const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { loadOwnedFile, getFileById } = require('../lib/files');
const { calculatePartCount, remainingParts } = require('../lib/chunking');
const { completeBody } = require('../lib/schemas');
const { getRecordedParts } = require('./chunkUpload');
const { enqueueFileUploaded } = require('@cloudstore/queue');
const { ok, fail, validate } = require('@cloudstore/shared-types');

function enqueue(file) {
  return enqueueFileUploaded({ fileId: file.id, storageKey: file.storage_key, contentType: file.content_type });
}

function alreadyCompleted(res, fileId) {
  return res.json(ok({ fileId, status: 'complete', alreadyCompleted: true }));
}

// Single-shot: the client PUT straight to storage, so only storage knows
// whether it landed. Trusting the client here would mark a file complete
// that has no object behind it.
async function verifySingleUpload(file, res) {
  const size = await storage.getObjectSize(file.storage_key);
  if (size === null) {
    res.status(409).json(fail('UPLOAD_INCOMPLETE', 'the file has not been uploaded to storage yet'));
    return false;
  }
  if (Number(size) !== Number(file.size_bytes)) {
    res.status(409).json(fail('SIZE_MISMATCH', `uploaded ${size} bytes but declared ${file.size_bytes}`));
    return false;
  }
  return true;
}

// Chunked: complete with the client's part list if it sent one, else with the
// parts recorded via recordPartUploaded. Either way every part must be there.
async function completeChunkedUpload(file, bodyParts, res) {
  const parts = bodyParts && bodyParts.length
    ? bodyParts
    : (await getRecordedParts(file.id)).map(p => ({ PartNumber: p.part_number, ETag: p.etag }));

  const totalParts = calculatePartCount(file.size_bytes);
  const partNumbers = parts.map(p => p.PartNumber);
  const missing = remainingParts(totalParts, partNumbers);
  if (missing.length || new Set(partNumbers).size !== parts.length || parts.length !== totalParts) {
    res.status(409).json(fail('UPLOAD_INCOMPLETE',
      missing.length ? `parts still missing: ${missing.join(', ')}` : `expected exactly parts 1..${totalParts}`));
    return 'stop';
  }

  const sorted = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
  try {
    await storage.completeMultipartUpload(file.storage_key, file.upload_id, sorted);
  } catch (err) {
    // A concurrent complete call got there first and consumed the upload id.
    if (err.name === 'NoSuchUpload') {
      const current = await getFileById(file.id);
      if (current?.status === 'complete') return 'already';
    }
    if (err.name === 'InvalidPart' || err.name === 'InvalidPartOrder') {
      res.status(400).json(fail('INVALID_PARTS', 'one or more part ETags do not match what was uploaded'));
      return 'stop';
    }
    throw err;
  }
  return 'done';
}

async function completeUpload(req, res) {
  const { data: body, error } = validate(completeBody, req.body ?? {});
  if (error) return res.status(400).json(error);

  const loaded = await loadOwnedFile(req, res);
  if (!loaded) return;
  const { file } = loaded;

  if (file.status === 'complete') { // idempotent: a client retry is not an error
    // Re-enqueue in case the first attempt flipped status but crashed before
    // enqueueing. singletonKey dedupes a still-queued job, and the worker's
    // planWork turns an already-processed file into a no-op.
    await enqueue(file);
    return alreadyCompleted(res, file.id);
  }
  if (file.status !== 'uploading') {
    return res.status(409).json(fail('UPLOAD_NOT_IN_PROGRESS', `upload is ${file.status}`));
  }

  if (file.upload_id) {
    const outcome = await completeChunkedUpload(file, body.parts, res);
    if (outcome === 'stop') return;
    if (outcome === 'already') return alreadyCompleted(res, file.id);
  } else if (!(await verifySingleUpload(file, res))) {
    return;
  }

  // Conditional flip: of two racing complete calls, only one changes the row.
  const { rowCount } = await pool.query(
    `UPDATE files SET status = 'complete', completed_at = now() WHERE id = $1 AND status = 'uploading'`,
    [file.id]
  );
  // Post-processing (thumbnail, replication) happens in apps/worker; this is
  // just one row written to pg-boss's job table, so the response stays fast.
  await enqueue(file);
  if (rowCount === 0) return alreadyCompleted(res, file.id);
  return res.json(ok({ fileId: file.id, status: 'complete' }));
}

module.exports = { completeUpload };
