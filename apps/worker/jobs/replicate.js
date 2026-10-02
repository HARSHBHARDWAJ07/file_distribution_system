const { replicateObject } = require('../lib/storage');

async function replicateFile(file) {
  return replicateObject(file.storage_key);
}

module.exports = { replicateFile };
