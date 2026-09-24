const bcrypt = require('bcrypt');
const { pool } = require('../lib/db');
const { ok, fail } = require('@cloudstore/shared-types');

const SALT_ROUNDS = 12;

async function signup(req, res) {
  const { email, password } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json(fail('INVALID_INPUT', 'email and a password of 8+ characters are required'));
  }

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email.toLowerCase(), passwordHash]
    );
    return res.status(201).json(ok({ user: result.rows[0] }));
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(409).json(fail('EMAIL_TAKEN', 'an account with this email already exists'));
    }
    console.error(err);
    return res.status(500).json(fail('SIGNUP_FAILED', 'could not create account'));
  }
}

module.exports = { signup };
