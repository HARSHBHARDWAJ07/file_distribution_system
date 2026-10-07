const bcrypt = require('bcrypt');
const { pool } = require('../lib/db');
const { signupBody } = require('../lib/schemas');
const { ok, fail, validate } = require('@cloudstore/shared-types');

const SALT_ROUNDS = 12;

async function signup(req, res) {
  const { data: body, error } = validate(signupBody, req.body);
  if (error) return res.status(400).json(error);

  const passwordHash = await bcrypt.hash(body.password, SALT_ROUNDS);
  try {
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [body.email, passwordHash]
    );
    return res.status(201).json(ok({ user: result.rows[0] }));
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(409).json(fail('EMAIL_TAKEN', 'an account with this email already exists'));
    }
    throw err; // the error handler logs it and returns a 500 envelope
  }
}

module.exports = { signup };
