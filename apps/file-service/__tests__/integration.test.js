// Integration tests against a real Postgres: the SQL the unit tests can only
// fake (the atomic claim, ownership in WHERE, CHECK constraints). Each run
// builds the schema in a throwaway Postgres schema and drops it afterwards.
// Skipped unless TEST_DATABASE_URL is set (CI provides a Postgres service).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = BASE_URL ? describe : describe.skip;
const SCHEMA = `it_${crypto.randomBytes(4).toString('hex')}`;

if (BASE_URL) {
  // lib/db.js reads DATABASE_URL at require time; point it at the test schema.
  const url = new URL(BASE_URL);
  url.searchParams.set('options', `-c search_path=${SCHEMA},public`);
  process.env.DATABASE_URL = url.toString();
}

jest.mock('../lib/storage', () => ({
  buildKey: jest.fn((owner, name) => `users/${owner}/${require('crypto').randomUUID()}-${name}`),
  getPresignedUploadUrl: jest.fn(async () => 'https://storage.test/put'),
  createMultipartUpload: jest.fn(async () => 'mpu-1'),
  completeMultipartUpload: jest.fn(async () => {}),
  getObjectSize: jest.fn(),
  getPresignedDownloadUrl: jest.fn(async () => 'https://storage.test/get'),
}));
jest.mock('@cloudstore/queue', () => ({ enqueueFileUploaded: jest.fn(async () => 'job-1') }));

const request = require('supertest');

const TOKEN = 'it-internal-token';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const sql = file => fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');

describeDb('file-service against real Postgres', () => {
  let pool;
  let app;
  let storage;
  let enqueueFileUploaded;

  beforeAll(async () => {
    ({ pool } = require('../lib/db'));
    storage = require('../lib/storage');
    ({ enqueueFileUploaded } = require('@cloudstore/queue'));
    const { createLogger } = require('@cloudstore/logger');
    const { createApp } = require('../app');

    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const file of ['schema.sql', 'migration_phase3.sql', 'migration_phase4.sql']) await pool.query(sql(file));
    app = createApp({ logger: createLogger('it'), internalToken: TOKEN });
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(() => jest.clearAllMocks());

  const as = (userId, req) => req.set('x-internal-token', TOKEN).set('x-user-id', userId);
  async function initSingle(sizeBytes = 1000) {
    const res = await as(ALICE, request(app).post('/uploads/init')).send({ filename: 'cat.png', sizeBytes, contentType: 'image/png' });
    return res.body.data.fileId;
  }
  const statusOf = async id => (await pool.query('SELECT status FROM files WHERE id = $1', [id])).rows[0]?.status;

  it('five simultaneous completes: Postgres lets exactly one claim the row', async () => {
    const fileId = await initSingle(1000);
    // Slow storage check: every request loads the row as 'uploading' and
    // passes preflight before any of them claims, so the race is real.
    storage.getObjectSize.mockImplementation(() => new Promise(r => setTimeout(() => r(1000), 150)));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => as(ALICE, request(app).post(`/uploads/${fileId}/complete`)).send({}).then(r => r))
    );
    const winners = results.filter(r => r.status === 200 && !r.body.data.alreadyCompleted);
    const losers = results.filter(r => r !== winners[0]);

    expect(winners).toHaveLength(1);
    for (const r of losers) {
      expect(r.status === 409 ? r.body.error.code : r.body.data?.alreadyCompleted).toEqual(
        r.status === 409 ? 'COMPLETE_IN_PROGRESS' : true);
    }
    expect(await statusOf(fileId)).toBe('complete');
    expect(enqueueFileUploaded).toHaveBeenCalledTimes(1);
  });

  it('a storage failure releases the claim back to uploading in the real table', async () => {
    const res = await as(ALICE, request(app).post('/uploads/init')).send({ filename: 'big.bin', sizeBytes: 6 * 1024 * 1024 });
    const fileId = res.body.data.fileId;
    for (const n of [1, 2]) {
      await as(ALICE, request(app).post(`/uploads/${fileId}/parts/${n}`)).send({ etag: `"e${n}"` });
    }
    storage.completeMultipartUpload.mockRejectedValueOnce(Object.assign(new Error('503'), { name: 'SlowDown' }));
    expect((await as(ALICE, request(app).post(`/uploads/${fileId}/complete`)).send({})).status).toBe(502);
    expect(await statusOf(fileId)).toBe('uploading');
  });

  it("ownership is enforced by the SQL: another user's file is a 404", async () => {
    const fileId = await initSingle();
    const res = await as(BOB, request(app).get(`/uploads/${fileId}/status`));
    expect(res.status).toBe(404);
    expect((await as(ALICE, request(app).get(`/uploads/${fileId}/status`))).status).toBe(200);
  });

  it('the CHECK constraints refuse a misspelled status and a non-positive size', async () => {
    const fileId = await initSingle();
    await expect(pool.query(`UPDATE files SET status = 'complet' WHERE id = $1`, [fileId]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE files SET size_bytes = 0 WHERE id = $1`, [fileId]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('the reconciliation index exists for the worker sweep', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_files_unprocessed'`, [SCHEMA]);
    expect(rows[0].indexdef).toMatch(/WHERE .*status = 'complete'.*replicated_at IS NULL/);
  });
});
