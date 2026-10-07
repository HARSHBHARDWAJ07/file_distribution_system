const CHUNK_THRESHOLD_BYTES = 5 * 1024 * 1024; // files under this: single-shot
const CHUNK_SIZE_BYTES = 5 * 1024 * 1024;       // 5MB per part - the S3 multipart minimum
const MAX_PARTS = 10000;                         // S3 multipart maximum
// Configurable cap, never above what MAX_PARTS chunks can hold (~48.8GB).
const MAX_UPLOAD_BYTES = Math.min(
  Number(process.env.MAX_UPLOAD_BYTES) || 1024 * 1024 * 1024, // 1GiB default: free storage tiers are small
  CHUNK_SIZE_BYTES * MAX_PARTS
);

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
  MAX_PARTS,
  MAX_UPLOAD_BYTES,
  shouldUseChunkedUpload,
  calculatePartCount,
  remainingParts,
};
