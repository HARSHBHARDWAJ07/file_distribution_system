const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { getFileById } = require('../lib/files');
const { ok, fail } = require('@cloudstore/shared-types');

async function completeUpload(req, res) {
  const ownerId = req.headers['x-user-id'];
  const { fileId } = req.params;
  const { parts } = req.body || {};

  const file = await getFileById(fileId);
  if (!file) {
    return res.status(404).json(fail('FILE_NOT_FOUND', 'no file with that id'));
  }
  if (file.owner_id !== ownerId) {
    return res.status(403).json(fail('FORBIDDEN', 'you do not have access to this file'));
  }
  if (file.status === 'complete') { // idempotent: a client retry is not an error
    return res.json(ok({ fileId, status: 'complete', alreadyCompleted: true }));
  }

  if (file.upload_id) {
    if (!Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json(fail('INVALID_INPUT', 'parts array is required to complete a chunked upload'));
    }
    const sorted = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
    await storage.completeMultipartUpload(file.storage_key, file.upload_id, sorted);
  }
  // single-shot needs no storage action here - the client's PUT already landed the object

  await pool.query(`UPDATE files SET status = 'complete', completed_at = now() WHERE id = $1`, [fileId]);
  return res.json(ok({ fileId, status: 'complete' }));
}

module.exports = { completeUpload };
