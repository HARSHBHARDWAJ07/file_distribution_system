/**
 * Shared contracts between services: the response envelope every service
 * returns, plus the HTTP helpers that keep errors inside that envelope.
 */
const { ok, fail } = require('./envelope');
const { validate, errorHandler } = require('./http');
const storageKeys = require('./storageKeys');

// Header the gateway uses to prove a request came through it (see
// apps/file-service/middleware/requireInternal.js).
const INTERNAL_TOKEN_HEADER = 'x-internal-token';

module.exports = { ok, fail, validate, errorHandler, INTERNAL_TOKEN_HEADER, ...storageKeys };
