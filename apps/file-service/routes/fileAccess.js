const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { loadOwnedFile } = require('../lib/files');
const { ok, fail, thumbnailKeyFor, replicaKeyFor, replicaBucket } = require('@cloudstore/shared-types');

async function downloadFile(req, res) {
  const loaded = await loadOwnedFile(req, res);
  if (!loaded) return;
  const { file } = loaded;
  if (file.status !== 'complete') {
    return res.status(404).json(fail('FILE_NOT_FOUND', 'no completed file with that id'));
  }

  const url = await storage.getPresignedDownloadUrl(file.storage_key);
  return res.json(ok({ downloadUrl: url, filename: file.filename }));
}

async function deleteFile(req, res) {
  const loaded = await loadOwnedFile(req, res);
  if (!loaded) return;
  const { file } = loaded;

  // An unfinished chunked upload holds its parts in storage until aborted;
  // deleting only the (not yet assembled) object would leak them.
  if (file.upload_id && file.status !== 'complete') {
    await storage.abortMultipartUpload(file.storage_key, file.upload_id);
  }

  // Storage first, metadata second: if a storage call fails the row survives
  // and the delete can be retried. Every derived object is deleted by its
  // deterministic key, whether or not the worker has recorded it yet.
  await Promise.all([
    storage.deleteObject(file.storage_key),
    storage.deleteObject(thumbnailKeyFor(file.id)),
    storage.deleteObject(replicaKeyFor(file.storage_key), replicaBucket()),
  ]);
  await pool.query('DELETE FROM files WHERE id = $1', [file.id]);
  return res.json(ok({ fileId: file.id, deleted: true }));
}

module.exports = { downloadFile, deleteFile };
