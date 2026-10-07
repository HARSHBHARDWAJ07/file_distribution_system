// pg-boss v12 is ESM-only; Node >= 22.12 can require() it directly.
const { PgBoss } = require('pg-boss');

const QUEUES = { FILE_UPLOADED: 'file.uploaded' };

let bossPromise = null;

async function startBoss() {
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    schema: process.env.PGBOSS_SCHEMA || 'pgboss', // overridable so tests get a throwaway queue
    ssl: process.env.DATABASE_URL?.includes('sslmode=require')
      ? { rejectUnauthorized: false } : false,
  });
  boss.on('error', err => console.error('[pg-boss] error', err));
  await boss.start(); // creates its own schema (pgboss.*) on first run

  // 'short' policy: at most one *queued* job per singletonKey, so a second
  // send() for the same file while the first is still waiting is dropped.
  // (Under the default 'standard' policy, singletonKey would not dedupe.)
  await boss.createQueue(QUEUES.FILE_UPLOADED, {
    policy: 'short',
    retryLimit: 3,
    retryBackoff: true,
  });
  return boss;
}

// Caches the promise rather than the instance, so concurrent first callers
// share one start() instead of racing to create two connection pools.
function getBoss() {
  if (!bossPromise) {
    bossPromise = startBoss().catch(err => {
      bossPromise = null; // let the next caller retry after a transient failure
      throw err;
    });
  }
  return bossPromise;
}

async function enqueueFileUploaded(payload) {
  const boss = await getBoss();
  return boss.send(QUEUES.FILE_UPLOADED, payload, {
    singletonKey: `file-uploaded:${payload.fileId}`, // dedupes retried completeUpload calls
  });
}

// For tests and graceful shutdown: stops the shared instance if one started.
async function stopBoss() {
  if (!bossPromise) return;
  const boss = await bossPromise.catch(() => null);
  bossPromise = null;
  if (boss) await boss.stop({ graceful: false });
}

module.exports = { getBoss, stopBoss, enqueueFileUploaded, QUEUES };
