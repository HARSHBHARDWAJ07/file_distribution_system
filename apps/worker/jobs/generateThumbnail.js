const sharp = require('sharp');
const { thumbnailKeyFor } = require('@cloudstore/shared-types');
const { getObjectBuffer, putObject } = require('../lib/storage');

const THUMBNAIL_WIDTH = 200;

// The input itself is bad (corrupt, mislabeled, unsupported). Retrying can't
// help, unlike a storage or network error, so callers record it and move on.
class UnprocessableImageError extends Error {
  constructor(cause) {
    super(`image could not be decoded: ${cause.message}`);
    this.name = 'UnprocessableImageError';
  }
}

async function generateThumbnail(file) {
  const original = await getObjectBuffer(file.storage_key); // storage errors propagate: retryable

  let thumbnailBuffer;
  try {
    thumbnailBuffer = await sharp(original)
      .rotate() // honour EXIF orientation before resizing
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    throw new UnprocessableImageError(err);
  }

  // Deterministic key: a redelivered job overwrites rather than orphaning a copy.
  const thumbnailKey = thumbnailKeyFor(file.id);
  await putObject(thumbnailKey, thumbnailBuffer, 'image/jpeg');
  return thumbnailKey;
}

module.exports = { generateThumbnail, UnprocessableImageError };
