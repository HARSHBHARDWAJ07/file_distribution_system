// Browser-only: PUT a Blob to a presigned URL. XHR rather than fetch because
// only XHR reports upload progress. Resolves with the ETag storage returned
// (null if the bucket's CORS rule hides it - the engine treats that as fatal).
import { StorageError } from './upload.js';

export function xhrPut(url, blob, { contentType, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Upload canceled.'), { name: 'AbortError' }));

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ etag: xhr.getResponseHeader('ETag') });
      else reject(new StorageError(xhr.status));
    };
    // Offline, DNS, or a CORS rejection all look the same from here: status 0.
    xhr.onerror = () => reject(new StorageError(0));
    xhr.ontimeout = () => reject(new StorageError(0));
    xhr.onabort = () => reject(Object.assign(new Error('Upload canceled.'), { name: 'AbortError' }));

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}
