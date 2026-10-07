import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUploadManager } from '../lib/uploadManager.js';
import { fakeFile } from './helpers.js';

const MB = 1024 * 1024;

// An uploadFile stand-in the test drives by hand: each call waits until the
// test resolves or rejects it.
function controllableUploads() {
  const runs = [];
  const uploadFile = opts => new Promise((resolve, reject) => {
    const run = { opts, resolve, reject };
    opts.onEvent({ type: 'plan', fileId: `file-${runs.length + 1}`, strategy: 'chunked', sizes: [opts.file.size], doneParts: [] });
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })));
    runs.push(run);
  });
  return { runs, uploadFile };
}

function setup() {
  const uploads = controllableUploads();
  const aborted = [];
  const stored = [];
  const manager = createUploadManager({
    api: { abort: async id => aborted.push(id) },
    putBlob: null,
    maxBytes: 100 * MB,
    uploadFile: uploads.uploadFile,
    onStored: id => stored.push(id),
    setTimer: () => {},
  });
  return { manager, ...uploads, aborted, stored };
}

const tick = () => new Promise(r => setTimeout(r, 0));

test('rejects empty and oversized files by name, before any network call', () => {
  const { manager, runs } = setup();
  const { rejected } = manager.add([fakeFile('empty.txt', 0), fakeFile('huge.iso', 200 * MB)]);
  assert.equal(runs.length, 0);
  assert.match(rejected[0].reason, /"empty\.txt" is empty/);
  assert.match(rejected[1].reason, /"huge\.iso" is 200 MB\. Files can be up to 100 MB/);
});

test('uploads at most 2 files at a time; the third waits its turn', async () => {
  const { manager, runs } = setup();
  manager.add([fakeFile('a', 10), fakeFile('b', 10), fakeFile('c', 10)]);
  assert.equal(runs.length, 2);
  assert.equal(manager.getSnapshot()[2].state, 'queued');
  runs[0].resolve();
  await tick();
  assert.equal(runs.length, 3);
});

test('cancel aborts the transfer, frees storage via the API, and removes the row', async () => {
  const { manager, runs, aborted } = setup();
  manager.add([fakeFile('a', 10)]);
  const id = manager.getSnapshot()[0].id;
  await manager.cancel(id);
  assert.equal(runs[0].opts.signal.aborted, true);
  assert.deepEqual(aborted, ['file-1']);
  assert.equal(manager.getSnapshot().length, 0);
  assert.equal(manager.hasActive(), false);
});

test('a failed upload keeps its row with the error; Retry resumes the same server upload', async () => {
  const { manager, runs } = setup();
  manager.add([fakeFile('a', 10)]);
  runs[0].reject(Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }));
  await tick();
  const [row] = manager.getSnapshot();
  assert.equal(row.state, 'failed');
  assert.equal(row.error.code, 'NETWORK_ERROR');

  manager.retry(row.id);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].opts.resumeFileId, 'file-1');
});

test('resume refuses a different file, naming the one it needs', () => {
  const { manager, runs } = setup();
  const row = { id: 'file-9', filename: 'video.mp4', sizeBytes: 12 * MB };
  const { error } = manager.resume(row, fakeFile('video.mp4', 11 * MB));
  assert.match(error, /To resume, choose "video\.mp4" \(12\.0 MB\)/);
  assert.equal(runs.length, 0);
});

test('resume with the same file continues the stored upload', () => {
  const { manager, runs } = setup();
  const row = { id: 'file-9', filename: 'video.mp4', sizeBytes: 12 * MB };
  assert.equal(manager.resume(row, fakeFile('video.mp4', 12 * MB)).error, null);
  assert.equal(runs[0].opts.resumeFileId, 'file-9');
});

test('a finished upload notifies the list and counts as no longer active', async () => {
  const { manager, runs, stored } = setup();
  manager.add([fakeFile('a', 10)]);
  assert.equal(manager.hasActive(), true);
  runs[0].resolve();
  await tick();
  assert.deepEqual(stored, ['file-1']);
  assert.equal(manager.getSnapshot()[0].state, 'done');
  assert.equal(manager.hasActive(), false);
});

test('snapshots are stable between changes (safe for React state)', () => {
  const { manager } = setup();
  manager.add([fakeFile('a', 10)]);
  assert.equal(manager.getSnapshot(), manager.getSnapshot());
});
