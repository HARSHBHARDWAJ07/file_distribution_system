const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { getFileById } = require('../lib/files');
const { ok, fail } = require('@cloudstore/shared-types');

async function downloadFile(req, res) {
  const ownerId = req.headers['x-user-id'];
  const { fileId } = req.params;

  const file = await getFileById(fileId);
  if (!file || file.status !== 'complete') {
    return res.status(404).json(fail('FILE_NOT_FOUND', 'no completed file with that id'));
  }
  if (file.owner_id !== ownerId) {
    return res.status(403).json(fail('FORBIDDEN', 'you do not have access to this file'));
  }

  const url = await storage.getPresignedDownloadUrl(file.storage_key);
  return res.json(ok({ downloadUrl: url, filename: file.filename }));
}

async function deleteFile(req, res) {
  const ownerId = req.headers['x-user-id'];
  const { fileId } = req.params;

  const file = await getFileById(fileId);
  if (!file) {
    return res.status(404).json(fail('FILE_NOT_FOUND', 'no file with that id'));
  }
  if (file.owner_id !== ownerId) {
    return res.status(403).json(fail('FORBIDDEN', 'you do not have access to this file'));
  }

  await storage.deleteObject(file.storage_key); // storage first
  await pool.query('DELETE FROM files WHERE id = $1', [fileId]); // metadata second
  return res.json(ok({ fileId, deleted: true }));
}

module.exports = { downloadFile, deleteFile };
