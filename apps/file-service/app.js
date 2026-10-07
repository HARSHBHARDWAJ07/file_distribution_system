const express = require('express');
const { ok, errorHandler } = require('@cloudstore/shared-types');
const { httpLogger } = require('@cloudstore/logger');
const { asyncHandler } = require('./lib/asyncHandler');
const { requireInternal } = require('./middleware/requireInternal');
const { initUpload } = require('./routes/initUpload');
const { completeUpload } = require('./routes/completeUpload');
const { getPartUploadUrl, recordPartUploaded, getUploadStatus } = require('./routes/chunkUpload');
const { downloadFile, deleteFile } = require('./routes/fileAccess');

// Built separately from listen() so tests can drive it with supertest.
function createApp({ logger, internalToken }) {
  const app = express();

  app.use(httpLogger(logger));
  app.use(express.json({ limit: '1mb' })); // largest legit body: a 10,000-entry parts list

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

  app.get('/files/:fileId/download', asyncHandler(downloadFile));
  app.delete('/files/:fileId', asyncHandler(deleteFile));

  app.use(errorHandler('file-service'));
  return app;
}

module.exports = { createApp };
