// pg-boss against a real Postgres, in a throwaway pg-boss schema. Runs under
// node:test rather than jest: pg-boss is ESM-only, which Node's own require()
// loads but jest's module sandbox cannot. Skipped unless TEST_DATABASE_URL is set.
//   TEST_DATABASE_URL=postgres://... node --test packages/queue/integration/
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const BASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = `itboss_${crypto.randomBytes(4).toString('hex')}`;

describe('file.uploaded queue on real Postgres', { skip: !BASE_URL && 'TEST_DATABASE_URL not set' }, () => {
  let queue;

  before(() => {
    process.env.DATABASE_URL = BASE_URL;
    process.env.PGBOSS_SCHEMA = SCHEMA;
    queue = require('..');
  });

  after(async () => {
    const boss = await queue.getBoss();
    await boss.getDb().executeSql(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await queue.stopBoss();
  });

  it('drops a second enqueue for a file whose job is still queued (singletonKey)', async () => {
    const fileId = crypto.randomUUID();
    const first = await queue.enqueueFileUploaded({ fileId });
    const retry = await queue.enqueueFileUploaded({ fileId }); // e.g. a retried completeUpload
    assert.equal(typeof first, 'string');
    assert.equal(retry, null);

    const other = await queue.enqueueFileUploaded({ fileId: crypto.randomUUID() });
    assert.equal(typeof other, 'string', 'dedupe is per file, not per queue');
  });

  it('accepts a new job once the previous one for that file has been taken', async () => {
    const fileId = crypto.randomUUID();
    await queue.enqueueFileUploaded({ fileId });
    const boss = await queue.getBoss();
    const jobs = await boss.fetch(queue.QUEUES.FILE_UPLOADED, { batchSize: 100 });
    const job = jobs.find(j => j.data.fileId === fileId);
    assert.ok(job);
    await boss.complete(queue.QUEUES.FILE_UPLOADED, job.id);
    // The reconciliation sweep relies on this: re-enqueueing a finished file works.
    assert.equal(typeof await queue.enqueueFileUploaded({ fileId }), 'string');
  });
});
