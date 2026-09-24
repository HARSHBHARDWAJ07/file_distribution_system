const { pool } = require('./db');

async function getFileById(fileId) {
  const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
  return rows[0] || null;
}

module.exports = { getFileById };
