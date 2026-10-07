/** Standard success envelope every service should return. */
function ok(data) {
  return { success: true, data };
}

/** Standard error envelope every service should return. */
function fail(code, message) {
  return { success: false, error: { code, message } };
}

module.exports = { ok, fail };
