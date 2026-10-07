// HTTP-level edge cases for the file-service, with Postgres, storage and the
// queue replaced by in-memory fakes so this runs in CI with no infra.
// (__tests__/integration.test.js runs the same SQL against a real Postgres.)
const crypto = require('crypto');
const request = require('supertest');

jest.mock('../lib/db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../lib/storage', () => ({
  buildKey: jest.fn((owner, name) => `users/${owner}/${require('crypto').randomUUID()}-${name}`),
  getPresignedUploadUrl: jest.fn(async () => 'https://storage.test/put'),
  getPresignedDownloadUrl: jest.fn(async () => 'https://storage.test/get'),
  getPresignedPartUploadUrl: jest.fn(async () => 'https://storage.test/part'),
  createMultipartUpload: jest.fn(async () => 'mpu-1'),
  completeMultipartUpload: jest.fn(async () => {}),
  abortMultipartUpload: jest.fn(async () => {}),
  deleteObject: jest.fn(async () => {}),
  getObjectSize: jest.fn(async () => null),
}));
jest.mock('@cloudstore/queue', () => ({ enqueueFileUploaded: jest.fn(async () => 'job-1') }));

const { pool } = require('../lib/db');
const storage = require('../lib/storage');
const { enqueueFileUploaded } = require('@cloudstore/queue');
const { createLogger } = require('@cloudstore/logger');
const { createApp } = require('../app');
const { CHUNK_SIZE_BYTES } = require('../lib/chunking');

const TOKEN = 'test-internal-token';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

// Just enough of Postgres for the queries these routes run, including the
// conditional UPDATEs, so the claim logic is exercised for real.
function fakeDb() {
  const files = new Map();
  const parts = new Map(); // fileId -> Map(partNumber -> etag)
  pool.query.mockImplementation(async (sql, p = []) => {
    const f = files.get(p[0]);
    if (sql.startsWith('SELECT * FROM files WHERE id = $1 AND owner_id = $2')) {
      return { rows: f && f.owner_id === p[1] ? [{ ...f }] : [] };
    }
    if (sql.includes('INSERT INTO files')) {
      const id = crypto.randomUUID();
      files.set(id, { id, owner_id: p[0], filename: p[1], size_bytes: String(p[2]), storage_key: p[3],
        status: 'uploading', content_type: p[4], upload_id: null });
      return { rows: [{ id }] };
    }
    if (sql.startsWith('UPDATE files SET upload_id')) { files.get(p[1]).upload_id = p[0]; return { rowCount: 1 }; }
    if (sql.includes("SET status = 'completing'")) {
      if (!f || f.status !== 'uploading') return { rowCount: 0, rows: [] };
      f.status = 'completing';
      return { rowCount: 1, rows: [{ id: f.id }] };
    }
    if (sql.includes("SET status = 'complete'")) { f.status = 'complete'; return { rowCount: 1 }; }
    if (sql.includes("SET status = 'uploading'")) { // release
      if (f.status !== 'completing') return { rowCount: 0 };
      f.status = 'uploading';
      return { rowCount: 1 };
    }
    if (sql.includes("SET status = 'failed'")) {
      if (sql.includes("AND status = 'uploading'") && f.status !== 'uploading') return { rowCount: 0 };
      f.status = 'failed';
      return { rowCount: 1 };
    }
    if (sql.includes('INSERT INTO upload_parts')) {
      if (!parts.has(p[0])) parts.set(p[0], new Map());
      parts.get(p[0]).set(p[1], p[2]);
      return { rowCount: 1 };
    }
    if (sql.includes('FROM upload_parts')) {
      const m = parts.get(p[0]) || new Map();
      return { rows: [...m].sort((a, b) => a[0] - b[0]).map(([part_number, etag]) => ({ part_number, etag })) };
    }
    if (sql.startsWith('DELETE FROM files')) { files.delete(p[0]); return { rowCount: 1 }; }
    throw new Error(`fakeDb: unhandled query ${sql}`);
  });
  return { files };
}

let app;
let db;
beforeEach(() => {
  jest.clearAllMocks();
  db = fakeDb();
  app = createApp({ logger: createLogger('file-service-test'), internalToken: TOKEN });
});

