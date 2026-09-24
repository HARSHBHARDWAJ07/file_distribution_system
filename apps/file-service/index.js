const express = require('express');
const { ok } = require('@cloudstore/shared-types');
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

app.post('/uploads/init', initUpload);
app.get('/uploads/:fileId/status', getUploadStatus);
app.get('/uploads/:fileId/parts/:partNumber', getPartUploadUrl);
app.post('/uploads/:fileId/parts/:partNumber', recordPartUploaded);
app.post('/uploads/:fileId/complete', completeUpload);

app.get('/files/:fileId/download', downloadFile);
app.delete('/files/:fileId', deleteFile);

app.listen(PORT, () => {
  console.log(`[file-service] listening on port ${PORT}`);
});
