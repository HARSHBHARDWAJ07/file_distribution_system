const sharp = require('sharp');
const { getObjectBuffer, putObject } = require('../lib/storage');

const THUMBNAIL_WIDTH = 200;

async function generateThumbnail(file) {
  const original = await getObjectBuffer(file.storage_key);
  const thumbnailBuffer = await sharp(original)
    .rotate() // honour EXIF orientation before resizing
    .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  // Deterministic key: a redelivered job overwrites rather than orphaning a copy.
  const thumbnailKey = `thumbnails/${file.id}.jpg`;
  await putObject(thumbnailKey, thumbnailBuffer, 'image/jpeg');
  return thumbnailKey;
}

module.exports = { generateThumbnail };