const as = (userId, req) => req.set('x-internal-token', TOKEN).set('x-user-id', userId);
const init = (body, user = ALICE) => as(user, request(app).post('/uploads/init')).send(body);
const complete = (fileId, body = {}, user = ALICE) => as(user, request(app).post(`/uploads/${fileId}/complete`)).send(body);

async function initSingle(overrides = {}) {
  const res = await init({ filename: 'cat.png', sizeBytes: 1000, contentType: 'image/png', ...overrides });
  return res.body.data.fileId;
}
async function initChunked(sizeBytes = CHUNK_SIZE_BYTES * 2 + 10) { // 3 parts
  const res = await init({ filename: 'big.bin', sizeBytes });
  return res.body.data.fileId;
}
async function recordParts(fileId, numbers) {
  for (const n of numbers) {
    await as(ALICE, request(app).post(`/uploads/${fileId}/parts/${n}`)).send({ etag: `"etag-${n}"` });
  }
}

describe('gateway-only access (the x-user-id bypass)', () => {
  it('rejects a request with no internal token even if it names a real user', async () => {
    const res = await request(app).post('/uploads/init').set('x-user-id', ALICE).send({ filename: 'a.txt', sizeBytes: 10 });
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a wrong internal token', async () => {
    const res = await request(app).get(`/files/${crypto.randomUUID()}/download`)
      .set('x-internal-token', 'guess').set('x-user-id', ALICE);
    expect(res.status).toBe(401);
  });

  it('rejects a valid token with a malformed user id', async () => {
    const res = await as('not-a-uuid', request(app).post('/uploads/init')).send({ filename: 'a', sizeBytes: 1 });
    expect(res.status).toBe(401);
  });

  it('still serves /health without a token, for the host health check', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('refuses to start without a token configured (fails closed)', () => {
    expect(() => createApp({ logger: createLogger('t'), internalToken: undefined })).toThrow(/INTERNAL_API_TOKEN/);
  });
});

describe('ownership on every route', () => {
  // All 7 handlers: a file that exists but isn't yours is indistinguishable
  // from one that doesn't exist, so ids can't be enumerated.
  it.each([
    ['part URL', id => request(app).get(`/uploads/${id}/parts/1`)],
    ['record part', id => request(app).post(`/uploads/${id}/parts/1`).send({ etag: '"x"' })],
    ['status', id => request(app).get(`/uploads/${id}/status`)],
    ['complete', id => request(app).post(`/uploads/${id}/complete`).send({})],
    ['abort', id => request(app).post(`/uploads/${id}/abort`)],
    ['download', id => request(app).get(`/files/${id}/download`)],
    ['delete', id => request(app).delete(`/files/${id}`)],
  ])("%s on someone else's file is the same 404 as a missing file", async (_, call) => {
    const fileId = await initChunked();
    const foreign = await as(BOB, call(fileId));
    const missing = await as(BOB, call(crypto.randomUUID()));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
    expect(db.files.get(fileId).status).toBe('uploading'); // untouched
  });

  it('rejects a malformed file id with 400 before touching the database', async () => {
    const res = await as(ALICE, request(app).get('/files/not-a-uuid/download'));
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('init', () => {
  it('stores the content type lower-cased so the worker matches it exactly', async () => {
    const fileId = await initSingle({ contentType: 'IMAGE/PNG' });
    expect(db.files.get(fileId).content_type).toBe('image/png');
  });

  it('rejects a path-traversal filename', async () => {
    const res = await init({ filename: '../../etc/passwd', sizeBytes: 10 });
    expect(res.status).toBe(400);
  });

  it('marks the row failed (not a phantom "uploading") if storage errors', async () => {
    storage.createMultipartUpload.mockRejectedValueOnce(new Error('storage down'));
    const res = await init({ filename: 'big.bin', sizeBytes: CHUNK_SIZE_BYTES * 3 });
    expect(res.status).toBe(500);
    expect([...db.files.values()][0].status).toBe('failed');
  });

  it('rejects part numbers beyond what the file size needs', async () => {
    const fileId = await initChunked(); // 3 parts
    const res = await as(ALICE, request(app).get(`/uploads/${fileId}/parts/4`));
    expect(res.status).toBe(400);
  });
});

describe('completing a single-shot upload', () => {
  it('refuses to complete when nothing was uploaded to storage', async () => {
    const fileId = await initSingle();
    const res = await complete(fileId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UPLOAD_INCOMPLETE');
    expect(db.files.get(fileId).status).toBe('uploading'); // checked before the claim: never stuck
    expect(enqueueFileUploaded).not.toHaveBeenCalled();
  });

  it('refuses when the stored size differs from the declared size', async () => {
    const fileId = await initSingle({ sizeBytes: 1000 });
    storage.getObjectSize.mockResolvedValueOnce(999);
    const res = await complete(fileId);
    expect(res.body.error.code).toBe('SIZE_MISMATCH');
  });

  it('completes and enqueues exactly one job', async () => {
    const fileId = await initSingle({ sizeBytes: 1000 });
    storage.getObjectSize.mockResolvedValueOnce(1000);
    const res = await complete(fileId);
    expect(res.body.data).toEqual({ fileId, status: 'complete' });
    expect(enqueueFileUploaded).toHaveBeenCalledTimes(1);
  });

  it('a retried complete is idempotent and re-enqueues in case the first enqueue was lost', async () => {
    const fileId = await initSingle({ sizeBytes: 1000 });
    storage.getObjectSize.mockResolvedValue(1000);
    await complete(fileId);
    const retry = await complete(fileId);
    expect(retry.body.data.alreadyCompleted).toBe(true);
    expect(enqueueFileUploaded).toHaveBeenCalledTimes(2);
  });

  it('an enqueue failure is logged but never fails the upload or flips it to failed', async () => {
    const fileId = await initSingle({ sizeBytes: 1000 });
    storage.getObjectSize.mockResolvedValueOnce(1000);
    enqueueFileUploaded.mockRejectedValueOnce(new Error('queue down'));
    const res = await complete(fileId);
    expect(res.status).toBe(200);
    expect(db.files.get(fileId).status).toBe('complete');
  });
});

describe('completing a chunked upload', () => {
  it('names the missing parts before claiming, so the file is never left "completing"', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [1, 3]);
    const res = await complete(fileId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'MISSING_PARTS', message: 'cannot complete: missing part(s) 2' });
    expect(db.files.get(fileId).status).toBe('uploading');
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('falls back to the server-recorded parts when the client sends none', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [3, 1, 2]);
    const res = await complete(fileId);
    expect(res.status).toBe(200);
    expect(storage.completeMultipartUpload.mock.calls[0][2].map(p => p.PartNumber)).toEqual([1, 2, 3]);
  });

  it('rejects a client part list with duplicates', async () => {
    const fileId = await initChunked();
    const parts = [1, 2, 2, 3].map(n => ({ PartNumber: n, ETag: `"e${n}"` }));
    const res = await complete(fileId, { parts });
    expect(res.body.error.code).toBe('DUPLICATE_PARTS');
  });

  it('two simultaneous completes: exactly one merges, the other is told it is in progress', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [1, 2, 3]);
    let release;
    storage.completeMultipartUpload.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const first = complete(fileId).then(r => r); // .then() sends it now; supertest is lazy
    while (!release) await new Promise(r => setTimeout(r, 10)); // first has claimed, is inside storage
    const second = await complete(fileId);
    release();
    expect((await first).body.data.status).toBe('complete');
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('COMPLETE_IN_PROGRESS');
    expect(storage.completeMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it('a storage failure releases the claim (502) so a retry succeeds', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [1, 2, 3]);
    storage.completeMultipartUpload.mockRejectedValueOnce(Object.assign(new Error('503'), { name: 'ServiceUnavailable' }));
    const failed = await complete(fileId);
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('STORAGE_ERROR');
    expect(db.files.get(fileId).status).toBe('uploading'); // not stuck in 'completing', not 'failed'
    expect((await complete(fileId)).body.data.status).toBe('complete');
  });

  it('treats NoSuchUpload as success when an earlier attempt already merged the object', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [1, 2, 3]);
    storage.completeMultipartUpload.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NoSuchUpload' }));
    storage.getObjectSize.mockResolvedValueOnce(CHUNK_SIZE_BYTES * 2 + 10);
    expect((await complete(fileId)).body.data.status).toBe('complete');
  });

  it('maps storage rejecting the ETags to a 400', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [1, 2, 3]);
    storage.completeMultipartUpload.mockRejectedValueOnce(Object.assign(new Error('bad'), { name: 'InvalidPart' }));
    const res = await complete(fileId);
    expect(res.body.error.code).toBe('INVALID_PARTS');
    expect(db.files.get(fileId).status).toBe('uploading');
  });

  it('stops handing out part URLs once the upload is complete', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [1, 2, 3]);
    await complete(fileId);
    expect((await as(ALICE, request(app).get(`/uploads/${fileId}/parts/1`))).status).toBe(409);
  });
});

