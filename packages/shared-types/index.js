/**
 * Shared contracts between services.
 * Phase 0: just enough shape to prove both services agree on a
 * response format. Phase 1 extends User with real fields.
 */

/** Standard success envelope every service should return. */
function ok(data) {
  return { success: true, data };
}

/** Standard error envelope every service should return. */
function fail(code, message) {
  return { success: false, error: { code, message } };
}

module.exports = { ok, fail };
