'use client';
import { useRef, useState } from 'react';
import ErrorNote from './ErrorNote';
import { formatBytes, formatWhen } from '../lib/format.js';

const extensionOf = name => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot > name.length - 6 ? name.slice(dot + 1).toLowerCase() : 'file';
};

// A stored file: download, or delete after a second click to confirm (no
// browser confirm() dialog - it blocks the page and can't be styled).
export function FileRow({ file, onDownload, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li className="file">
      {file.thumbnailUrl
        ? <img className="file-thumb" src={file.thumbnailUrl} alt="" width="44" height="44" loading="lazy" />
        : <span className="file-thumb" aria-hidden="true">{extensionOf(file.filename)}</span>}
      <div>
        <div className="file-name">{file.filename}</div>
        <div className="file-meta">
          {confirming ? "Delete permanently? This can’t be undone." : `${formatBytes(file.sizeBytes)}, ${formatWhen(file.completedAt || file.createdAt)}`}
        </div>
      </div>
      <div className="actions">
        {confirming ? (
          <>
            <button type="button" className="button button-danger" disabled={busy}
              onClick={() => run(() => onDelete(file))} aria-label={`Confirm delete ${file.filename}`}>
              {busy ? 'Deleting' : 'Delete'}
            </button>
            <button type="button" className="button button-quiet" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="button" disabled={busy}
              onClick={() => run(() => onDownload(file))} aria-label={`Download ${file.filename}`}>Download</button>
            <button type="button" className="button button-quiet" onClick={() => setConfirming(true)}
              aria-label={`Delete ${file.filename}`}>Delete</button>
          </>
        )}
      </div>
      {error && <ErrorNote error={error} />}
    </li>
  );
}

// An upload that didn't finish (tab closed, reload, crash). The browser can't
// keep the File across reloads, so the user re-selects it to resume.
export function UnfinishedRow({ file, onResume, onRemove }) {
  const picker = useRef(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function pick(event) {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    const { error: mismatch } = onResume(file, chosen);
    setError(mismatch ? { code: 'RESUME_MISMATCH', message: mismatch } : null);
  }

  async function remove() {
    setBusy(true);
    try { await onRemove(file); } catch (err) { setError(err); setBusy(false); }
  }

  return (
    <li className="file">
      <span className="file-thumb" aria-hidden="true">{extensionOf(file.filename)}</span>
      <div>
        <div className="file-name">{file.filename}</div>
        <div className="file-meta">{formatBytes(file.sizeBytes)}, started {formatWhen(file.createdAt)}</div>
      </div>
      <div className="actions">
        <input ref={picker} type="file" className="visually-hidden" tabIndex={-1} onChange={pick} aria-hidden="true" />
        <button type="button" className="button button-primary" onClick={() => picker.current?.click()}
          aria-label={`Resume ${file.filename}`}>Resume</button>
        <button type="button" className="button button-quiet" disabled={busy} onClick={remove}
          aria-label={`Discard unfinished upload of ${file.filename}`}>Discard</button>
      </div>
      {error && <ErrorNote error={error} />}
    </li>
  );
}
