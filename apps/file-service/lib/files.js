const { pool } = require('./db');
const { AppError } = require('@cloudstore/http-utils');
const { validateUuid } = require('@cloudstore/validation');

// Every :fileId handler starts here. Ownership lives in the WHERE clause, not
// in a comparison after the fetch, so there is no check to forget. A file
// that exists but isn't yours gets the same 404 as one that doesn't exist,
// so the API never confirms which ids are real.
async function loadOwnedFile(fileId, ownerId) {
  const id = validateUuid(fileId, 'fileId');
  const { rows } = await pool.query('SELECT * FROM files WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  if (!rows[0]) throw new AppError(404, 'FILE_NOT_FOUND', 'no such file');
  return rows[0];
}

module.exports = { loadOwnedFile };
