// Background worker: consumes file.uploaded jobs. Deliberately never opens an
// HTTP port - it only talks to Postgres (queue + metadata) and object storage.
const { getBoss, QUEUES } = require('@cloudstore/queue');
const { pool } = require('./lib/db');
const { planWork } = require('./lib/workPlan');
const { generateThumbnail } = require('./jobs/generateThumbnail');
const { replicateFile } = require('./jobs/replicate');

async function handleFileUploaded(job) {
  const { fileId } = job.data;
  const { rows } = await pool.query(
    'SELECT id, storage_key, content_type, status, thumbnail_key, replicated_at FROM files WHERE id = $1',
    [fileId]
  );
  const file = rows[0];
  if (!file) { // deleted before the job ran - nothing to do
    console.log(`[worker] job ${job.id}: file ${fileId} no longer exists, skipping`);
    return;
  }

  const plan = planWork(file);
  if (plan.isFullyProcessed) {
    console.log(`[worker] job ${job.id}: file ${fileId} already processed, skipping`);
    return;
  }

  // Each step records its result only after it succeeds, so a crash between
  // steps leaves the row in a state planWork can resume from.
  if (plan.needsThumbnail) {
    const thumbnailKey = await generateThumbnail(file);
    await pool.query('UPDATE files SET thumbnail_key = $1 WHERE id = $2', [thumbnailKey, fileId]);
    console.log(`[worker] job ${job.id}: thumbnail generated for ${fileId} -> ${thumbnailKey}`);
  }
  if (plan.needsReplication) {
    const replicaKey = await replicateFile(file);
    await pool.query('UPDATE files SET replicated_at = now() WHERE id = $1', [fileId]);
    console.log(`[worker] job ${job.id}: replicated ${fileId} -> ${replicaKey}`);
  }
}

async function main() {
  const boss = await getBoss();

  // localConcurrency caps parallel jobs: free-tier compute is small, and a
  // burst of concurrent sharp resizes is an easy way to get OOM-killed.
  await boss.work(QUEUES.FILE_UPLOADED, { localConcurrency: 2 }, async jobs => {
    for (const job of jobs) {
      try {
        await handleFileUploaded(job);
      } catch (err) {
        console.error(`[worker] job ${job.id} failed, will retry`, err);
        throw err; // rethrow so pg-boss applies its retry/backoff policy
      }
    }
  });
  console.log(`[worker] consuming ${QUEUES.FILE_UPLOADED}`);

  const shutdown = async signal => {
    console.log(`[worker] ${signal} received, draining`);
    await boss.stop({ graceful: true });
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('[worker] failed to start', err);
  process.exit(1);
});
