const { z } = require('zod');
const { MAX_PARTS, MAX_UPLOAD_BYTES } = require('./chunking');

const initUploadBody = z.object({
  filename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES, `must be at most ${MAX_UPLOAD_BYTES} bytes`),
  // type/subtype, e.g. image/png; optional, lower-cased so the worker's check is exact
  contentType: z.string().max(255).regex(/^[\w.+-]+\/[\w.+-]+$/, 'must look like type/subtype')
    .transform(s => s.toLowerCase()).optional(),
});

const fileParams = z.object({ fileId: z.uuid() });

const partParams = z.object({
  fileId: z.uuid(),
  partNumber: z.coerce.number().int().min(1).max(MAX_PARTS),
});

const recordPartBody = z.object({ etag: z.string().min(1).max(200) });

const completeBody = z.object({
  parts: z.array(z.object({
    PartNumber: z.number().int().min(1).max(MAX_PARTS),
    ETag: z.string().min(1).max(200),
  })).max(MAX_PARTS).optional(),
}).default({});

module.exports = { initUploadBody, fileParams, partParams, recordPartBody, completeBody };
