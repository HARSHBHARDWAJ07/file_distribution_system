const {
  MAX_UPLOAD_BYTES, validateUuid, validatePartNumber, validateSignup, validateLogin, validateRefresh, validateListQuery,
  validateInitUpload, validateCompleteParts,
} = require('..');

// Asserts a validator throws a 400 AppError with the given code; returns it.
const caught = (fn, code = 'INVALID_INPUT') => {
  try { fn(); } catch (err) {
    expect(err.status).toBe(400);
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error('expected a validation error');
};
const rejects = (fn, code) => { caught(fn, code); }; // usable as a test body (returns nothing)

const UUID = '3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b';

describe('validateUuid', () => {
  it.each([
    ["SQL-ish input", "1' OR '1'='1"],
    ['a path', '../etc/passwd'],
    ['a number', 42],
    ['an object', { $ne: null }],
  ])('rejects %s', (_, value) => rejects(() => validateUuid(value, 'fileId')));

  it('normalizes case', () => expect(validateUuid(UUID.toUpperCase())).toBe(UUID));
});

describe('validateSignup', () => {
  it.each([
    ['a bad email', { email: 'not-an-email', password: 'password123' }],
    ['a password under 8 characters', { email: 'a@b.co', password: 'short' }],
    ['19 emoji (76 bytes, over bcrypt\'s 72)', { email: 'a@b.co', password: '🔑'.repeat(19) }],
    ['an object instead of a string', { email: { $gt: '' }, password: 'password123' }],
    ['a numeric password', { email: 'a@b.co', password: 12345678 }],
  ])('rejects %s', (_, body) => rejects(() => validateSignup(body)));

  it('accepts exactly 72 bytes (18 emoji) and normalizes the email', () => {
    expect(validateSignup({ email: '  Ann@Example.COM ', password: '🔑'.repeat(18) }))
      .toEqual({ email: 'ann@example.com', password: '🔑'.repeat(18) });
  });

  it('strips extra fields', () => {
    expect(validateSignup({ email: 'a@b.co', password: 'password123', isAdmin: true })).not.toHaveProperty('isAdmin');
  });
});

describe('validateLogin / validateRefresh', () => {
  it('bounds the password so a huge string never reaches bcrypt', () =>
    rejects(() => validateLogin({ email: 'a@b.co', password: 'x'.repeat(1025) })));

  it.each(['abc', `${UUID}.`, `${UUID}.${UUID}.x`, 42])('rejects refresh token %p', token =>
    rejects(() => validateRefresh({ refreshToken: token })));
});

describe('validateInitUpload', () => {
  const ok = { filename: 'cat.png', sizeBytes: 100 };

  it.each(['../../etc/passwd', 'a/b.txt', 'a\\b.txt', '.', '..', 'bad\nname', 'nul\u0000byte'])(
    'rejects the filename %p', filename => rejects(() => validateInitUpload({ ...ok, filename })));

  it.each([
    ['zero', 0], ['negative', -1], ['fractional', 10.5], ['a string', '100'],
    ['over the max', MAX_UPLOAD_BYTES + 1], ['an unsafe integer', 2 ** 60],
  ])('rejects a %s size', (_, sizeBytes) => rejects(() => validateInitUpload({ ...ok, sizeBytes })));

  it.each(['png', 'image/', 'image/png; charset=x', 'a'.repeat(300)])('rejects the MIME type %p', contentType =>
    rejects(() => validateInitUpload({ ...ok, contentType })));

  it('normalizes the MIME type and strips extra fields', () => {
    expect(validateInitUpload({ ...ok, contentType: 'IMAGE/PNG', ownerId: 'victim' }))
      .toEqual({ filename: 'cat.png', sizeBytes: 100, contentType: 'image/png' });
  });
});

describe('validatePartNumber', () => {
  it.each([0, -1, 1.5, 'abc', '1e3', 4])('rejects %p for a 3-part file', n => rejects(() => validatePartNumber(n, 3)));

  it('accepts a numeric string from a URL path', () => expect(validatePartNumber('3', 3)).toBe(3));
});

describe('validateCompleteParts (the failed-merge guard)', () => {
  const part = n => ({ PartNumber: n, ETag: `"etag-${n}"` });

  it('names exactly which parts are missing', () => {
    const err = caught(() => validateCompleteParts([part(1), part(3)], 4), 'MISSING_PARTS');
    expect(err.message).toBe('cannot complete: missing part(s) 2, 4');
  });

  it('caps the list of missing parts in the message', () => {
    const err = caught(() => validateCompleteParts([part(1)], 50), 'MISSING_PARTS');
    expect(err.message).toBe('cannot complete: missing part(s) 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, ... (49 total)');
  });

  it('rejects a duplicate part', () =>
    rejects(() => validateCompleteParts([part(1), part(2), part(2)], 2), 'DUPLICATE_PARTS'));

  it('rejects a part beyond the file size', () => rejects(() => validateCompleteParts([part(1), part(2), part(3)], 2)));

  it('rejects a malformed ETag', () => rejects(() => validateCompleteParts([{ PartNumber: 1, ETag: '' }], 1)));

  it('returns the parts sorted, with extra fields stripped', () => {
    expect(validateCompleteParts([{ ...part(2), Size: 5 }, part(1)], 2)).toEqual([part(1), part(2)]);
  });
});

describe('validateListQuery', () => {
  const { encodeCursor } = require('..');

  it('defaults the page size and caps it at 100', () => {
    expect(validateListQuery({})).toEqual({ limit: 20, cursor: null });
    expect(validateListQuery({ limit: '100' }).limit).toBe(100);
  });

  it.each(['0', '101', 'abc', '2.5'])('rejects limit %p', limit => rejects(() => validateListQuery({ limit })));

  it('round-trips an opaque cursor', () => {
    const cursor = encodeCursor('2026-10-07 06:00:00.123456+00', UUID);
    expect(validateListQuery({ cursor }).cursor).toEqual({ createdAt: '2026-10-07 06:00:00.123456+00', id: UUID });
  });

  it.each([
    ['garbage', 'not-base64-json'],
    ['a forged id', Buffer.from(JSON.stringify(['2026-01-01', "1' OR 1=1"])).toString('base64url')],
    ['a bad timestamp', Buffer.from(JSON.stringify(['yesterday-ish', UUID])).toString('base64url')],
    ['characters outside base64url', 'abc$def'],
  ])('rejects a cursor that is %s', (_, cursor) => rejects(() => validateListQuery({ cursor })));
});
