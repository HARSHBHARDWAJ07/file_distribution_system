/**
 * Shared contracts between services: the response envelope every service
 * returns, and the storage key layout both the file-service and worker use.
 */
const { ok, fail } = require('./envelope');
const storageKeys = require('./storageKeys');

// Header the gateway uses to prove a request came through it (see
// apps/file-service/middleware/requireInternal.js).
const INTERNAL_TOKEN_HEADER = 'x-internal-token';

module.exports = { ok, fail, INTERNAL_TOKEN_HEADER, ...storageKeys };
