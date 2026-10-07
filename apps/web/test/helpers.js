// Fakes shared by the web tests: a File-like object and a scriptable API.
import { MB } from '../lib/upload.js';

export function fakeFile(name, size, type = 'application/octet-stream') {
  return {
    name, size, type,
    slice: (start, end) => ({ start, end, size: Math.min(end, size) - start }),
  };
}

// A minimal in-memory version of the upload endpoints.
export function fakeApi({ chunkSize = 5 * MB, uploadedParts = [], status = 'uploading', file } = {}) {
  const calls = { init: 0, partUrl: [], record: [], complete: 0, status: 0, abort: [] };
  const api = {
    calls,
    async initUpload({ filename, sizeBytes, contentType }) {
      calls.init++;
      calls.initBody = { filename, sizeBytes, contentType };
      if (sizeBytes <= 5 * MB) return { fileId: 'f1', strategy: 'single', uploadUrl: 'put://single/1', contentType: contentType ?? null };
      return { fileId: 'f1', strategy: 'chunked', totalParts: Math.ceil(sizeBytes / chunkSize), chunkSizeBytes: chunkSize };
    },
    async getStatus() {
      calls.status++;
      const chunked = file.size > 5 * MB;
      return {
        fileId: 'f1', filename: file.name, sizeBytes: file.size, contentType: file.type, status,
        strategy: chunked ? 'chunked' : 'single',
        chunkSizeBytes: chunked ? chunkSize : file.size,
        totalParts: chunked ? Math.ceil(file.size / chunkSize) : 1,
        uploadedParts,
        uploadUrl: chunked ? undefined : `put://single/${calls.status + 1}`,
      };
    },
    async getPartUrl(fileId, n) {
      calls.partUrl.push(n);
      return { uploadUrl: `put://part/${n}/${calls.partUrl.length}` };
    },
    async recordPart(fileId, n, etag) { calls.record.push([n, etag]); },
    async complete() { calls.complete++; return { status: 'complete' }; },
    async abort(fileId) { calls.abort.push(fileId); },
  };
  return api;
}

// putBlob that succeeds after reporting progress, unless `fail(url, attempt)`
// returns an error to throw. Tracks peak concurrency.
export function fakePut({ fail = () => null, etag = url => `"etag-${url}"` } = {}) {
  let inFlight = 0;
  const put = async (url, blob, { onProgress, contentType } = {}) => {
    put.calls.push({ url, size: blob.size, contentType });
    inFlight++;
    put.peak = Math.max(put.peak, inFlight);
    try {
      await new Promise(r => setTimeout(r, 2));
      const err = fail(url, put.calls.length);
      if (err) throw err;
      onProgress?.(Math.floor(blob.size / 2));
      onProgress?.(blob.size);
      return { etag: etag(url) };
    } finally {
      inFlight--;
    }
  };
  put.calls = [];
  put.peak = 0;
  return put;
}

export const noSleep = async () => {};
