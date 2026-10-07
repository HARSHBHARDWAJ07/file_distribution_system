const crypto = require('crypto');
const { pool } = require('../lib/db');
const { revokeRefreshToken, storeRefreshToken } = require('../lib/redis');
const { signAccessToken } = require('../lib/jwt');
const { refreshBody } = require('../lib/schemas');
const { ok, fail, validate } = require('@cloudstore/shared-types');

async function refresh(req, res) {
  const { data: body, error } = validate(refreshBody, req.body);
  if (error) return res.status(400).json(error);

  const [userId, tokenId] = body.refreshToken.toLowerCase().split('.');

  // Revoke-as-check: DEL reports whether the token existed, atomically. With a
  // separate GET-then-DEL, two concurrent refreshes with the same token could
  // both pass the GET and both be issued new tokens.
  if (!(await revokeRefreshToken(userId, tokenId))) {
    return res.status(401).json(fail('INVALID_REFRESH_TOKEN', 'refresh token is invalid or has been used'));
  }

  const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
  const user = result.rows[0];
  if (!user) {
    return res.status(401).json(fail('INVALID_REFRESH_TOKEN', 'user no longer exists'));
  }

  const newTokenId = crypto.randomUUID();
  await storeRefreshToken(userId, newTokenId);

  const accessToken = signAccessToken(user);
  return res.json(ok({ accessToken, refreshToken: `${userId}.${newTokenId}` }));
}

module.exports = { refresh };
