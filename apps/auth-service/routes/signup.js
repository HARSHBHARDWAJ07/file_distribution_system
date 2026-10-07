const bcrypt = require('bcrypt');
const { pool } = require('../lib/db');
const { validateSignup } = require('@cloudstore/validation');
const { AppError } = require('@cloudstore/http-utils');
const { ok } = require('@cloudstore/shared-types');

const SALT_ROUNDS = 12;

async function signup(req, res) {
  const { email, password } = validateSignup(req.body);
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash]
    );
    req.log.info({ userId: rows[0].id }, 'signup');
    return res.status(201).json(ok({ user: rows[0] }));
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      throw new AppError(409, 'EMAIL_TAKEN', 'an account with this email already exists');
    }
    throw err; // everything else -> central error handler (logged, generic 500)
  }
}

module.exports = { signup };
