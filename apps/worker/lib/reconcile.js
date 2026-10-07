const { pool } = require('./db');

// Closes the gap the file-service's failure policy leaves open: a file stored
// and marked complete whose post-processing job was never enqueued (queue
// hiccup) or exhausted its retries. Re-enqueueing is always safe - the
// singletonKey dedupes a job that's still queued, and planWork turns finished
// work into a no-op. The query matches idx_files_unprocessed's predicate.
async function reconcile(enqueue, log, { olderThanMinutes = 10, limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, storage_key, content_type FROM files
      WHERE status = 'complete' AND replicated_at IS NULL
        AND completed_at < now() - make_interval(mins => $1)
      ORDER BY completed_at
      LIMIT $2`,
    [olderThanMinutes, limit]
  );
  for (const file of rows) {
    await enqueue({ fileId: file.id, storageKey: file.storage_key, contentType: file.content_type });
  }
  if (rows.length) log.warn({ count: rows.length }, 'reconciliation re-enqueued unprocessed files');
  return rows.length;
}

module.exports = { reconcile };
