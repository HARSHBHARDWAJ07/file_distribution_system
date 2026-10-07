import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatWhen, progressPercent, describeError } from '../lib/format.js';

test('formats sizes with one decimal under 100', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(12 * 1024 * 1024), '12.0 MB');
  assert.equal(formatBytes(150 * 1024 * 1024), '150 MB');
});

test('formats times relative to now', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(formatWhen('2026-10-07T11:59:40Z', now), 'just now');
  assert.equal(formatWhen('2026-10-07T11:45:00Z', now), '15 min ago');
  assert.equal(formatWhen('2026-10-07T09:00:00Z', now), '3 h ago');
});

test('never shows 100% before the server confirms the upload', () => {
  assert.equal(progressPercent({ state: 'completing', loaded: 100, total: 100 }), 99);
  assert.equal(progressPercent({ state: 'uploading', loaded: 50, total: 100 }), 50);
  assert.equal(progressPercent({ state: 'done', loaded: 100, total: 100 }), 100);
});

test('describes errors with a reference id when the server gave one', () => {
  assert.deepEqual(describeError({ code: 'NETWORK_ERROR' }).message, "Can't reach the server. Check your connection, then try again.");
  assert.deepEqual(describeError({ code: 'X', message: 'cannot complete: missing part(s) 2', requestId: 'r-9' }),
    { message: 'cannot complete: missing part(s) 2', requestId: 'r-9' });
});
