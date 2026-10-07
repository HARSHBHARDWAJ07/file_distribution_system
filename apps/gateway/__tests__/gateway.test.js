// Gateway edge cases against a real local stand-in for both upstream
// services, so forwarding (headers, paths, bodies, failures) is exercised for real.
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createLogger } = require('@cloudstore/logger');
const { createApp } = require('../app');
const { memoryStore, fixedWindowMemoryStore } = require('../lib/rateLimit');

const SECRET = 'test-jwt-secret';
const INTERNAL = 'test-internal-token';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const FILE_ID = '33333333-3333-4333-8333-333333333333';

let upstream;
let upstreamUrl;
let seen; // what the stand-in upstream received
let reply; // what it answers with: (req, res) => void

beforeAll(done => {
  const fake = express();
  fake.use(express.json());
  fake.all('*', (req, res) => {
    seen = { method: req.method, path: req.originalUrl, headers: req.headers, body: req.body };
    reply(req, res);
  });
  upstream = fake.listen(0, () => {
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
    done();
  });
});
afterAll(done => { upstream.close(done); });

function makeApp(overrides = {}) {
  return createApp({
    logger: createLogger('gateway-test'),
    authServiceUrl: upstreamUrl,
    fileServiceUrl: upstreamUrl,
    jwtSecret: SECRET,
    internalToken: INTERNAL,
    allowedOrigins: ['https://app.example.com'],
    rateLimitStore: memoryStore(),
    ...overrides,
  });
}

let app;
beforeEach(() => {
  seen = null;
  reply = (req, res) => res.json({ success: true, data: { ok: true } });
  app = makeApp();
});

const token = (claims = { sub: USER_ID, email: 'a@test.dev' }, opts = { expiresIn: '15m' }) => jwt.sign(claims, SECRET, opts);
const authed = (req, t = token()) => req.set('Authorization', `Bearer ${t}`);

describe('identity forwarded to the file-service', () => {
  it('sends the verified user id and the internal token', async () => {
    await authed(request(app).get(`/api/files/${FILE_ID}/download`));
    expect(seen.headers['x-user-id']).toBe(USER_ID);
    expect(seen.headers['x-internal-token']).toBe(INTERNAL);
  });

  it('never passes through identity headers a client tries to smuggle in', async () => {
    await authed(request(app).get(`/api/files/${FILE_ID}/download`))
      .set('x-user-id', 'victim').set('x-internal-token', 'forged');
    expect(seen.headers['x-user-id']).toBe(USER_ID);
    expect(seen.headers['x-internal-token']).toBe(INTERNAL);
  });

  it('does not send the internal token to the auth-service', async () => {
    await request(app).post('/api/auth/login').send({ email: 'a', password: 'b' });
    expect(seen.headers['x-internal-token']).toBeUndefined();
    expect(seen.body).toEqual({ email: 'a', password: 'b' });
  });
});

describe('GET /api/files (dashboard list)', () => {
  it('forwards only the validated limit and cursor, never the raw query string', async () => {
    const { encodeCursor } = require('@cloudstore/validation');
    const cursor = encodeCursor('2026-10-07 06:00:00+00', FILE_ID);
    await authed(request(app).get(`/api/files?limit=5&cursor=${cursor}&owner=victim&debug=1`));
    expect(seen.path).toBe(`/files?limit=5&cursor=${cursor}`);
    expect(seen.headers['x-user-id']).toBe(USER_ID);
  });

  it('applies the default page size', async () => {
    await authed(request(app).get('/api/files'));
    expect(seen.path).toBe('/files?limit=20');
  });

  it.each(['limit=0', 'limit=500', 'limit=abc', 'cursor=%27%20OR%201%3D1'])('rejects %s with 400 before any network call', async q => {
    const res = await authed(request(app).get(`/api/files?${q}`));
    expect(res.status).toBe(400);
    expect(seen).toBeNull();
  });
});

describe('path params are validated before any network call', () => {
  it.each([
    ['a non-UUID file id', '/api/files/not-a-uuid/download'],
    ['an encoded "../" file id', '/api/files/..%2F..%2Fuploads%2Finit/download'],
    ['part number 0', `/api/files/uploads/${FILE_ID}/parts/0`],
    ['a non-numeric part number', `/api/files/uploads/${FILE_ID}/parts/abc`],
    ['a part number over 10,000', `/api/files/uploads/${FILE_ID}/parts/10001`],
  ])('rejects %s with 400', async (_, path) => {
    const res = await authed(request(app).get(path));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(seen).toBeNull();
  });
});

