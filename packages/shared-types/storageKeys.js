// Every object a file owns, derived from the file row alone. The worker
// writes these and the file-service deletes them, so both must agree.

function thumbnailKeyFor(fileId) {
  return `thumbnails/${fileId}.jpg`;
}

function replicaKeyFor(storageKey) {
  return `replica/${storageKey}`;
}

function replicaBucket() {
  return process.env.STORAGE_REPLICA_BUCKET || process.env.STORAGE_BUCKET;
}

module.exports = { thumbnailKeyFor, replicaKeyFor, replicaBucket };
