const express = require('express');
const { ok } = require('@cloudstore/shared-types');
const { asyncHandler, requestId, requestLogger, notFound, errorHandler } = require('@cloudstore/http-utils');
const { requireInternal } = require('./middleware/requireInternal');
const { initUpload } = require('./routes/initUpload');
const { completeUpload } = require('./routes/completeUpload');
const { getPartUploadUrl, recordPartUploaded, getUploadStatus, abortUpload } = require('./routes/chunkUpload');
const { downloadFile, deleteFile } = require('./routes/fileAccess');
const { listFiles } = require('./routes/listFiles');

// Built separately from listen() so tests can drive it with supertest.
function createApp({ logger, internalToken }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId());
  app.use(requestLogger(logger));
  // File bytes never pass through the API, so a large body is always abuse.
  // (Clients completing huge uploads omit `parts`; the recorded parts are used.)
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (req, res) => {
    res.json(ok({ status: 'healthy' }));
  });

  // Everything below is reachable only through the gateway.
  app.use(requireInternal(internalToken));

  app.post('/uploads/init', asyncHandler(initUpload));
  app.get('/uploads/:fileId/status', asyncHandler(getUploadStatus));
  app.get('/uploads/:fileId/parts/:partNumber', asyncHandler(getPartUploadUrl));
  app.post('/uploads/:fileId/parts/:partNumber', asyncHandler(recordPartUploaded));
  app.post('/uploads/:fileId/complete', asyncHandler(completeUpload));
  app.post('/uploads/:fileId/abort', asyncHandler(abortUpload));

  app.get('/files', asyncHandler(listFiles));
  app.get('/files/:fileId/download', asyncHandler(downloadFile));
  app.delete('/files/:fileId', asyncHandler(deleteFile));

  app.use(notFound());
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
