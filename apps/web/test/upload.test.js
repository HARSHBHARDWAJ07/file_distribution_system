import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadFile, backoffDelay, StorageError, MB, MAX_ATTEMPTS } from '../lib/upload.js';
import { ApiError } from '../lib/api.js';
import { fakeFile, fakeApi, fakePut, noSleep } from './helpers.js';

test('a file of 5 MB or less goes up as one PUT with the signed Content-Type, then completes', async () => {
  const file = fakeFile('cat.png', 2 * MB, 'image/png');
  const api = fakeApi({ file });
  const put = fakePut();
  const events = [];
  await uploadFile({ file, api, putBlob: put, sleep: noSleep, onEvent: e => events.push(e.type) });

  assert.equal(put.calls.length, 1);
  assert.equal(put.calls[0].contentType, 'image/png');
  assert.equal(api.calls.complete, 1);
  assert.deepEqual(events.filter(t => t !== 'part'), ['plan', 'completing', 'done']);
});

test('a 12 MB file goes up as 3 parts (5, 5, 2 MB), each receipt recorded, then completes', async () => {
  const file = fakeFile('video.mp4', 12 * MB);
  const api = fakeApi({ file });
  const put = fakePut();
  let plan;
  await uploadFile({ file, api, putBlob: put, sleep: noSleep, onEvent: e => { if (e.type === 'plan') plan = e; } });

  assert.deepEqual(plan.sizes, [5 * MB, 5 * MB, 2 * MB]);
  assert.deepEqual(put.calls.map(c => c.size).sort((a, b) => a - b), [2 * MB, 5 * MB, 5 * MB]);
  assert.deepEqual(api.calls.record.map(([n]) => n).sort(), [1, 2, 3]);
  assert.equal(api.calls.complete, 1);
});

test('never more than 3 parts in flight at once', async () => {
  const file = fakeFile('big.bin', 40 * MB); // 8 parts
  const put = fakePut();
  await uploadFile({ file, api: fakeApi({ file }), putBlob: put, sleep: noSleep });
  assert.equal(put.calls.length, 8);
  assert.equal(put.peak, 3);
});

test('a failing part is retried with backoff and a fresh URL every attempt', async () => {
  const file = fakeFile('big.bin', 12 * MB);
  const api = fakeApi({ file });
  let part2Failures = 0;
  const put = fakePut({ fail: url => (url.startsWith('put://part/2/') && part2Failures++ < 2 ? new StorageError(0) : null) });
  const waits = [];
  await uploadFile({ file, api, putBlob: put, sleep: async ms => waits.push(ms), random: () => 0.5 });

  const urlsForPart2 = put.calls.filter(c => c.url.startsWith('put://part/2/')).map(c => c.url);
  assert.equal(urlsForPart2.length, 3);
  assert.equal(new Set(urlsForPart2).size, 3, 'each attempt used a new URL');
  assert.deepEqual(waits, [backoffDelay(1, () => 0.5), backoffDelay(2, () => 0.5)]);
  assert.equal(api.calls.complete, 1);
});

test('after 4 failed attempts the upload fails, siblings stop, and complete is never called', async () => {
  const file = fakeFile('big.bin', 40 * MB);
  const api = fakeApi({ file });
  const put = fakePut({ fail: url => (url.startsWith('put://part/1/') ? new StorageError(503) : null) });
  await assert.rejects(uploadFile({ file, api, putBlob: put, sleep: noSleep }), StorageError);
  assert.equal(put.calls.filter(c => c.url.startsWith('put://part/1/')).length, MAX_ATTEMPTS);
  assert.ok(put.calls.length < 8 + MAX_ATTEMPTS, 'remaining parts were not all sent');
  assert.equal(api.calls.complete, 0);
});

test('a non-retryable API error fails at once', async () => {
  const file = fakeFile('big.bin', 12 * MB);
  const api = fakeApi({ file });
  api.getPartUrl = async () => { throw new ApiError({ status: 409, code: 'UPLOAD_NOT_IN_PROGRESS', message: 'upload is failed' }); };
  const put = fakePut();
  await assert.rejects(uploadFile({ file, api, putBlob: put, sleep: noSleep }), { code: 'UPLOAD_NOT_IN_PROGRESS' });
  assert.equal(put.calls.length, 0);
});

test('a hidden ETag (bucket CORS) fails immediately with a clear code instead of retrying', async () => {
  const file = fakeFile('big.bin', 12 * MB);
  const put = fakePut({ etag: () => null });
  await assert.rejects(uploadFile({ file, api: fakeApi({ file }), putBlob: put, sleep: noSleep }), { code: 'ETAG_HIDDEN' });
  assert.ok(put.calls.length <= 3, 'no retries');
});

