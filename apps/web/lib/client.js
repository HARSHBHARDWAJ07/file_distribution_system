// The browser's single API client and upload manager, created on first use.
'use client';
import { createApi } from './api.js';
import { createTokenStore } from './tokenStore.js';
import { createUploadManager } from './uploadManager.js';
import { xhrPut } from './xhrPut.js';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/+$/, '');
export const MAX_UPLOAD_BYTES = (Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB) || 100) * 1024 * 1024;

let api;
let manager;
const sessionListeners = new Set();

export function onSessionLost(fn) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

export function getApi() {
  if (!api) {
    api = createApi({
      baseUrl: API_URL,
      tokens: createTokenStore(),
      onSessionLost: () => sessionListeners.forEach(fn => fn()),
    });
  }
  return api;
}

const storedListeners = new Set();
export function onFileStored(fn) {
  storedListeners.add(fn);
  return () => storedListeners.delete(fn);
}

export function getUploadManager() {
  if (!manager) {
    manager = createUploadManager({
      api: getApi(),
      putBlob: xhrPut,
      maxBytes: MAX_UPLOAD_BYTES,
      onStored: fileId => storedListeners.forEach(fn => fn(fileId)),
    });
  }
  return manager;
}
