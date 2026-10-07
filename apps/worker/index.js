// Background worker: consumes file.uploaded jobs. Deliberately never opens an
// HTTP port - it only talks to Postgres (queue + metadata) and object storage.
//
// Two modes, same job handler:
//   node index.js          long-running consumer (local dev / docker-compose)
//   node index.js --drain  process everything queued, then exit. Production
//                          runs this on a GitHub Actions schedule, since no
//                          free host keeps a long-running worker alive.
const { createLogger } = require('@cloudstore/logger');
const { requireEnv, logProcessErrors } = require('@cloudstore/http-utils');

const logger = createLogger('worker');
logProcessErrors(logger);
requireEnv(['DATABASE_URL', 'STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY']);

const { getBoss, enqueueFileUploaded, QUEUES } = require('@cloudstore/queue');
const { pool } = require('./lib/db');
const { reconcile } = require('./lib/reconcile');
const { handleFileUploaded } = require('./jobs/handleFileUploaded');

// Caps parallel jobs: runner/dyno compute is small, and a burst of
// concurrent sharp resizes is an easy way to get OOM-killed.
const CONCURRENCY = 2;
// A drain run stops picking up new jobs after this long, so a flood of
// uploads can't keep one Actions run alive forever; the next run continues.
const DRAIN_MAX_SECONDS = Number(process.env.DRAIN_MAX_SECONDS) || 8 * 60;
const RECONCILE_EVERY_MS = 5 * 60 * 1000; // long-running mode; drain mode sweeps once per run

function reconcileSafely() {
  return reconcile(enqueueFileUploaded, logger)
    .catch(err => logger.error({ err }, 'reconciliation sweep failed'));
}

// One child logger per job, so every line it writes carries the job id.
function runJob(job) {
  return handleFileUploaded(job, logger.child({ jobId: job.id }));
}

async function consume(boss) {
  await boss.work(QUEUES.FILE_UPLOADED, { localConcurrency: CONCURRENCY }, async jobs => {
    for (const job of jobs) {
      try {
        await runJob(job);
      } catch (err) {
        logger.error({ err, jobId: job.id }, 'job failed, will retry');
        throw err; // rethrow so pg-boss applies its retry/backoff policy
      }
    }
  });
  logger.info({ queue: QUEUES.FILE_UPLOADED }, 'consuming');

  await reconcileSafely();
  const sweep = setInterval(reconcileSafely, RECONCILE_EVERY_MS);

  const shutdown = async signal => {
    logger.info({ signal }, 'shutting down');
    clearInterval(sweep);
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
  await reconcileSafely(); // anything stuck gets re-queued, then drained below
  let succeeded = 0;
  let failed = 0;

  while (Date.now() < deadline) {
    const jobs = await boss.fetch(QUEUES.FILE_UPLOADED, { batchSize: CONCURRENCY });
    if (jobs.length === 0) break;

    await Promise.all(jobs.map(async job => {
      try {
        await runJob(job);
        await boss.complete(QUEUES.FILE_UPLOADED, job.id);
        succeeded++;
      } catch (err) {
        logger.error({ err, jobId: job.id }, 'job failed, will retry');
        // fail() hands the job back to pg-boss's retry/backoff policy; a
        // retry scheduled for later is picked up by a future drain run.
        await boss.fail(QUEUES.FILE_UPLOADED, job.id, { message: err.message });
        failed++;
      }
    }));
  }

  const stoppedBy = Date.now() >= deadline ? 'time limit' : 'queue empty';
  logger.info({ succeeded, failed, stoppedBy }, 'drain done');
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
  logger.fatal({ err }, 'worker crashed');
  process.exit(1);
});
