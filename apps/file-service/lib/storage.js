const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.STORAGE_BUCKET;
const PRESIGN_EXPIRY_SECONDS = 300; // 5 minutes

const credentials = {
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
};

// requestChecksumCalculation: 'WHEN_REQUIRED' stops the SDK from attaching
// x-amz-checksum-* headers by default - newer SDK versions add them
// automatically, which R2 and older S3-compatible servers don't reliably
// support, especially on presigned URLs.
const s3ClientDefaults = { requestChecksumCalculation: 'WHEN_REQUIRED' };

// Used for the service's own direct SDK calls (create/complete/abort/delete).
const s3 = new S3Client({
  ...s3ClientDefaults,
  region: process.env.STORAGE_REGION || 'auto',
  endpoint: process.env.STORAGE_ENDPOINT, // e.g. R2 account endpoint, or an internal docker hostname locally
  credentials,
  forcePathStyle: true, // required by S3-compatible local emulators and R2
});

// Presigned URLs are handed to an external client (browser/curl), so when the
// service's own network path differs from what that client can reach (e.g.
// an internal docker hostname vs localhost), sign against STORAGE_PUBLIC_ENDPOINT
// instead. In production both endpoints are the same public R2 URL.
const presignClient = process.env.STORAGE_PUBLIC_ENDPOINT
  ? new S3Client({
      ...s3ClientDefaults,
      region: process.env.STORAGE_REGION || 'auto',
      endpoint: process.env.STORAGE_PUBLIC_ENDPOINT,
      credentials,
      forcePathStyle: true,
    })
  : s3;

function buildKey(ownerId, filename) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `users/${ownerId}/${Date.now()}-${safeName}`;
}

async function getPresignedUploadUrl(key, contentType) {
  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(presignClient, command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
}

async function getPresignedDownloadUrl(key) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(presignClient, command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
}

// S3 DeleteObject succeeds for a key that doesn't exist, so deleting
// "every object a file might own" is safe even if some were never made.
async function deleteObject(key, bucket = BUCKET) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// Size of a stored object, or null if it isn't there.
async function getObjectSize(key) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return head.ContentLength;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function createMultipartUpload(key, contentType) {
  const result = await s3.send(new CreateMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  }));
  return result.UploadId;
}

async function getPresignedPartUploadUrl(key, uploadId, partNumber) {
  const command = new UploadPartCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(presignClient, command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
}

async function completeMultipartUpload(key, uploadId, parts) {
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  }));
}

// Frees the parts an unfinished multipart upload has stored. Already-gone
// (completed or aborted) is the outcome we wanted, so it isn't an error.
async function abortMultipartUpload(key, uploadId) {
  try {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));
  } catch (err) {
    if (err.name !== 'NoSuchUpload') throw err;
  }
}

module.exports = {
  buildKey,
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
  deleteObject,
  getObjectSize,
  createMultipartUpload,
  getPresignedPartUploadUrl,
  completeMultipartUpload,
  abortMultipartUpload,
};
