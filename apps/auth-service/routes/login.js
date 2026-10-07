const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { storeRefreshToken } = require('../lib/redis');
const { signAccessToken } = require('../lib/jwt');
const { validateLogin } = require('@cloudstore/validation');
const { AppError } = require('@cloudstore/http-utils');
const { ok } = require('@cloudstore/shared-types');

// Compared against when the email is unknown, so a miss costs the same bcrypt
// time as a hit and response timing doesn't reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 12);

async function login(req, res) {
  const { email, password } = validateLogin(req.body);

  const { rows } = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
  const user = rows[0];
  const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    req.log.warn({ ip: req.ip, knownUser: Boolean(user) }, 'login failed');
    throw new AppError(401, 'INVALID_CREDENTIALS', 'email or password is incorrect');
  }

  const accessToken = signAccessToken(user);
  const refreshTokenId = crypto.randomUUID();
  await storeRefreshToken(user.id, refreshTokenId);
  req.log.info({ userId: user.id }, 'login succeeded');

  return res.json(ok({
    accessToken,
    refreshToken: `${user.id}.${refreshTokenId}`,
    user: { id: user.id, email: user.email },
  }));
}

module.exports = { login };
