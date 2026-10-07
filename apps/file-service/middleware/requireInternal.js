const crypto = require('crypto');
const { AppError } = require('@cloudstore/http-utils');
const { validateUuid } = require('@cloudstore/validation');
const { INTERNAL_TOKEN_HEADER } = require('@cloudstore/shared-types');

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
      return next(new AppError(401, 'UNAUTHORIZED', 'requests must come through the gateway'));
    }
    try {
      req.userId = validateUuid(req.headers['x-user-id'], 'x-user-id');
    } catch {
      return next(new AppError(401, 'UNAUTHORIZED', 'missing or invalid user id'));
    }
    next();
  };
}

module.exports = { requireInternal };
