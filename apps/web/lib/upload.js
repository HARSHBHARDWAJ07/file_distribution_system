// The upload engine. Plain JS with every side effect injected (api, putBlob,
// sleep, random), so it runs under node:test with no browser.
//
//   <= 5 MB   one presigned PUT, then complete
//   >  5 MB   init -> 5 MB parts, 3 in flight -> complete with every ETag
//
// File bytes go browser -> storage directly; the API only hands out URLs and
// records receipts. Each part gets up to 4 attempts with exponential backoff
// and jitter, and a fresh presigned URL every attempt (the old one may have
// expired while we waited).
import { ApiError } from './api.js';

export const MB = 1024 * 1024;
export const PART_CONCURRENCY = 3;  // more saturates the link: each part slows, the total doesn't improve
export const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

// A storage PUT that failed. status 0 = never got a response (offline, CORS).
export class StorageError extends Error {
  constructor(status, message) {
    super(message || (status ? `Storage rejected the upload (HTTP ${status}).` : 'The connection to storage dropped.'));
    this.name = 'StorageError';
    this.status = status;
    this.code = status ? 'STORAGE_REJECTED' : 'NETWORK_ERROR';
  }
}

// A failure no retry can fix; carries a code the UI turns into a message.
export class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

const abortError = () => Object.assign(new Error('Upload canceled.'), { name: 'AbortError' });

// 500 ms doubling, capped at 8 s, "equal jitter": always wait at least half
// the step, so retries from many clients spread out without ever hammering.
export function backoffDelay(attempt, random = Math.random) {
  const step = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(step / 2 + random() * (step / 2));
}

export function isRetryable(err) {
  if (!err || err.name === 'AbortError') return false;
  if (err instanceof ApiError) return err.retryable;
  // Storage: offline, server-side trouble, or 403 from an expired URL, which
  // the fresh URL on the next attempt fixes.
  if (err instanceof StorageError) return err.status === 0 || err.status === 403 || err.status === 408 || err.status >= 500;
  return false;
}

export function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

async function withRetry(task, { signal, sleep, random, onRetry }) {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortError();
    try {
      return await task(attempt);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw abortError();
      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err;
      const wait = err.retryAfter ? err.retryAfter * 1000 : backoffDelay(attempt, random);
      onRetry?.({ attempt, wait, error: err });
      await sleep(wait, signal);
    }
  }
}

export function partSizes(size, chunkSize, totalParts) {
  return Array.from({ length: totalParts }, (_, i) => Math.min(chunkSize, size - i * chunkSize));
}

// Browsers report '' for unknown types; the API wants type/subtype or nothing.
const contentTypeOf = file => (/^[\w.+-]+\/[\w.+-]+$/.test(file.type || '') ? file.type : undefined);

function resumeMismatch(file, status) {
  return file.name !== status.filename || file.size !== status.sizeBytes;
}

/**
 * Uploads one file. Emits events so a caller can draw progress:
 *   { type: 'plan', fileId, strategy, sizes, doneParts }
 *   { type: 'part', n, state: 'uploading'|'retrying'|'done'|'failed', loaded }
 *   { type: 'retry', n, attempt, wait, error }
 *   { type: 'completing' } then { type: 'done' }
 * Pass resumeFileId to continue an upload: only the parts storage doesn't
 * already hold are sent.
 */
