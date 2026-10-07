const crypto = require('crypto');
const { pool } = require('../lib/db');
const { revokeRefreshToken, storeRefreshToken } = require('../lib/redis');
const { signAccessToken } = require('../lib/jwt');
const { validateRefresh } = require('@cloudstore/validation');
const { AppError } = require('@cloudstore/http-utils');
const { ok } = require('@cloudstore/shared-types');

async function refresh(req, res) {
  const { refreshToken } = validateRefresh(req.body);
  const [userId, tokenId] = refreshToken.split('.');

  // Revoke-as-check: DEL reports whether the token existed, atomically. With a
  // separate GET-then-DEL, two concurrent refreshes with the same token could
  // both pass the GET and both be issued new tokens.
  if (!(await revokeRefreshToken(userId, tokenId))) {
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'refresh token is invalid or has been used');
  }

  const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'user no longer exists');

  const newTokenId = crypto.randomUUID();
  await storeRefreshToken(userId, newTokenId);

  const accessToken = signAccessToken(user);
  return res.json(ok({ accessToken, refreshToken: `${userId}.${newTokenId}` }));
}

module.exports = { refresh };
