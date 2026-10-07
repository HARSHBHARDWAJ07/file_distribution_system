const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { loadOwnedFile } = require('../lib/files');
const { calculatePartCount } = require('../lib/chunking');
const { getRecordedParts } = require('./chunkUpload');
const { enqueueFileUploaded } = require('@cloudstore/queue');
const { validateCompleteBody, validateCompleteParts } = require('@cloudstore/validation');
const { AppError } = require('@cloudstore/http-utils');
const { ok } = require('@cloudstore/shared-types');

// Failure policy: the file is already safely stored when this runs, so a queue
// hiccup must never fail the upload. The gap it leaves (stored, never
// processed) is closed by the worker's reconciliation sweep, and planWork
// makes re-enqueueing always safe.
async function enqueueSafely(req, file) {
  try {
    await enqueueFileUploaded({ fileId: file.id, storageKey: file.storage_key, contentType: file.content_type });
  } catch (err) {
    req.log.error({ err, fileId: file.id }, 'failed to enqueue post-processing job');
  }
}

const alreadyCompleted = fileId => ok({ fileId, status: 'complete', alreadyCompleted: true });

// Everything that can reject the request runs before the claim, so a bad
// request can never leave a file stuck in 'completing'.
async function preflight(file, body) {
  if (file.upload_id) {
    // The client's part list if it sent one, else the parts it recorded.
    const parts = body.parts?.length
      ? body.parts
      : (await getRecordedParts(file.id)).map(p => ({ PartNumber: p.part_number, ETag: p.etag }));
    return validateCompleteParts(parts, calculatePartCount(file.size_bytes)); // names missing parts
  }
  // Single-shot: the client PUT straight to storage, so only storage knows
  // whether it landed, and whether it's the size that was declared.
  const size = await storage.getObjectSize(file.storage_key);
  if (size === null) throw new AppError(409, 'UPLOAD_INCOMPLETE', 'the file has not been uploaded to storage yet');
  if (Number(size) !== Number(file.size_bytes)) {
    throw new AppError(409, 'SIZE_MISMATCH', `uploaded ${size} bytes but declared ${file.size_bytes}`);
  }
  return null;
}

// Merges the parts. NoSuchUpload after a successful claim means an earlier
// attempt merged in storage but failed before recording it; if the object is
// there at the declared size, that is success.
async function finalizeInStorage(file, parts) {
  try {
    await storage.completeMultipartUpload(file.storage_key, file.upload_id, parts);
  } catch (err) {
    if (err.name === 'NoSuchUpload' && Number(await storage.getObjectSize(file.storage_key)) === Number(file.size_bytes)) {
      return;
    }
    if (err.name === 'InvalidPart' || err.name === 'InvalidPartOrder') {
      throw new AppError(400, 'INVALID_PARTS', 'one or more part ETags do not match what was uploaded');
    }
    throw Object.assign(new AppError(502, 'STORAGE_ERROR', 'storage could not finalize; retry shortly'), { cause: err });
  }
}

async function completeUpload(req, res) {
  const body = validateCompleteBody(req.body);
  const file = await loadOwnedFile(req.params.fileId, req.userId);

  if (file.status === 'complete') { // idempotent: a client retry is not an error
    await enqueueSafely(req, file); // in case the first attempt never got the job queued
    return res.json(alreadyCompleted(file.id));
  }
  if (file.status === 'completing') {
    throw new AppError(409, 'COMPLETE_IN_PROGRESS', 'another request is completing this upload');
  }
  if (file.status !== 'uploading') {
    throw new AppError(409, 'UPLOAD_NOT_IN_PROGRESS', `upload is ${file.status}`);
  }

  const parts = await preflight(file, body);

  // Optimistic claim with a conditional UPDATE: of any number of simultaneous
  // completes, the database lets exactly one move uploading -> completing.
  const claim = await pool.query(
    `UPDATE files SET status = 'completing' WHERE id = $1 AND status = 'uploading' RETURNING id`,
    [file.id]
  );
  if (claim.rowCount === 0) {
    const now = await loadOwnedFile(file.id, req.userId);
    if (now.status === 'complete') return res.json(alreadyCompleted(file.id));
    throw new AppError(409, 'COMPLETE_IN_PROGRESS', 'another request is completing this upload');
  }

  try {
    if (file.upload_id) await finalizeInStorage(file, parts);
    await pool.query(`UPDATE files SET status = 'complete', completed_at = now() WHERE id = $1`, [file.id]);
  } catch (err) {
    // Release the claim so the client can retry; never leave it 'completing'.
    await pool.query(`UPDATE files SET status = 'uploading' WHERE id = $1 AND status = 'completing'`, [file.id])
      .catch(releaseErr => req.log.error({ err: releaseErr, fileId: file.id }, 'failed to release complete claim'));
    if (err.cause) req.log.error({ err: err.cause, fileId: file.id }, 'storage finalize failed');
    throw err;
  }

  await enqueueSafely(req, file);
  return res.json(ok({ fileId: file.id, status: 'complete' }));
}

module.exports = { completeUpload };
