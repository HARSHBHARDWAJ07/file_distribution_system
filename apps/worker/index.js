// Background worker: consumes file.uploaded jobs. Its real work only touches
// Postgres (queue + metadata) and object storage - no HTTP API. The one
// exception is a read-only /health endpoint, started only when PORT is set:
// Render's free tier has no Background Worker type, so in production this
// runs as a free Web Service that needs a port to bind and something to ping.
const http = require('http');
const { getBoss, QUEUES } = require('@cloudstore/queue');
const { pool } = require('./lib/db');
const { planWork } = require('./lib/workPlan');
const { generateThumbnail } = require('./jobs/generateThumbnail');
const { replicateFile } = require('./jobs/replicate');

const stats = { startedAt: new Date().toISOString(), jobsSucceeded: 0, jobsFailed: 0, lastJobAt: null };

function startHealthServer(port) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, data: { status: 'worker healthy', queue: QUEUES.FILE_UPLOADED, ...stats } }));
    }
    res.writeHead(404).end();
  });
  server.listen(port, () => console.log(`[worker] health endpoint on port ${port}`));
  return server;
}

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
      stats.lastJobAt = new Date().toISOString();
      try {
        await handleFileUploaded(job);
        stats.jobsSucceeded++;
      } catch (err) {
        stats.jobsFailed++;
        console.error(`[worker] job ${job.id} failed, will retry`, err);
        throw err; // rethrow so pg-boss applies its retry/backoff policy
      }
    }
  });
  console.log(`[worker] consuming ${QUEUES.FILE_UPLOADED}`);

  const healthServer = process.env.PORT ? startHealthServer(process.env.PORT) : null;

  const shutdown = async signal => {
    console.log(`[worker] ${signal} received, draining`);
    healthServer?.close();
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