describe('what the UI needs for upload and resume', () => {
  it('init returns the content type the presigned single PUT was signed with', async () => {
    const res = await init({ filename: 'cat.png', sizeBytes: 1000, contentType: 'IMAGE/PNG' });
    expect(res.body.data).toMatchObject({ strategy: 'single', contentType: 'image/png' });
    expect(storage.getPresignedUploadUrl).toHaveBeenCalledWith(expect.any(String), 'image/png');
  });

  it('status lists stored parts with their ETags, so a resumed upload can complete', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [3, 1]);
    const res = await as(ALICE, request(app).get(`/uploads/${fileId}/status`));
    expect(res.body.data).toMatchObject({
      strategy: 'chunked',
      chunkSizeBytes: CHUNK_SIZE_BYTES,
      totalParts: 3,
      uploadedParts: [{ partNumber: 1, etag: '"etag-1"' }, { partNumber: 3, etag: '"etag-3"' }],
      remainingPartNumbers: [2],
    });
    expect(res.body.data.uploadUrl).toBeUndefined();
  });

  it('status hands an unfinished single-PUT upload a fresh URL to retry with', async () => {
    const fileId = await initSingle();
    storage.getPresignedUploadUrl.mockClear();
    const res = await as(ALICE, request(app).get(`/uploads/${fileId}/status`));
    expect(res.body.data).toMatchObject({ strategy: 'single', totalParts: 1, uploadUrl: 'https://storage.test/put', contentType: 'image/png' });
    expect(storage.getPresignedUploadUrl).toHaveBeenCalledTimes(1);
  });
});

