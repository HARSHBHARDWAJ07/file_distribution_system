// HTTP-level edge cases for the auth-service. Postgres and Redis are
// in-memory fakes; bcrypt and JWT signing are real.
process.env.JWT_SECRET = 'test-jwt-secret';

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../lib/db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../lib/redis', () => {
  const tokens = new Set();
  return {
    tokens,
    storeRefreshToken: jest.fn(async (u, t) => { tokens.add(`${u}:${t}`); }),
    revokeRefreshToken: jest.fn(async (u, t) => tokens.delete(`${u}:${t}`)), // like DEL: true once
  };
});

const { pool } = require('../lib/db');
const redis = require('../lib/redis');
const { createLogger } = require('@cloudstore/logger');
const { createApp } = require('../app');

function fakeUsers() {
  const users = new Map(); // email -> row
  pool.query.mockImplementation(async (sql, p) => {
    if (sql.startsWith('INSERT INTO users')) {
      if (users.has(p[0])) throw Object.assign(new Error('duplicate'), { code: '23505' });
      const row = { id: require('crypto').randomUUID(), email: p[0], password_hash: p[1] };
      users.set(p[0], row);
      return { rows: [{ id: row.id, email: row.email }] };
    }
    if (sql.includes('WHERE email')) return { rows: users.has(p[0]) ? [users.get(p[0])] : [] };
    if (sql.includes('WHERE id')) return { rows: [...users.values()].filter(u => u.id === p[0]) };
    throw new Error(`fakeUsers: unhandled ${sql}`);
  });
  return users;
}

let app;
let users;
beforeEach(() => {
  jest.clearAllMocks();
  redis.tokens.clear();
  users = fakeUsers();
  app = createApp({ logger: createLogger('auth-test') });
});

const signup = body => request(app).post('/signup').send(body);
const login = body => request(app).post('/login').send(body);

describe('signup validation', () => {
  it.each([
    ['a missing email', { password: 'password123' }],
    ['a non-string email', { email: 42, password: 'password123' }],
    ['an email without @', { email: 'not-an-email', password: 'password123' }],
    ['a short password', { email: 'a@test.dev', password: 'short' }],
    ['a numeric password', { email: 'a@test.dev', password: 12345678 }],
    ['a password over 72 bytes (bcrypt would silently truncate it)', { email: 'a@test.dev', password: 'é'.repeat(37) }],
  ])('rejects %s with 400, not a 500', async (_, body) => {
    const res = await signup(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('normalizes email case and whitespace, so the same address cannot register twice', async () => {
    expect((await signup({ email: 'Alice@Test.dev', password: 'password123' })).status).toBe(201);
    const dup = await signup({ email: '  alice@test.DEV ', password: 'password123' });
    expect(dup.status).toBe(409);
    expect(users.size).toBe(1);
  });

  it('hides a database failure behind a generic 500 envelope', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection reset'));
    const res = await signup({ email: 'a@test.dev', password: 'password123' });
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'something went wrong on our side', requestId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/connection reset/);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await signup({ email: 'a@test.dev', password: 'password123' });
  });

  it('logs in with differently-cased email', async () => {
    const res = await login({ email: 'A@TEST.dev', password: 'password123' });
    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.data.accessToken, 'test-jwt-secret').email).toBe('a@test.dev');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await login({ email: 'a@test.dev', password: 'nope-nope' });
    const unknownEmail = await login({ email: 'nobody@test.dev', password: 'nope-nope' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    const { requestId: _a, ...unknownError } = unknownEmail.body.error;
    const { requestId: _b, ...wrongError } = wrongPassword.body.error;
    expect(unknownError).toEqual(wrongError); // same answer either way (ids aside)
  });

  it.each([
    ['a non-string password', { email: 'a@test.dev', password: ['x'] }],
    ['an oversized password', { email: 'a@test.dev', password: 'x'.repeat(2000) }],
    ['an empty body', {}],
  ])('rejects %s with 400', async (_, body) => {
    expect((await login(body)).status).toBe(400);
  });
});

describe('refresh', () => {
  let refreshToken;
  beforeEach(async () => {
    await signup({ email: 'a@test.dev', password: 'password123' });
    refreshToken = (await login({ email: 'a@test.dev', password: 'password123' })).body.data.refreshToken;
  });

  it.each([
    ['a number', 12345],
    ['no dot', 'abc'],
    ['non-UUID parts', 'a.b'],
  ])('rejects a refresh token that is %s with 400', async (_, token) => {
    const res = await request(app).post('/refresh').send({ refreshToken: token });
    expect(res.status).toBe(400);
    expect(redis.revokeRefreshToken).not.toHaveBeenCalled();
  });

  it('rotates: the old token works once, then never again', async () => {
    const first = await request(app).post('/refresh').send({ refreshToken });
    expect(first.status).toBe(200);
    const replay = await request(app).post('/refresh').send({ refreshToken });
    expect(replay.status).toBe(401);
    const next = await request(app).post('/refresh').send({ refreshToken: first.body.data.refreshToken });
    expect(next.status).toBe(200);
  });

  it('two concurrent refreshes with the same token yield exactly one new session', async () => {
    const results = await Promise.all([1, 2, 3].map(() => request(app).post('/refresh').send({ refreshToken })));
    expect(results.map(r => r.status).sort()).toEqual([200, 401, 401]);
  });
});

it('answers malformed JSON with a 400 envelope', async () => {
  const res = await request(app).post('/login').set('Content-Type', 'application/json').send('{"email":');
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('INVALID_JSON');
});