describe('JWT checks', () => {
  it.each([
    ['no header', r => r],
    ['a non-bearer header', r => r.set('Authorization', 'Basic abc')],
    ['garbage', r => r.set('Authorization', 'Bearer not.a.jwt')],
    ['a token signed with another secret', r => r.set('Authorization', `Bearer ${jwt.sign({ sub: USER_ID }, 'other')}`)],
    ['an unsigned alg:none token', r => r.set('Authorization', `Bearer ${jwt.sign({ sub: USER_ID }, null, { algorithm: 'none' })}`)],
    ['an HS512 token signed with the correct secret', r => r.set('Authorization', `Bearer ${jwt.sign({ sub: USER_ID }, SECRET, { algorithm: 'HS512' })}`)],
    ['a token without a subject', r => r.set('Authorization', `Bearer ${token({ email: 'x' })}`)],
  ])('rejects %s with 401 and never calls upstream', async (_, withAuth) => {
    const res = await withAuth(request(app).get(`/api/files/${FILE_ID}/download`));
    expect(res.status).toBe(401);
    expect(seen).toBeNull();
  });

  it('distinguishes an expired token (TOKEN_EXPIRED) from an invalid one', async () => {
    const expired = jwt.sign({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
    const res = await authed(request(app).get('/api/me'), expired);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    const bad = await authed(request(app).get('/api/me'), 'garbage');
    expect(bad.body.error.code).toBe('INVALID_TOKEN');
  });

  it('refuses to start without a JWT secret or internal token', () => {
    const base = { logger: createLogger('t'), authServiceUrl: 'x', fileServiceUrl: 'x' };
    expect(() => createApp({ ...base, internalToken: INTERNAL })).toThrow(/JWT_SECRET/);
    expect(() => createApp({ ...base, jwtSecret: SECRET })).toThrow(/INTERNAL_API_TOKEN/);
  });
});

describe('request ids', () => {
  it('mints one, echoes it to the client, and forwards it upstream', async () => {
    const res = await authed(request(app).get(`/api/files/${FILE_ID}/download`));
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.headers['x-request-id']).toBe(res.headers['x-request-id']);
  });

  it('includes the id in error bodies so users can quote it', async () => {
    const res = await request(app).get('/api/me').set('x-request-id', 'support-ticket-42');
    expect(res.body.error.requestId).toBe('support-ticket-42');
  });
});

describe('upstream failures', () => {
  it('passes an upstream error status and body through unchanged', async () => {
    reply = (req, res) => res.status(409).json({ success: false, error: { code: 'EMAIL_TAKEN', message: 'x' } });
    const res = await request(app).post('/api/auth/signup').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('turns a non-JSON reply (a proxy error page) into 502', async () => {
    reply = (req, res) => res.status(503).type('html').send('<html>waking up</html>');
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_BAD_RESPONSE');
  });

  it('turns a refused connection into 502', async () => {
    const down = makeApp({ authServiceUrl: 'http://127.0.0.1:1' });
    const res = await request(down).post('/api/auth/login').send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNREACHABLE');
  });

  it('turns a hung upstream into 504 instead of hanging the client', async () => {
    reply = (req, res) => setTimeout(() => res.json({}), 500);
    const slow = makeApp({ upstreamTimeoutMs: 50 });
    const res = await request(slow).post('/api/auth/login').send({});
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('UPSTREAM_TIMEOUT');
  });
});

describe('rate limiting', () => {
  const login = (a, ip = '203.0.113.1') =>
    request(a).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email: 'a@b.co', password: 'x' });

  it('allows 10 logins a minute per IP, then 429 with Retry-After', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await login(app)).status);
    expect(statuses.slice(0, 10).every(s => s === 200)).toBe(true);
    const blocked = await login(app);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('keeps separate counters per IP', async () => {
    for (let i = 0; i < 10; i++) await login(app, '203.0.113.1');
    expect((await login(app, '203.0.113.1')).status).toBe(429);
    expect((await login(app, '203.0.113.2')).status).toBe(200);
  });

  it('keeps the auth and api limiters separate', async () => {
    for (let i = 0; i < 11; i++) await login(app);
    const res = await authed(request(app).get('/api/me')).set('X-Forwarded-For', '203.0.113.1');
    expect(res.status).toBe(200);
  });

  it('limits the api per user, not per IP', async () => {
    const limited = makeApp({ limits: { auth: 10, api: 2 } });
    const other = token({ sub: '22222222-2222-4222-8222-222222222222' });
    for (let i = 0; i < 2; i++) await authed(request(limited).get('/api/me'));
    expect((await authed(request(limited).get('/api/me'))).status).toBe(429);
    expect((await authed(request(limited).get('/api/me'), other)).status).toBe(200); // same IP, other user
  });

  it('lets a client back in once the sliding window has moved past its burst', async () => {
    let now = 1_000_000;
    const clocked = makeApp({ rateLimitStore: memoryStore({ now: () => now }), limits: { auth: 1, api: 100 } });
    expect((await login(clocked)).status).toBe(200);
    expect((await login(clocked)).status).toBe(429);
    now += 121_000; // two windows: nothing from the burst overlaps the last 60s
    expect((await login(clocked)).status).toBe(200);
  });

  it('sliding vs fixed window: a burst straddling the boundary gets 2x through fixed, ~1x through sliding', async () => {
    const burst = async store => {
      let now = 59_000; // 1s before a window boundary
      const a = makeApp({ rateLimitStore: store(() => now) });
      let allowed = 0;
      for (let i = 0; i < 10; i++) if ((await login(a)).status === 200) allowed++;
      now = 61_000; // 1s after the boundary
      for (let i = 0; i < 10; i++) if ((await login(a)).status === 200) allowed++;
      return allowed;
    };
    const fixed = await burst(now => fixedWindowMemoryStore({ now }));
    const sliding = await burst(now => memoryStore({ now }));
    expect(fixed).toBe(20);       // 20 logins in two seconds: double the intended rate
    expect(sliding).toBeLessThanOrEqual(11);
  });

  it('fails open when the store is down: traffic flows, nothing crashes', async () => {
    const broken = makeApp({ rateLimitStore: { hit: async () => { throw new Error('ECONNREFUSED'); } } });
    for (let i = 0; i < 15; i++) expect((await login(broken)).status).toBe(200);
  });

  it('trusts exactly one proxy hop, so a client cannot spoof its way past the limit', async () => {
    // A client prepends a fake IP; the proxy appends the real one. Only the
    // last hop is trusted, so every attempt counts against the real IP.
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await request(app).post('/api/auth/login')
        .set('X-Forwarded-For', `10.0.0.${i}, 203.0.113.9`).send({})).status);
    }
    expect(statuses[10]).toBe(429);
  });
});

