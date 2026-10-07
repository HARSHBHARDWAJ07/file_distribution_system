// Gateway edge cases against a real local stand-in for both upstream
// services, so forwarding (headers, paths, bodies, failures) is exercised for real.
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createLogger } = require('@cloudstore/logger');
const { createApp } = require('../app');

const SECRET = 'test-jwt-secret';
const INTERNAL = 'test-internal-token';
const USER_ID = '11111111-1111-4111-8111-111111111111';

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

let app;
beforeEach(() => {
  seen = null;
  reply = (req, res) => res.json({ success: true, data: { ok: true } });
  app = createApp({
    logger: createLogger('gateway-test'),
    authServiceUrl: upstreamUrl,
    fileServiceUrl: upstreamUrl,
    jwtSecret: SECRET,
    internalToken: INTERNAL,
  });
});

const token = (claims = { sub: USER_ID, email: 'a@test.dev' }, opts = { expiresIn: '15m' }) => jwt.sign(claims, SECRET, opts);
const authed = req => req.set('Authorization', `Bearer ${token()}`);

describe('identity forwarded to the file-service', () => {
  it('sends the verified user id and the internal token', async () => {
    await authed(request(app).get('/api/files/abc/download'));
    expect(seen.headers['x-user-id']).toBe(USER_ID);
    expect(seen.headers['x-internal-token']).toBe(INTERNAL);
  });

  it('never passes through identity headers a client tries to supply', async () => {
    await authed(request(app).get('/api/files/abc/download'))
      .set('x-user-id', 'someone-else').set('x-internal-token', 'forged');
    expect(seen.headers['x-user-id']).toBe(USER_ID);
    expect(seen.headers['x-internal-token']).toBe(INTERNAL);
  });

  it('does not send the internal token to the auth-service', async () => {
    await request(app).post('/api/auth/login').send({ email: 'a', password: 'b' });
    expect(seen.headers['x-internal-token']).toBeUndefined();
    expect(seen.body).toEqual({ email: 'a', password: 'b' });
  });

  it('keeps an encoded "../" file id inside the intended upstream route', async () => {
    await authed(request(app).get('/api/files/..%2F..%2Fuploads%2Finit/download'));
    expect(seen.path).toBe('/files/..%2F..%2Fuploads%2Finit/download');
  });
});

describe('JWT checks', () => {
  it.each([
    ['no header', r => r],
    ['a non-bearer header', r => r.set('Authorization', 'Basic abc')],
    ['a token signed with another secret', r => r.set('Authorization', `Bearer ${jwt.sign({ sub: USER_ID }, 'other')}`)],
    ['an unsigned alg:none token', r => r.set('Authorization', `Bearer ${jwt.sign({ sub: USER_ID }, null, { algorithm: 'none' })}`)],
    ['a token without a subject', r => r.set('Authorization', `Bearer ${token({ email: 'x' })}`)],
  ])('rejects %s with 401 and never calls upstream', async (_, withAuth) => {
    const res = await withAuth(request(app).get('/api/files/abc/download'));
    expect(res.status).toBe(401);
    expect(seen).toBeNull();
  });

  it('labels an expired token TOKEN_EXPIRED so clients know to refresh', async () => {
    const expired = jwt.sign({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('refuses to start without a JWT secret or internal token', () => {
    const base = { logger: createLogger('t'), authServiceUrl: 'x', fileServiceUrl: 'x' };
    expect(() => createApp({ ...base, internalToken: INTERNAL })).toThrow(/JWT_SECRET/);
    expect(() => createApp({ ...base, jwtSecret: SECRET })).toThrow(/INTERNAL_API_TOKEN/);
  });
});

describe('request ids', () => {
  it('mints one, echoes it to the client, and forwards it upstream', async () => {
    const res = await authed(request(app).get('/api/files/abc/download'));
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.headers['x-request-id']).toBe(res.headers['x-request-id']);
  });

  it("reuses a well-formed id from the client but replaces a malformed one", async () => {
    const kept = await request(app).get('/api/auth/ping').set('x-request-id', 'client-req-42');
    expect(kept.headers['x-request-id']).toBe('client-req-42');
    const replaced = await request(app).get('/api/auth/ping').set('x-request-id', 'bad id with spaces');
    expect(replaced.headers['x-request-id']).not.toBe('bad id with spaces');
  });
});

describe('failure handling', () => {
  it('passes an upstream error status and body through unchanged', async () => {
    reply = (req, res) => res.status(409).json({ success: false, error: { code: 'EMAIL_TAKEN', message: 'x' } });
    const res = await request(app).post('/api/auth/signup').send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('turns a non-JSON upstream reply (a host error page) into a 502 envelope', async () => {
    reply = (req, res) => res.status(503).type('html').send('<html>waking up</html>');
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_BAD_RESPONSE');
  });

  it('turns an unreachable upstream into a 502 envelope', async () => {
    const down = createApp({
      logger: createLogger('t'), authServiceUrl: 'http://127.0.0.1:1', fileServiceUrl: 'http://127.0.0.1:1',
      jwtSecret: SECRET, internalToken: INTERNAL,
    });
    const res = await request(down).post('/api/auth/login').send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_UNREACHABLE');
  });

  it('answers malformed JSON with a 400 envelope without calling upstream', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
    expect(seen).toBeNull();
  });

  it('answers an unknown route with a JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