export async function uploadFile({
  file, api, putBlob, signal, resumeFileId = null, onEvent = () => {}, sleep = defaultSleep, random = Math.random,
}) {
  const ctx = { signal, sleep, random };
  let plan;

  if (resumeFileId) {
    const status = await withRetry(() => api.getStatus(resumeFileId, { signal }), ctx);
    if (resumeMismatch(file, status)) {
      throw new UploadError('RESUME_MISMATCH', `That isn't the file this upload started with. Choose "${status.filename}" to resume.`);
    }
    plan = {
      fileId: status.fileId,
      strategy: status.strategy,
      status: status.status,
      sizes: partSizes(file.size, status.chunkSizeBytes, status.totalParts),
      chunkSize: status.chunkSizeBytes,
      contentType: status.contentType || undefined,
      uploadUrl: status.uploadUrl,
      done: new Map(status.uploadedParts.map(p => [p.partNumber, p.etag])),
    };
  } else {
    // Not retried: if init succeeded but its response was lost, a retry would
    // leave a duplicate row. A failure here surfaces with a Retry button.
    const init = await api.initUpload({ filename: file.name, sizeBytes: file.size, contentType: contentTypeOf(file) }, { signal });
    const chunked = init.strategy === 'chunked';
    plan = {
      fileId: init.fileId,
      strategy: init.strategy,
      status: 'uploading',
      sizes: chunked ? partSizes(file.size, init.chunkSizeBytes, init.totalParts) : [file.size],
      chunkSize: chunked ? init.chunkSizeBytes : file.size,
      contentType: init.contentType || undefined,
      uploadUrl: init.uploadUrl,
      done: new Map(),
    };
  }

  const { fileId } = plan;
  onEvent({ type: 'plan', fileId, strategy: plan.strategy, sizes: plan.sizes, doneParts: [...plan.done.keys()] });

  if (plan.status === 'complete') {
    onEvent({ type: 'done' });
    return { fileId };
  }
  if (plan.status === 'uploading') {
    if (plan.strategy === 'single') await uploadSingle(file, plan, api, putBlob, ctx, onEvent);
    else await uploadParts(file, plan, api, putBlob, ctx, onEvent);
  }
  // 'completing' falls straight through: a previous attempt got as far as complete

  const complete = () => withRetry(() => api.complete(fileId, { signal }), {
    ...ctx, onRetry: info => onEvent({ type: 'retry', n: null, ...info }),
  });
  onEvent({ type: 'completing' });
  try {
    await complete();
  } catch (err) {
    // Storage rejected the recorded receipts; the server has forgotten them.
    // Send every part again, once, rather than making the user retry twice.
    if (err.code !== 'INVALID_PARTS' || plan.strategy !== 'chunked') throw err;
    plan.done = new Map();
    onEvent({ type: 'plan', fileId, strategy: plan.strategy, sizes: plan.sizes, doneParts: [] });
    await uploadParts(file, plan, api, putBlob, ctx, onEvent);
    onEvent({ type: 'completing' });
    await complete();
  }
  onEvent({ type: 'done' });
  return { fileId };
}

async function uploadSingle(file, plan, api, putBlob, ctx, onEvent) {
  await withRetry(async attempt => {
    // Fresh URL after the first attempt; on resume the status call already gave one.
    const url = attempt === 1 && plan.uploadUrl
      ? plan.uploadUrl
      : (await api.getStatus(plan.fileId, { signal: ctx.signal })).uploadUrl;
    onEvent({ type: 'part', n: 1, state: 'uploading', loaded: 0 });
    // The URL was signed for this exact Content-Type; sending anything else is a 403.
    await putBlob(url, file, {
      contentType: plan.contentType,
      signal: ctx.signal,
      onProgress: loaded => onEvent({ type: 'part', n: 1, state: 'uploading', loaded }),
    });
  }, { ...ctx, onRetry: info => onEvent({ type: 'retry', n: 1, ...info }) });
  onEvent({ type: 'part', n: 1, state: 'done', loaded: file.size });
}

async function uploadParts(file, plan, api, putBlob, ctx, onEvent) {
  const pending = [];
  for (let n = 1; n <= plan.sizes.length; n++) if (!plan.done.has(n)) pending.push(n);

  // One part failing for good stops its siblings too, instead of uploading
  // bytes for a file that can't complete this round.
  const stopSiblings = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, stopSiblings.signal]) : stopSiblings.signal;
  let failure = null;

  const sendPart = n => withRetry(async () => {
    const start = (n - 1) * plan.chunkSize;
    const { uploadUrl } = await api.getPartUrl(plan.fileId, n, { signal });
    onEvent({ type: 'part', n, state: 'uploading', loaded: 0 });
    const { etag } = await putBlob(uploadUrl, file.slice(start, start + plan.sizes[n - 1]), {
      signal,
      onProgress: loaded => onEvent({ type: 'part', n, state: 'uploading', loaded }),
    });
    if (!etag) {
      // Retrying can't fix this: the bucket's CORS rule hides the header.
      throw new UploadError('ETAG_HIDDEN', "Storage accepted the part but hid its receipt (the ETag header), so the file can't be assembled. The storage bucket's CORS rule must expose ETag.");
    }
    await api.recordPart(plan.fileId, n, etag, { signal });
    return etag;
  }, { ...ctx, signal, onRetry: info => onEvent({ type: 'retry', n, ...info }) });

  async function worker() {
    while (pending.length && !failure) {
      const n = pending.shift();
      try {
        plan.done.set(n, await sendPart(n));
        onEvent({ type: 'part', n, state: 'done', loaded: plan.sizes[n - 1] });
      } catch (err) {
        if (!failure) failure = err;
        onEvent({ type: 'part', n, state: 'failed', loaded: 0 });
        stopSiblings.abort();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, pending.length) }, worker));

  if (ctx.signal?.aborted) throw abortError();
  if (failure) throw failure.name === 'AbortError' ? abortError() : failure;
}
