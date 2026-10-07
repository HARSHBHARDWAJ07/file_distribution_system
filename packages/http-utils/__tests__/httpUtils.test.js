const express = require('express');
const request = require('supertest');
const pino = require('pino');
const {
  AppError, asyncHandler, requestId, requestLogger, notFound, errorHandler, requireEnv,
} = require('..');

// A logger whose output we can read back.
function captureLogger() {
  const lines = [];
  const stream = { write: line => lines.push(JSON.parse(line)) };
  return { logger: pino({ level: 'info' }, stream), lines };
}

function appWith(routes, logger = pino({ level: 'silent' })) {
  const app = express();
  app.use(requestId());
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '100kb' }));
  routes(app);
  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}

describe('asyncHandler', () => {
  it('routes a rejected promise to the error handler instead of hanging the request', async () => {
    const app = appWith(a => a.get('/boom', asyncHandler(async () => { throw new Error('db down'); })));
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
  });
});

describe('requestId', () => {
  const app = appWith(a => a.get('/', (req, res) => res.json({ id: req.id })));

  it('generates a UUID when none is sent, and echoes it', async () => {
    const res = await request(app).get('/');
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).toBe(res.body.id);
  });

  it('reuses a well-formed incoming id so services share one id', async () => {
    const res = await request(app).get('/').set('x-request-id', 'abc12345-trace');
    expect(res.body.id).toBe('abc12345-trace');
  });

  it.each([
    ['a log-injection attempt', 'abc"} {"level":60,"msg":"fake'],
    ['an id that is too short', 'abc'],
    ['an id that is too long', 'a'.repeat(65)],
    ['underscores and dots', 'abc_def.12345'],
  ])('replaces %s with a fresh id', async (_, forged) => {
    const res = await request(app).get('/').set('x-request-id', forged);
    expect(res.body.id).not.toBe(forged);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('errorHandler', () => {
  it('sends an AppError with its status and code, plus the request id', async () => {
    const app = appWith(a => a.get('/', () => { throw new AppError(409, 'EMAIL_TAKEN', 'taken'); }));
    const res = await request(app).get('/').set('x-request-id', 'trace-0001');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: { code: 'EMAIL_TAKEN', message: 'taken', requestId: 'trace-0001' } });
  });

  it('logs an unexpected error in full but sends the client nothing internal', async () => {
    const { logger, lines } = captureLogger();
    const app = appWith(a => a.get('/', () => {
      throw new Error('relation "users" does not exist at character 15');
    }), logger);
    const res = await request(app).get('/');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/relation|users|character|stack/);
    const logged = lines.find(l => l.msg === 'unhandled error');
    expect(logged.err.message).toMatch(/relation "users"/);
    expect(logged.err.stack).toBeDefined();
  });

  it('answers malformed JSON with 400 INVALID_JSON', async () => {
    const app = appWith(a => a.post('/', (req, res) => res.json({})));
    const res = await request(app).post('/').set('Content-Type', 'application/json').send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('answers an oversized body with 413 BODY_TOO_LARGE', async () => {
    const app = appWith(a => a.post('/', (req, res) => res.json({})));
    const res = await request(app).post('/').send({ blob: 'x'.repeat(110 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BODY_TOO_LARGE');
  });

  it('applies headers an AppError carries, e.g. Retry-After', async () => {
    const app = appWith(a => a.get('/', () => { throw new AppError(429, 'RATE_LIMITED', 'slow down', { 'Retry-After': '30' }); }));
    const res = await request(app).get('/');
    expect(res.headers['retry-after']).toBe('30');
  });

  it('answers an unknown route with a JSON 404', async () => {
    const res = await request(appWith(() => {})).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('requestLogger', () => {
  it('logs method, path, status and duration, but never the query string', async () => {
    const { logger, lines } = captureLogger();
    const app = appWith(a => a.get('/files', (req, res) => res.json({})), logger);
    await request(app).get('/files?token=secret-abc&X-Amz-Signature=deadbeef');
    const line = lines.find(l => l.req);
    expect(line.req).toEqual({ id: expect.any(String), method: 'GET', path: '/files' });
    expect(line.res.statusCode).toBe(200);
    expect(typeof line.responseTime).toBe('number');
    expect(JSON.stringify(lines)).not.toMatch(/secret-abc|deadbeef/);
  });

  it('logs 4xx at warn and 5xx at error', async () => {
    const { logger, lines } = captureLogger();
    const app = appWith(a => {
      a.get('/bad', () => { throw new AppError(400, 'INVALID_INPUT', 'x'); });
      a.get('/broken', () => { throw new Error('bug'); });
    }, logger);
    await request(app).get('/bad');
    await request(app).get('/broken');
    const levels = lines.filter(l => l.res).map(l => [l.req.path, l.level]);
    expect(levels).toEqual([['/bad', 40], ['/broken', 50]]);
  });
});

describe('requireEnv', () => {
  it('names every missing variable at once', () => {
    delete process.env.CS_TEST_A; delete process.env.CS_TEST_B;
    process.env.CS_TEST_C = 'set';
    expect(() => requireEnv(['CS_TEST_A', 'CS_TEST_B', 'CS_TEST_C']))
      .toThrow('missing required environment variable(s): CS_TEST_A, CS_TEST_B');
  });

  it('passes when everything is set', () => {
    process.env.CS_TEST_D = 'x';
    expect(() => requireEnv(['CS_TEST_D'])).not.toThrow();
  });
});
