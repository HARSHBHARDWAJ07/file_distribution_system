const express = require('express');
const { ok, fail } = require('@cloudstore/shared-types');
const { asyncHandler } = require('./lib/asyncHandler');
const { initUpload } = require('./routes/initUpload');
const { completeUpload } = require('./routes/completeUpload');
const { getPartUploadUrl, recordPartUploaded, getUploadStatus } = require('./routes/chunkUpload');
const { downloadFile, deleteFile } = require('./routes/fileAccess');

const app = express();
const PORT = process.env.PORT || 4002;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json(ok({ status: 'healthy' }));
});

app.post('/uploads/init', asyncHandler(initUpload));
app.get('/uploads/:fileId/status', asyncHandler(getUploadStatus));
app.get('/uploads/:fileId/parts/:partNumber', asyncHandler(getPartUploadUrl));
app.post('/uploads/:fileId/parts/:partNumber', asyncHandler(recordPartUploaded));
app.post('/uploads/:fileId/complete', asyncHandler(completeUpload));

app.get('/files/:fileId/download', asyncHandler(downloadFile));
app.delete('/files/:fileId', asyncHandler(deleteFile));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[file-service] unhandled route error:', err);
  res.status(500).json(fail('INTERNAL_ERROR', 'an unexpected error occurred'));
});

app.listen(PORT, () => {
  console.log(`[file-service] listening on port ${PORT}`);
});