describe('redisStore', () => {
  const { redisStore } = require('../lib/rateLimit');
  function fakeRedis() {
    const data = new Map();
    return {
      data,
      async incr(k) { const v = (data.get(k)?.v || 0) + 1; data.set(k, { v, ttl: data.get(k)?.ttl ?? -1 }); return v; },
      async pttl(k) { return data.has(k) ? data.get(k).ttl : -2; },
      async pexpire(k, ms) { data.get(k).ttl = ms; return 1; },
      async get(k) { return data.has(k) ? String(data.get(k).v) : null; },
    };
  }

  it('heals a key left with no TTL so a client is never blocked forever', async () => {
    const redis = fakeRedis();
    const key = 'rl:auth:1.2.3.4:1'; // window 1 = [60s, 120s)
    redis.data.set(key, { v: 50, ttl: -1 }); // INCR happened, process died before EXPIRE
    await redisStore(redis, { now: () => 90_000 }).hit('rl:auth:1.2.3.4', 60);
    expect(redis.data.get(key).ttl).toBe(120000);
  });

  it('weights the previous window by how much of it is still inside the last 60s', async () => {
    const redis = fakeRedis();
    redis.data.set('rl:k:0', { v: 10, ttl: 1000 }); // 10 hits in window 0
    const hit = await redisStore(redis, { now: () => 75_000 }).hit('rl:k', 60); // 15s into window 1
    expect(hit.count).toBe(10 * 0.75 + 1);
    expect(hit.resetInMs).toBe(45_000);
  });
});

describe('perimeter', () => {
  it('allows an allow-listed origin and exposes the request id and Retry-After', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://app.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-expose-headers']).toMatch(/x-request-id/i);
    expect(res.headers['access-control-expose-headers']).toMatch(/Retry-After/i);
  });

  it('gives an unlisted origin no CORS access', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a body over 100kb with 413 before calling upstream', async () => {
    const res = await request(app).post('/api/auth/login').send({ blob: 'x'.repeat(110 * 1024) });
    expect(res.status).toBe(413);
    expect(seen).toBeNull();
  });

  it('answers malformed JSON with a 400 envelope without calling upstream', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
    expect(seen).toBeNull();
  });

  it('answers an unknown route with a JSON 404 and hides x-powered-by', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
