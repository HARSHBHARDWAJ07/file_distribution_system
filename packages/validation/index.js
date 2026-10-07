// Every validator returns a normalized value or throws AppError(400), so
// routes never touch raw input. Used at both layers: the gateway checks path
// params so junk never travels to a service, and each service re-validates
// what it receives - never rely on the layer in front of you.
const { z } = require('zod');
const { AppError } = require('@cloudstore/http-utils');

const CHUNK_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per part - the S3 multipart minimum
const MAX_PARTS = 10000;                  // S3 multipart maximum
// Configurable cap, never above what MAX_PARTS chunks can hold (~48.8GB).
const MAX_UPLOAD_BYTES = Math.min(
  Number(process.env.MAX_UPLOAD_BYTES) || 1024 * 1024 * 1024, // 1GiB default: free storage tiers are small
  CHUNK_SIZE_BYTES * MAX_PARTS
);

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  throw new AppError(400, 'INVALID_INPUT', `${field}${issue.message}`);
}

// ---------- ids ----------

function validateUuid(value, field = 'id') {
  if (typeof value !== 'string' || !z.uuid().safeParse(value).success) {
    throw new AppError(400, 'INVALID_INPUT', `${field} must be a UUID`);
  }
  return value.toLowerCase();
}

// Part numbers are 1-based; totalParts (when known) bounds them per file.
function validatePartNumber(value, totalParts = MAX_PARTS) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1 || n > totalParts) {
    throw new AppError(400, 'INVALID_INPUT', `partNumber must be an integer between 1 and ${totalParts}`);
  }
  return n;
}

// ---------- auth ----------

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

// bcrypt silently ignores everything past 72 bytes, so a longer password would
// "work" while only its prefix is checked. Reject instead of truncating;
// multi-byte characters (emoji) hit the byte limit before the character count.
const newPassword = z.string().min(8, 'must be at least 8 characters')
  .refine(p => Buffer.byteLength(p, 'utf8') <= 72, 'must be at most 72 bytes');

const signupSchema = z.object({ email, password: newPassword });

// Login doesn't re-apply signup's rules (they may change over time); it only
// bounds the input so a huge string can't be fed to bcrypt.
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(1024),
});

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const refreshSchema = z.object({ // issued as `${userId}.${tokenId}`, both UUIDs
  refreshToken: z.string().regex(new RegExp(`^${UUID}\\.${UUID}$`, 'i'), 'is malformed').transform(s => s.toLowerCase()),
});

const validateSignup = body => parse(signupSchema, body);
const validateLogin = body => parse(loginSchema, body);
const validateRefresh = body => parse(refreshSchema, body);

// ---------- uploads ----------

// The real name lives in the database; it only reaches storage after
// buildKey sanitizes it. Still, refuse names that are paths or control text.
const filename = z.string().trim().min(1).max(255)
  // eslint-disable-next-line no-control-regex
  .refine(n => !/[/\\\u0000-\u001f\u007f]/.test(n), 'must not contain slashes or control characters')
  .refine(n => n !== '.' && n !== '..', 'must be a file name');

const initUploadSchema = z.object({
  filename,
  sizeBytes: z.number().int().positive()
    .refine(Number.isSafeInteger, 'must be a safe integer')
    .refine(n => n <= MAX_UPLOAD_BYTES, `must be at most ${MAX_UPLOAD_BYTES} bytes`),
  // type/subtype, lower-cased so the worker's image check is exact
  contentType: z.string().max(255).regex(/^[\w.+-]+\/[\w.+-]+$/, 'must look like type/subtype')
    .transform(s => s.toLowerCase()).optional(),
});

const etag = z.string().min(1).max(200);
const recordPartSchema = z.object({ etag });
const partShape = z.object({ PartNumber: z.unknown(), ETag: etag }); // extra fields are stripped
const completeSchema = z.object({ parts: z.array(partShape).max(MAX_PARTS).optional() }).default({});

const validateInitUpload = body => parse(initUploadSchema, body);
const validateRecordPart = body => parse(recordPartSchema, body);
const validateCompleteBody = body => parse(completeSchema, body ?? {});

// ---------- listing ----------

// Keyset pagination: the cursor is opaque to clients (base64url of the last
// row's exact created_at text + id). Keyset rather than OFFSET, so page 50 is
// as fast as page 1 and rows don't shift while new uploads land.
function encodeCursor(createdAtText, id) {
  return Buffer.from(JSON.stringify([createdAtText, id])).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw new Error('bad time');
    return { createdAt, id: validateUuid(id, 'cursor') };
  } catch {
    throw new AppError(400, 'INVALID_INPUT', 'cursor is malformed');
  }
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, 'is malformed').optional(),
});

// Returns { limit, cursor } with cursor decoded to { createdAt, id } or null.
function validateListQuery(query) {
  const { limit, cursor } = parse(listQuerySchema, query ?? {});
  return { limit, cursor: cursor ? decodeCursor(cursor) : null };
}

// The failed-merge guard: a part list that can't assemble the whole file is
// rejected here, naming exactly which parts are wrong, instead of surfacing
// as an opaque storage error. Returns the parts sorted and normalized.
function validateCompleteParts(parts, totalParts) {
  if (!Array.isArray(parts)) throw new AppError(400, 'INVALID_INPUT', 'parts must be an array');
  const seen = new Map();
  for (const part of parts) {
    const n = validatePartNumber(part.PartNumber, totalParts); // out of range -> 400
    if (seen.has(n)) throw new AppError(400, 'DUPLICATE_PARTS', `part ${n} is listed more than once`);
    seen.set(n, parse(etag, part.ETag));
  }
  const missing = [];
  for (let i = 1; i <= totalParts; i++) if (!seen.has(i)) missing.push(i);
  if (missing.length) {
    const shown = missing.slice(0, 10).join(', ') + (missing.length > 10 ? `, ... (${missing.length} total)` : '');
    throw new AppError(400, 'MISSING_PARTS', `cannot complete: missing part(s) ${shown}`);
  }
  return [...seen].sort((a, b) => a[0] - b[0]).map(([PartNumber, ETag]) => ({ PartNumber, ETag }));
}

module.exports = {
  CHUNK_SIZE_BYTES,
  MAX_PARTS,
  MAX_UPLOAD_BYTES,
  validateUuid,
  validatePartNumber,
  validateSignup,
  validateLogin,
  validateRefresh,
  validateInitUpload,
  validateRecordPart,
  validateCompleteBody,
  validateCompleteParts,
  validateListQuery,
  encodeCursor,
};