test('a 429 waits the Retry-After the server asked for', async () => {
  const file = fakeFile('big.bin', 12 * MB);
  const api = fakeApi({ file });
  const original = api.getPartUrl;
  let limited = false;
  api.getPartUrl = async (...args) => {
    if (!limited) { limited = true; throw new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfter: 7 }); }
    return original(...args);
  };
  const waits = [];
  await uploadFile({ file, api, putBlob: fakePut(), sleep: async ms => waits.push(ms) });
  assert.deepEqual(waits, [7000]);
});

test('resume uploads only the parts storage does not already hold', async () => {
  const file = fakeFile('big.bin', 12 * MB);
  const api = fakeApi({ file, uploadedParts: [{ partNumber: 1, etag: '"a"' }, { partNumber: 3, etag: '"c"' }] });
  const put = fakePut();
  let plan;
  await uploadFile({ file, api, putBlob: put, resumeFileId: 'f1', sleep: noSleep, onEvent: e => { if (e.type === 'plan') plan = e; } });

  assert.equal(api.calls.init, 0, 'no new upload started');
  assert.deepEqual(plan.doneParts, [1, 3]);
  assert.deepEqual(api.calls.partUrl, [2]);
  assert.equal(put.calls.length, 1);
  assert.equal(api.calls.complete, 1);
});

test('resume with a different file is refused before any bytes move', async () => {
  const original = fakeFile('big.bin', 12 * MB);
  const api = fakeApi({ file: original });
  const put = fakePut();
  const other = fakeFile('big.bin', 12 * MB - 1);
  await assert.rejects(uploadFile({ file: other, api, putBlob: put, resumeFileId: 'f1', sleep: noSleep }), { code: 'RESUME_MISMATCH' });
  assert.equal(put.calls.length, 0);
});

test('resuming a single-PUT upload uses the fresh URL from the status endpoint', async () => {
  const file = fakeFile('small.txt', 1000, 'text/plain');
  const api = fakeApi({ file });
  const put = fakePut();
  await uploadFile({ file, api, putBlob: put, resumeFileId: 'f1', sleep: noSleep });
  assert.equal(put.calls[0].url, 'put://single/2');
  assert.equal(put.calls[0].contentType, 'text/plain');
});

test('cancel aborts in-flight parts and never completes', async () => {
  const file = fakeFile('big.bin', 40 * MB);
  const api = fakeApi({ file });
  const controller = new AbortController();
  const put = async (url, blob, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })));
    setTimeout(() => controller.abort(), 5);
  });
  await assert.rejects(uploadFile({ file, api, putBlob: put, signal: controller.signal, sleep: noSleep }), { name: 'AbortError' });
  assert.equal(api.calls.complete, 0);
});

test('backoff doubles from 500 ms, is capped at 8 s, and always waits at least half the step', () => {
  assert.equal(backoffDelay(1, () => 0), 250);
  assert.equal(backoffDelay(1, () => 1), 500);
  assert.equal(backoffDelay(2, () => 1), 1000);
  assert.equal(backoffDelay(3, () => 1), 2000);
  assert.equal(backoffDelay(10, () => 1), 8000);
  assert.equal(backoffDelay(10, () => 0), 4000);
});

test('if storage rejects the recorded receipts, every part is sent again once, then completes', async () => {
  const file = fakeFile('big.bin', 12 * MB);
  const api = fakeApi({ file, uploadedParts: [1, 2, 3].map(n => ({ partNumber: n, etag: '"None"' })) });
  let completes = 0;
  api.complete = async () => {
    if (++completes === 1) throw new ApiError({ status: 400, code: 'INVALID_PARTS', message: 'bad receipts' });
    return { status: 'complete' };
  };
  const put = fakePut();
  await uploadFile({ file, api, putBlob: put, resumeFileId: 'f1', sleep: noSleep });
  assert.equal(put.calls.length, 3, 'all three parts re-sent');
  assert.equal(completes, 2);
});

test('a second INVALID_PARTS is surfaced instead of looping', async () => {
  const file = fakeFile('big.bin', 12 * MB);
  const api = fakeApi({ file });
  api.complete = async () => { throw new ApiError({ status: 400, code: 'INVALID_PARTS', message: 'bad receipts' }); };
  const put = fakePut();
  await assert.rejects(uploadFile({ file, api, putBlob: put, sleep: noSleep }), { code: 'INVALID_PARTS' });
  assert.equal(put.calls.length, 6, 'one re-send, not endless');
});
