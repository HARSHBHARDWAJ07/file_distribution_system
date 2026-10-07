const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { replicaKeyFor, replicaBucket } = require('@cloudstore/shared-types');

const BUCKET = process.env.STORAGE_BUCKET;

// See apps/file-service/lib/storage.js for why checksum calculation is off.
const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  region: process.env.STORAGE_REGION || 'auto',
  endpoint: process.env.STORAGE_ENDPOINT,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

async function getObjectBuffer(key) {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await result.Body.transformToByteArray());
}

async function putObject(key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

async function deleteObject(key, bucket = BUCKET) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// Real cross-region replication costs money, so "replication" here is a copy
// to a second bucket (if configured) or a replica/ prefix in the same one.
// Idempotent: copying onto an existing destination just overwrites it, so a
// redelivered job that already copied but crashed before recording it is safe.
async function replicateObject(sourceKey) {
  const destKey = replicaKeyFor(sourceKey);
  await s3.send(new CopyObjectCommand({
    Bucket: replicaBucket(),
    CopySource: `${BUCKET}/${sourceKey}`, // keys are already sanitized by buildKey
    Key: destKey,
  }));
  return destKey;
}

module.exports = { getObjectBuffer, putObject, deleteObject, replicateObject };
