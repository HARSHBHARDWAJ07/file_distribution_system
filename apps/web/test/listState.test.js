import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listReducer, initialListState, unfinished, stored } from '../lib/listState.js';

const file = (id, status = 'complete') => ({ id, status, filename: id });

test('a first page loads into a ready list', () => {
  const s = listReducer(initialListState, { type: 'loaded', items: [file('a')], nextCursor: 'c1' });
  assert.equal(s.status, 'ready');
  assert.equal(s.nextCursor, 'c1');
});

test('a failed first load is an error state; a failed "load more" keeps the list', () => {
  const failed = listReducer(initialListState, { type: 'failed', error: { code: 'NETWORK_ERROR' } });
  assert.equal(failed.status, 'error');

  let s = listReducer(initialListState, { type: 'loaded', items: [file('a')], nextCursor: 'c1' });
  s = listReducer(s, { type: 'loadMore' });
  s = listReducer(s, { type: 'loadMoreFailed', error: { code: 'NETWORK_ERROR' } });
  assert.equal(s.status, 'ready');
  assert.equal(s.items.length, 1);
  assert.ok(s.moreError);
});

test('load more appends without duplicating rows that shifted between pages', () => {
  let s = listReducer(initialListState, { type: 'loaded', items: [file('b'), file('a')], nextCursor: 'c' });
  s = listReducer(s, { type: 'loadedMore', items: [file('a'), file('z')], nextCursor: null });
  assert.deepEqual(s.items.map(f => f.id), ['b', 'a', 'z']);
});

test('a finished upload merges at the top and updates rows already shown', () => {
  let s = listReducer(initialListState, { type: 'loaded', items: [file('a', 'uploading'), file('old')], nextCursor: null });
  s = listReducer(s, { type: 'mergeHead', items: [file('new'), file('a', 'complete')] });
  assert.deepEqual(s.items.map(f => [f.id, f.status]), [['new', 'complete'], ['a', 'complete'], ['old', 'complete']]);
});

test('delete removes the row; unfinished and stored files are told apart', () => {
  let s = listReducer(initialListState, { type: 'loaded', items: [file('a'), file('b', 'uploading')], nextCursor: null });
  assert.deepEqual(unfinished(s.items).map(f => f.id), ['b']);
  assert.deepEqual(stored(s.items).map(f => f.id), ['a']);
  s = listReducer(s, { type: 'removed', id: 'a' });
  assert.deepEqual(s.items.map(f => f.id), ['b']);
});
