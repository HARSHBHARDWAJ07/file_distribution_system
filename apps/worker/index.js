// Background worker: consumes file.uploaded jobs. Deliberately never opens an
// HTTP port - it only talks to Postgres (queue + metadata) and object storage.
//
// Two modes, same job handler:
//   node index.js          long-running consumer (local dev / docker-compose)
//   node index.js --drain  process everything queued, then exit. Production
//                          runs this on a GitHub Actions schedule, since no
//                          free host keeps a long-running worker alive.
const { getBoss, QUEUES } = require('@cloudstore/queue');
const { pool } = require('./lib/db');
const { planWork } = require('./lib/workPlan');
const { generateThumbnail } = require('./jobs/generateThumbnail');
const { replicateFile } = require('./jobs/replicate');

// Caps parallel jobs: runner/dyno compute is small, and a burst of
// concurrent sharp resizes is an easy way to get OOM-killed.
const CONCURRENCY = 2;
// A drain run stops picking up new jobs after this long, so a flood of
// uploads can't keep one Actions run alive forever; the next run continues.
const DRAIN_MAX_SECONDS = Number(process.env.DRAIN_MAX_SECONDS) || 8 * 60;

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

async function consume(boss) {
  await boss.work(QUEUES.FILE_UPLOADED, { localConcurrency: CONCURRENCY }, async jobs => {
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

// fetch/complete/fail by hand instead of work(): work() polls forever,
// while a drain run must notice the queue is empty and exit.
async function drain(boss) {
  const deadline = Date.now() + DRAIN_MAX_SECONDS * 1000;
  let succeeded = 0;
  let failed = 0;

  while (Date.now() < deadline) {
    const jobs = await boss.fetch(QUEUES.FILE_UPLOADED, { batchSize: CONCURRENCY });
    if (jobs.length === 0) break;

    await Promise.all(jobs.map(async job => {
      try {
        await handleFileUploaded(job);
        await boss.complete(QUEUES.FILE_UPLOADED, job.id);
        succeeded++;
      } catch (err) {
        console.error(`[worker] job ${job.id} failed, will retry`, err);
        // fail() hands the job back to pg-boss's retry/backoff policy; a
        // retry scheduled for later is picked up by a future drain run.
        await boss.fail(QUEUES.FILE_UPLOADED, job.id, { message: err.message });
        failed++;
      }
    }));
  }

  const timedOut = Date.now() >= deadline;
  console.log(`[worker] drain done: ${succeeded} succeeded, ${failed} failed${timedOut ? ', stopped at time limit' : ', queue empty'}`);
  if (failed && process.env.GITHUB_ACTIONS) {
    console.log(`::warning::${failed} job(s) failed and were handed back to pg-boss for retry`);
  }
}

async function main() {
  const boss = await getBoss();
  if (!process.argv.includes('--drain')) return consume(boss);

  try {
    await drain(boss);
  } finally {
    await boss.stop({ graceful: true });
    await pool.end();
  }
}

main().catch(err => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
