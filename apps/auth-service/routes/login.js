const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { storeRefreshToken } = require('../lib/redis');
const { signAccessToken } = require('../lib/jwt');
const { ok, fail } = require('@cloudstore/shared-types');

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json(fail('INVALID_INPUT', 'email and password are required'));
  }

  const result = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
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
