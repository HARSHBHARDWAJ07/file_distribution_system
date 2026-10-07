import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError } from '../lib/api.js';
import { createTokenStore } from '../lib/tokenStore.js';

// A fake gateway: `handlers[path](body, headers)` -> [status, payload, headers]
function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    const path = url.replace('http://api.test', '');
    calls.push({ path, auth: init.headers.Authorization });
    const handler = handlers[path.split('?')[0]];
    if (!handler) throw new TypeError('fetch failed');
    const [status, payload, headers = {}] = await handler(init.body ? JSON.parse(init.body) : undefined, init.headers);
    return {
      ok: status < 400,
      status,
      headers: { get: k => headers[k.toLowerCase()] ?? null },
      json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
    };
  };
  impl.calls = calls;
  return impl;
}

const memoryStorage = () => {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
};

function setup(handlers, { access = 'access-1', refresh = 'refresh-1' } = {}) {
  const tokens = createTokenStore(memoryStorage());
  tokens.setTokens({ accessToken: access, refreshToken: refresh });
  const fetchImpl = fakeFetch(handlers);
  let lost = 0;
  const api = createApi({ baseUrl: 'http://api.test', tokens, fetchImpl, onSessionLost: () => lost++ });
  return { api, tokens, fetchImpl, lost: () => lost };
}

const expired = [401, { success: false, error: { code: 'TOKEN_EXPIRED', message: 'expired', requestId: 'r1' } }];

test('attaches the access token and returns the data', async () => {
  const { api, fetchImpl } = setup({ '/api/me': () => [200, { success: true, data: { user: { id: 'u' } } }] });
  assert.deepEqual(await api.me(), { user: { id: 'u' } });
  assert.equal(fetchImpl.calls[0].auth, 'Bearer access-1');
});

test('turns an error envelope into ApiError with code and request id', async () => {
  const { api } = setup({
    '/api/files': () => [404, { success: false, error: { code: 'FILE_NOT_FOUND', message: 'no such file', requestId: 'req-42' } }],
  });
  await assert.rejects(api.listFiles(), err => err instanceof ApiError
    && err.code === 'FILE_NOT_FOUND' && err.requestId === 'req-42' && err.status === 404);
});

test('on TOKEN_EXPIRED it refreshes once and retries the request', async () => {
  let n = 0;
  const { api, tokens } = setup({
    '/api/me': (b, headers) => (headers.Authorization === 'Bearer access-2' ? [200, { success: true, data: 'ok' }] : expired),
    '/api/auth/refresh': body => { n++; assert.equal(body.refreshToken, 'refresh-1'); return [200, { success: true, data: { accessToken: 'access-2', refreshToken: 'refresh-2' } }]; },
  });
  assert.equal(await api.me(), 'ok');
  assert.equal(n, 1);
  assert.equal(tokens.getRefresh(), 'refresh-2', 'rotated refresh token stored');
});

test('parallel requests share one refresh (refresh tokens rotate, so two would collide)', async () => {
  let refreshes = 0;
  const { api } = setup({
    '/api/me': (b, headers) => (headers.Authorization === 'Bearer access-2' ? [200, { success: true, data: 'ok' }] : expired),
    '/api/auth/refresh': async () => { refreshes++; await new Promise(r => setTimeout(r, 10)); return [200, { success: true, data: { accessToken: 'access-2', refreshToken: 'refresh-2' } }]; },
  });
  const results = await Promise.all([api.me(), api.me(), api.me()]);
  assert.deepEqual(results, ['ok', 'ok', 'ok']);
  assert.equal(refreshes, 1);
});

test('after a reload (no access token) it refreshes before the first call', async () => {
  const { api, fetchImpl } = setup({
    '/api/me': () => [200, { success: true, data: 'ok' }],
    '/api/auth/refresh': () => [200, { success: true, data: { accessToken: 'access-9', refreshToken: 'refresh-9' } }],
  }, { access: null });
  assert.equal(await api.me(), 'ok');
  assert.deepEqual(fetchImpl.calls.map(c => c.path), ['/api/auth/refresh', '/api/me']);
});

test('a rejected refresh ends the session: tokens cleared, listeners told', async () => {
  const { api, tokens, lost } = setup({
    '/api/me': () => expired,
    '/api/auth/refresh': () => [401, { success: false, error: { code: 'INVALID_REFRESH_TOKEN', message: 'used' } }],
  });
  await assert.rejects(api.me(), { code: 'SESSION_EXPIRED' });
  assert.equal(tokens.getRefresh(), null);
  assert.equal(lost(), 1);
});

test('a network failure becomes NETWORK_ERROR (retryable) and a non-JSON reply BAD_RESPONSE', async () => {
  const { api } = setup({ '/api/files/x/download': () => [502, '<html>'] });
  await assert.rejects(api.me(), err => err.code === 'NETWORK_ERROR' && err.retryable);
  await assert.rejects(api.request('GET', '/api/files/x/download'), { code: 'BAD_RESPONSE' });
});

test('reads Retry-After on a 429', async () => {
  const { api } = setup({
    '/api/me': () => [429, { success: false, error: { code: 'RATE_LIMITED', message: 'slow' } }, { 'retry-after': '12' }],
  });
  await assert.rejects(api.me(), err => err.retryAfter === 12 && err.retryable);
});
