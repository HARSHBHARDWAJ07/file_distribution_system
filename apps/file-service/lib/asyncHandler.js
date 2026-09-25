// Wraps an async route handler so a rejected promise (DB error, storage
// error, etc.) is forwarded to Express's error handler instead of becoming
// an unhandled rejection that crashes the whole process.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
