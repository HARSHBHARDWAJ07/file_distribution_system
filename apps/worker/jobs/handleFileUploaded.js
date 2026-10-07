const { pool } = require('../lib/db');
const { deleteObject } = require('../lib/storage');
const { planWork } = require('../lib/workPlan');
const { generateThumbnail, UnprocessableImageError } = require('./generateThumbnail');
const { replicateFile } = require('./replicate');
const { replicaBucket } = require('@cloudstore/shared-types');

async function loadFile(fileId) {
  const { rows } = await pool.query(
    'SELECT id, storage_key, content_type, status, thumbnail_key, thumbnail_error, replicated_at FROM files WHERE id = $1',
    [fileId]
  );
  return rows[0] || null;
}

// Records a step's result. Returns false if the row is gone: the file was
// deleted while this step ran, after the delete already swept storage.
async function record(sql, params) {
  const { rowCount } = await pool.query(sql, params);
  return rowCount > 0;
}

async function handleFileUploaded(job, log) {
  const { fileId } = job.data;
  const file = await loadFile(fileId);
  if (!file) { // deleted before the job ran - nothing to do
    log.info({ fileId }, 'file no longer exists, skipping');
    return;
  }

  const plan = planWork(file);
  if (plan.isFullyProcessed) {
    log.info({ fileId }, 'already processed, skipping');
    return;
  }

  // Replication first: a durable second copy matters more than a preview,
  // so a thumbnail problem must never be what stops a file being replicated.
  // Each step records its result only after it succeeds, so a crash between
  // steps leaves the row in a state planWork can resume from.
  if (plan.needsReplication) {
    const replicaKey = await replicateFile(file);
    if (!(await record('UPDATE files SET replicated_at = now() WHERE id = $1', [fileId]))) {
      await deleteObject(replicaKey, replicaBucket()); // don't leak a copy of a deleted file
      log.info({ fileId }, 'file deleted mid-job, removed its new replica');
      return;
    }
    log.info({ fileId, replicaKey }, 'replicated');
  }

  if (plan.needsThumbnail) {
    try {
      const thumbnailKey = await generateThumbnail(file);
      if (!(await record('UPDATE files SET thumbnail_key = $1 WHERE id = $2', [thumbnailKey, fileId]))) {
        await deleteObject(thumbnailKey);
        log.info({ fileId }, 'file deleted mid-job, removed its new thumbnail');
        return;
      }
      log.info({ fileId, thumbnailKey }, 'thumbnail generated');
    } catch (err) {
      if (!(err instanceof UnprocessableImageError)) throw err; // transient: let pg-boss retry
      await record('UPDATE files SET thumbnail_error = $1 WHERE id = $2', [err.message.slice(0, 500), fileId]);
      log.warn({ fileId, reason: err.message }, 'image cannot be thumbnailed, recorded and skipped');
    }
  }
}

module.exports = { handleFileUploaded };
