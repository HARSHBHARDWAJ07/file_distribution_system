// Queue and state for every upload on the page. Plain JS: the React side only
// subscribes to snapshots (lib/useUploads.js).
//   - at most 2 files upload at once; the rest wait their turn
//   - Cancel aborts the transfer and tells the API to free stored parts
//   - Retry resumes from the parts storage already holds
//   - Resume (after a reload) refuses a file whose name or size differs
import { uploadFile as defaultUploadFile } from './upload.js';
import { formatBytes } from './format.js';

const ACTIVE = new Set(['queued', 'uploading', 'completing']);

export function createUploadManager({
  api,
  putBlob,
  maxBytes,
  maxActive = 2,
  uploadFile = defaultUploadFile,
  onStored = () => {},
  clearDoneAfterMs = 4000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
}) {
  const items = new Map();
  const order = [];
  const listeners = new Set();
  let seq = 0;
  let cached = [];
  let dirty = true;

  function emit() {
    dirty = true;
    for (const fn of listeners) fn();
  }

  function snapshot() {
    if (dirty) {
      cached = order.map(id => {
        const item = items.get(id);
        return { ...item, parts: item.parts.map(p => ({ ...p })) };
      });
      dirty = false;
    }
    return cached;
  }

  // Checked before any network call, so the message can name the file.
  function rejectReason(file) {
    if (!file.size) return `"${file.name}" is empty, so there's nothing to upload.`;
    if (file.size > maxBytes) {
      return `"${file.name}" is ${formatBytes(file.size)}. Files can be up to ${formatBytes(maxBytes)}.`;
    }
    return null;
  }

  function enqueue(file, fileId = null) {
    const id = `u${++seq}`;
    items.set(id, {
      id, file, fileId, name: file.name, total: file.size, loaded: 0,
      state: 'queued', strategy: null, parts: [], error: null, retrying: false, controller: null,
    });
    order.push(id);
    return id;
  }

  function recompute(item) {
    item.loaded = item.parts.reduce((sum, p) => sum + p.loaded, 0);
  }

  function handle(item, ev) {
    switch (ev.type) {
      case 'plan':
        item.fileId = ev.fileId;
        item.strategy = ev.strategy;
        item.parts = ev.sizes.map((size, i) => {
          const done = ev.doneParts.includes(i + 1);
          return { n: i + 1, size, loaded: done ? size : 0, state: done ? 'done' : 'pending' };
        });
        break;
      case 'part': {
        const part = item.parts[ev.n - 1];
        if (!part) return;
        part.state = ev.state;
        part.loaded = Math.min(part.size, ev.loaded ?? part.loaded);
        if (ev.state === 'uploading') item.retrying = false;
        break;
      }
      case 'retry':
        item.retrying = true;
        if (ev.n) { const part = item.parts[ev.n - 1]; if (part) { part.state = 'retrying'; part.loaded = 0; } }
        break;
      case 'completing':
        item.state = 'completing';
        break;
      default:
        return;
    }
    recompute(item);
    emit();
  }

  function remove(id) {
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
    items.delete(id);
    emit();
  }

  function start(item) {
    item.state = 'uploading';
    item.error = null;
    item.controller = new AbortController();
    emit();
    uploadFile({
      file: item.file,
      api,
      putBlob,
      signal: item.controller.signal,
      resumeFileId: item.fileId,
      onEvent: ev => handle(item, ev),
    })
      .then(() => {
        item.state = 'done';
        item.parts.forEach(p => { p.loaded = p.size; p.state = 'done'; });
        recompute(item);
        onStored(item.fileId);
        setTimer(() => { if (items.get(item.id)?.state === 'done') remove(item.id); }, clearDoneAfterMs);
      })
      .catch(err => {
        if (item.state === 'canceled' || err?.name === 'AbortError') return;
        item.state = 'failed';
        item.retrying = false;
        item.error = err;
      })
      .finally(() => {
        item.controller = null;
        emit();
        pump();
      });
  }

  function pump() {
    let active = order.filter(id => ['uploading', 'completing'].includes(items.get(id).state)).length;
    for (const id of order) {
      if (active >= maxActive) break;
      const item = items.get(id);
      if (item.state === 'queued') { start(item); active++; }
    }
  }

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot: snapshot,
    hasActive: () => [...items.values()].some(i => ACTIVE.has(i.state)),

    // Returns the files refused up front, each with a reason naming it.
    add(files) {
      const rejected = [];
      for (const file of files) {
        const reason = rejectReason(file);
        if (reason) rejected.push({ name: file.name, reason });
        else enqueue(file);
      }
      emit();
      pump();
      return { rejected };
    },

    // Abort the transfer and free whatever storage holds for it.
    async cancel(id) {
      const item = items.get(id);
      if (!item) return;
      const fileId = item.fileId;
      const wasStored = item.state === 'done';
      item.state = 'canceled';
      item.controller?.abort();
      remove(id);
      pump();
      if (fileId && !wasStored) await api.abort(fileId).catch(() => {}); // best effort: the row may already be gone
    },

    // Picks up where it stopped: the engine asks which parts are stored.
    retry(id) {
      const item = items.get(id);
      if (!item || item.state !== 'failed') return;
      item.state = 'queued';
      item.error = null;
      emit();
      pump();
    },

    // After a reload the File object is gone; the user re-selects it. It must
    // be the same file, or the stored parts would be stitched to the wrong bytes.
    resume(row, file) {
      if (file.name !== row.filename || file.size !== row.sizeBytes) {
        return {
          error: `That's "${file.name}" (${formatBytes(file.size)}). To resume, choose "${row.filename}" (${formatBytes(row.sizeBytes)}).`,
        };
      }
      const already = [...items.values()].find(i => i.fileId === row.id && i.state !== 'failed');
      if (already) return { error: null };
      const failed = [...items.values()].find(i => i.fileId === row.id);
      if (failed) remove(failed.id);
      enqueue(file, row.id);
      emit();
      pump();
      return { error: null };
    },

    dismiss: remove,
  };
}
