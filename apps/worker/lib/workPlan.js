const IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function isImageContentType(contentType) {
  return IMAGE_CONTENT_TYPES.has((contentType || '').toLowerCase());
}

// Pure "what does this file still need" decision. pg-boss is at-least-once,
// so a job can be redelivered after it already (partly) ran - deriving the
// plan from the row's current state makes redelivery resume, not redo.
function planWork(file) {
  const needsThumbnail = isImageContentType(file.content_type) && !file.thumbnail_key;
  const needsReplication = !file.replicated_at;
  return { needsThumbnail, needsReplication, isFullyProcessed: !needsThumbnail && !needsReplication };
}

module.exports = { isImageContentType, planWork };
