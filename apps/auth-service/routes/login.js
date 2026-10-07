const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { storeRefreshToken } = require('../lib/redis');
const { signAccessToken } = require('../lib/jwt');
const { loginBody } = require('../lib/schemas');
const { ok, fail, validate } = require('@cloudstore/shared-types');

// Compared against when the email is unknown, so a miss costs the same bcrypt
// time as a hit and response timing doesn't reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 12);

async function login(req, res) {
  const { data: body, error } = validate(loginBody, req.body);
  if (error) return res.status(400).json(error);

  const result = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [body.email]);
  const user = result.rows[0];
  const passwordOk = await bcrypt.compare(body.password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    return res.status(401).json(fail('INVALID_CREDENTIALS', 'email or password is incorrect'));
  }

  const accessToken = signAccessToken(user);
  const refreshTokenId = crypto.randomUUID();
  await storeRefreshToken(user.id, refreshTokenId);

  return res.json(ok({
    accessToken,
    refreshToken: `${user.id}.${refreshTokenId}`,
    user: { id: user.id, email: user.email },
  }));
}

module.exports = { login };
