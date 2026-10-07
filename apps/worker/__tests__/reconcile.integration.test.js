// The reconciliation sweep's query against a real Postgres. Skipped unless
// TEST_DATABASE_URL is set (CI provides a Postgres service).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = BASE_URL ? describe : describe.skip;
const SCHEMA = `itw_${crypto.randomBytes(4).toString('hex')}`;

describeDb('reconciliation sweep on real Postgres', () => {
  let pool;
  let reconcile;

  beforeAll(async () => {
    const url = new URL(BASE_URL);
    url.searchParams.set('options', `-c search_path=${SCHEMA},public`);
    process.env.DATABASE_URL = url.toString();
    ({ pool } = require('../lib/db'));
    ({ reconcile } = require('../lib/reconcile'));

    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    const dbDir = path.join(__dirname, '..', '..', 'file-service', 'db');
    for (const f of ['schema.sql', 'migration_phase3.sql', 'migration_phase4.sql']) {
      await pool.query(fs.readFileSync(path.join(dbDir, f), 'utf8'));
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  async function insert(name, { status = 'complete', completedMinutesAgo = 30, replicated = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO files (owner_id, filename, size_bytes, storage_key, status, completed_at, replicated_at)
       VALUES (gen_random_uuid(), $1, 10, $2, $3, now() - make_interval(mins => $4), $5) RETURNING id`,
      [name, `users/x/${crypto.randomUUID()}-${name}`, status, completedMinutesAgo, replicated ? new Date() : null]
    );
    return rows[0].id;
  }

  it('re-enqueues only complete files left unprocessed for over 10 minutes', async () => {
    const stuck = await insert('stuck');
    await insert('fresh', { completedMinutesAgo: 2 });      // the worker may still be on it
    await insert('done', { replicated: true });              // already processed
    await insert('in-flight', { status: 'uploading' });      // not complete yet

    const enqueue = jest.fn(async () => 'job');
    const log = { warn: jest.fn() };
    expect(await reconcile(enqueue, log)).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ fileId: stuck }));
  });
});
