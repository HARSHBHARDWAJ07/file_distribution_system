// HTTP-level edge cases for the file-service, with Postgres, storage and the
// queue replaced by in-memory fakes so this runs in CI with no infra.
const crypto = require('crypto');
const request = require('supertest');

jest.mock('../lib/db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../lib/storage', () => ({
  buildKey: jest.fn((owner, name) => `users/${owner}/1-${name}`),
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
const { CHUNK_SIZE_BYTES, MAX_UPLOAD_BYTES } = require('../lib/chunking');

const TOKEN = 'test-internal-token';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

// Just enough of Postgres for the queries these routes run.
function fakeDb() {
  const files = new Map();
  const parts = new Map(); // fileId -> Map(partNumber -> etag)
  pool.query.mockImplementation(async (sql, p = []) => {
    if (sql.startsWith('SELECT * FROM files')) return { rows: files.has(p[0]) ? [{ ...files.get(p[0]) }] : [] };
    if (sql.includes('INSERT INTO files')) {
      const id = crypto.randomUUID();
      files.set(id, { id, owner_id: p[0], filename: p[1], size_bytes: String(p[2]), storage_key: p[3],
        status: 'uploading', content_type: p[4], upload_id: null });
      return { rows: [{ id }] };
    }
    if (sql.startsWith('UPDATE files SET upload_id')) { files.get(p[1]).upload_id = p[0]; return { rowCount: 1 }; }
    if (sql.includes("SET status = 'complete'")) {
      const f = files.get(p[0]);
      if (!f || f.status !== 'uploading') return { rowCount: 0 };
      f.status = 'complete';
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

async function initSingle(overrides = {}) {
  const res = await init({ filename: 'cat.png', sizeBytes: 1000, contentType: 'image/png', ...overrides });
  return res.body.data.fileId;
}
async function initChunked(sizeBytes = CHUNK_SIZE_BYTES * 2 + 10) { // 3 parts
  const res = await init({ filename: 'big.bin', sizeBytes });
  return res.body.data.fileId;
}

describe('gateway-only access (the x-user-id bypass)', () => {
  it('rejects a request with no internal token even if it names a real user', async () => {
    const res = await request(app).post('/uploads/init').set('x-user-id', ALICE)
      .send({ filename: 'a.txt', sizeBytes: 10 });
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

describe('input validation', () => {
  it.each([
    ['missing filename', { sizeBytes: 10 }],
    ['blank filename', { filename: '   ', sizeBytes: 10 }],
    ['size as a string', { filename: 'a', sizeBytes: '10' }],
    ['fractional size', { filename: 'a', sizeBytes: 10.5 }],
    ['zero size', { filename: 'a', sizeBytes: 0 }],
    ['size over the cap', { filename: 'a', sizeBytes: MAX_UPLOAD_BYTES + 1 }],
    ['malformed content type', { filename: 'a', sizeBytes: 10, contentType: 'png' }],
  ])('init rejects %s with 400', async (_, body) => {
    const res = await init(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('stores the content type lower-cased so the worker matches it exactly', async () => {
    const fileId = await initSingle({ contentType: 'IMAGE/PNG' });
    expect(db.files.get(fileId).content_type).toBe('image/png');
  });

  it('answers malformed JSON with a 400 envelope, not an HTML error page', async () => {
    const res = await as(ALICE, request(app).post('/uploads/init'))
      .set('Content-Type', 'application/json').send('{"filename": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('treats a non-UUID file id as not found instead of crashing with a 500', async () => {
    const res = await as(ALICE, request(app).get('/files/not-a-uuid/download'));
    expect(res.status).toBe(404);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each(['0', 'abc', '10001'])('rejects part number %s with 400', async partNumber => {
    const fileId = await initChunked();
    const res = await as(ALICE, request(app).get(`/uploads/${fileId}/parts/${partNumber}`));
    expect(res.status).toBe(400);
  });

  it('rejects a part number beyond what the file size needs', async () => {
    const fileId = await initChunked(); // 3 parts
    const res = await as(ALICE, request(app).get(`/uploads/${fileId}/parts/4`));
    expect(res.status).toBe(400);
  });
});

describe('ownership', () => {
  it("forbids another user from downloading, completing or deleting someone's file", async () => {
    const fileId = await initSingle();
    for (const req of [
      request(app).get(`/files/${fileId}/download`),
      request(app).post(`/uploads/${fileId}/complete`),
      request(app).delete(`/files/${fileId}`),
    ]) {
      expect((await as(BOB, req)).status).toBe(403);
    }
    expect(db.files.has(fileId)).toBe(true);
  });
});

describe('completing a single-shot upload', () => {
  it('refuses to complete when nothing was uploaded to storage', async () => {
    const fileId = await initSingle();
    storage.getObjectSize.mockResolvedValueOnce(null);
    const res = await as(ALICE, request(app).post(`/uploads/${fileId}/complete`));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UPLOAD_INCOMPLETE');
    expect(db.files.get(fileId).status).toBe('uploading');
    expect(enqueueFileUploaded).not.toHaveBeenCalled();
  });

  it('refuses to complete when the stored size differs from the declared size', async () => {
    const fileId = await initSingle({ sizeBytes: 1000 });
    storage.getObjectSize.mockResolvedValueOnce(999);
    const res = await as(ALICE, request(app).post(`/uploads/${fileId}/complete`));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SIZE_MISMATCH');
  });

  it('completes and enqueues exactly one job when the object is there', async () => {
    const fileId = await initSingle({ sizeBytes: 1000 });
    storage.getObjectSize.mockResolvedValueOnce(1000);
    const res = await as(ALICE, request(app).post(`/uploads/${fileId}/complete`));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ fileId, status: 'complete' });
    expect(enqueueFileUploaded).toHaveBeenCalledTimes(1);
    expect(enqueueFileUploaded).toHaveBeenCalledWith(expect.objectContaining({ fileId, contentType: 'image/png' }));
  });

  it('a retried complete is idempotent and re-enqueues in case the first enqueue was lost', async () => {
    const fileId = await initSingle({ sizeBytes: 1000 });
    storage.getObjectSize.mockResolvedValue(1000);
    await as(ALICE, request(app).post(`/uploads/${fileId}/complete`));
    const retry = await as(ALICE, request(app).post(`/uploads/${fileId}/complete`));
    expect(retry.status).toBe(200);
    expect(retry.body.data.alreadyCompleted).toBe(true);
    expect(enqueueFileUploaded).toHaveBeenCalledTimes(2); // queue's singletonKey + planWork make this harmless
    expect(storage.getObjectSize).toHaveBeenCalledTimes(1); // no storage work the second time
  });
});

describe('completing a chunked upload', () => {
  async function recordParts(fileId, numbers) {
    for (const n of numbers) {
      await as(ALICE, request(app).post(`/uploads/${fileId}/parts/${n}`)).send({ etag: `"etag-${n}"` });
    }
  }

  it('reports which parts are missing instead of asking storage to assemble a partial file', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [1, 3]);
    const res = await as(ALICE, request(app).post(`/uploads/${fileId}/complete`)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/missing: 2/);
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('falls back to the server-recorded parts when the client sends none', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [3, 1, 2]);
    const res = await as(ALICE, request(app).post(`/uploads/${fileId}/complete`)).send({});
    expect(res.status).toBe(200);
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(expect.any(String), 'mpu-1', [
      { PartNumber: 1, ETag: '"etag-1"' }, { PartNumber: 2, ETag: '"etag-2"' }, { PartNumber: 3, ETag: '"etag-3"' },
    ]);
  });

  it('rejects a client part list with duplicates', async () => {
    const fileId = await initChunked();
    const parts = [1, 2, 2, 3].map(n => ({ PartNumber: n, ETag: `"e${n}"` }));
    const res = await as(ALICE, request(app).post(`/uploads/${fileId}/complete`)).send({ parts });
    expect(res.status).toBe(409);
  });

  it('a complete that lost a race to a concurrent one reports success, not a 500', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [1, 2, 3]);
    storage.completeMultipartUpload.mockImplementationOnce(async () => {
      db.files.get(fileId).status = 'complete'; // the other request finished first
      throw Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
    });
    const res = await as(ALICE, request(app).post(`/uploads/${fileId}/complete`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.alreadyCompleted).toBe(true);
  });

  it('maps storage rejecting the ETags to a 400', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [1, 2, 3]);
    storage.completeMultipartUpload.mockRejectedValueOnce(Object.assign(new Error('bad'), { name: 'InvalidPart' }));
    const res = await as(ALICE, request(app).post(`/uploads/${fileId}/complete`)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PARTS');
  });

  it('stops handing out part URLs once the upload is complete', async () => {
    const fileId = await initChunked();
    await recordParts(fileId, [1, 2, 3]);
    await as(ALICE, request(app).post(`/uploads/${fileId}/complete`)).send({});
    const res = await as(ALICE, request(app).get(`/uploads/${fileId}/parts/1`));
    expect(res.status).toBe(409);
  });
});

describe('deleting a file', () => {
  it('removes the original, its thumbnail and its replica, then the row', async () => {
    const fileId = await initSingle();
    const key = db.files.get(fileId).storage_key;
    const res = await as(ALICE, request(app).delete(`/files/${fileId}`));
    expect(res.status).toBe(200);
    const deleted = storage.deleteObject.mock.calls.map(c => c[0]);
    expect(deleted).toEqual(expect.arrayContaining([key, `thumbnails/${fileId}.jpg`, `replica/${key}`]));
    expect(db.files.has(fileId)).toBe(false);
  });

  it('aborts an unfinished chunked upload so its stored parts are freed', async () => {
    const fileId = await initChunked();
    await as(ALICE, request(app).delete(`/files/${fileId}`));
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(expect.any(String), 'mpu-1');
  });

  it('keeps the row when storage deletion fails, so the delete can be retried', async () => {
    const fileId = await initSingle();
    storage.deleteObject.mockRejectedValueOnce(new Error('storage down'));
    const res = await as(ALICE, request(app).delete(`/files/${fileId}`));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(db.files.has(fileId)).toBe(true);
  });
});
