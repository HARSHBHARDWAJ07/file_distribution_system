const CHUNK_THRESHOLD_BYTES = 5 * 1024 * 1024; // files under this: single-shot
const CHUNK_SIZE_BYTES = 5 * 1024 * 1024;       // 5MB per part - the S3 multipart minimum

function shouldUseChunkedUpload(sizeBytes) {
  return sizeBytes > CHUNK_THRESHOLD_BYTES;
}

function calculatePartCount(sizeBytes) {
  return Math.ceil(sizeBytes / CHUNK_SIZE_BYTES);
}

function remainingParts(totalParts, uploadedPartNumbers) {
  const uploaded = new Set(uploadedPartNumbers);
  const remaining = [];
  for (let i = 1; i <= totalParts; i++) {
    if (!uploaded.has(i)) remaining.push(i);
  }
  return remaining;
}

module.exports = {
  CHUNK_THRESHOLD_BYTES,
  CHUNK_SIZE_BYTES,
  shouldUseChunkedUpload,
  calculatePartCount,
  remainingParts,
};
