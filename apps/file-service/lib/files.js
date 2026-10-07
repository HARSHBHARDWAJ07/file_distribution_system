const { pool } = require('./db');
const { fail, validate } = require('@cloudstore/shared-types');
const { fileParams } = require('./schemas');

async function getFileById(fileId) {
  const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [fileId]);
  return rows[0] || null;
}

// The validate -> load -> ownership check every :fileId route starts with.
// Sends the error response itself and returns null when the route should stop.
// A malformed id is a 404, not a 400 or a 500: no such file can exist.
async function loadOwnedFile(req, res, paramsSchema = fileParams) {
  const { data: params, error } = validate(paramsSchema, req.params);
  if (error) {
    const badId = !fileParams.safeParse({ fileId: req.params.fileId }).success;
    if (badId) {
      res.status(404).json(fail('FILE_NOT_FOUND', 'no file with that id'));
    } else {
      res.status(400).json(error);
    }
    return null;
  }

  const file = await getFileById(params.fileId);
  if (!file) {
    res.status(404).json(fail('FILE_NOT_FOUND', 'no file with that id'));
    return null;
  }
  if (file.owner_id !== req.userId) {
    res.status(403).json(fail('FORBIDDEN', 'you do not have access to this file'));
    return null;
  }
  return { file, params };
}

module.exports = { getFileById, loadOwnedFile };