describe('abort and delete', () => {
  it('abort frees the stored parts and closes the upload', async () => {
    const fileId = await initChunked();
    const res = await as(ALICE, request(app).post(`/uploads/${fileId}/abort`));
    expect(res.body.data.status).toBe('aborted');
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(expect.any(String), 'mpu-1');
    expect(db.files.get(fileId).status).toBe('failed');
  });

  it('delete removes the original, its thumbnail and its replica, then the row', async () => {
    const fileId = await initSingle();
    const key = db.files.get(fileId).storage_key;
    await as(ALICE, request(app).delete(`/files/${fileId}`));
    const deleted = storage.deleteObject.mock.calls.map(c => c[0]);
    expect(deleted).toEqual(expect.arrayContaining([key, `thumbnails/${fileId}.jpg`, `replica/${key}`]));
    expect(db.files.has(fileId)).toBe(false);
  });

  it('delete aborts a half-finished chunked upload so storage stops billing for its parts', async () => {
    const fileId = await initChunked();
    await as(ALICE, request(app).delete(`/files/${fileId}`));
    expect(storage.abortMultipartUpload).toHaveBeenCalled();
  });

  it('delete keeps the row when storage fails, so it can be retried', async () => {
    const fileId = await initSingle();
    storage.deleteObject.mockRejectedValueOnce(new Error('storage down'));
    const res = await as(ALICE, request(app).delete(`/files/${fileId}`));
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: expect.any(String), requestId: expect.any(String) });
    expect(db.files.has(fileId)).toBe(true);
  });
});
