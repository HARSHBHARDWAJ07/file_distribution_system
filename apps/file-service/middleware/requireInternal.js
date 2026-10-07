const crypto = require('crypto');
const { z } = require('zod');
const { fail, INTERNAL_TOKEN_HEADER } = require('@cloudstore/shared-types');

const userIdSchema = z.uuid();

function tokensMatch(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The file-service has a public URL (free hosting has no private network),
// so x-user-id alone proves nothing - anyone could send it. Only requests
// carrying the gateway's shared secret are trusted to name a user; the
// gateway sets x-user-id only after verifying the caller's JWT.
function requireInternal(internalToken) {
  if (!internalToken) throw new Error('INTERNAL_API_TOKEN must be set'); // fail closed, never open
  return (req, res, next) => {
    if (!tokensMatch(req.headers[INTERNAL_TOKEN_HEADER], internalToken)) {
      return res.status(401).json(fail('UNAUTHORIZED', 'requests must come through the gateway'));
    }
    const parsed = userIdSchema.safeParse(req.headers['x-user-id']);
    if (!parsed.success) {
      return res.status(401).json(fail('UNAUTHORIZED', 'missing or invalid user id'));
    }
    req.userId = parsed.data;
    next();
  };
}

module.exports = { requireInternal };
