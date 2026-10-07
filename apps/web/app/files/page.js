'use client';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Wordmark from '../../components/Wordmark';
import DropZone from '../../components/DropZone';
import UploadRow from '../../components/UploadRow';
import ErrorNote from '../../components/ErrorNote';
import { FileRow, UnfinishedRow } from '../../components/FileRow';
import { getApi, getUploadManager, onFileStored, onSessionLost, MAX_UPLOAD_BYTES } from '../../lib/client.js';
import { useUploads } from '../../lib/useUploads.js';
import { listReducer, initialListState, unfinished, stored } from '../../lib/listState.js';
import { formatBytes } from '../../lib/format.js';

const PAGE_SIZE = 20;

// "2 in progress, 1 stopped": counts what the user can act on, not finished rows.
function uploadSummary(uploads) {
  const active = uploads.filter(u => ['queued', 'uploading', 'completing'].includes(u.state)).length;
  const stopped = uploads.filter(u => u.state === 'failed').length;
  return [active && `${active} in progress`, stopped && `${stopped} stopped`].filter(Boolean).join(', ') || 'Done';
}

function SkeletonRows() {
  return Array.from({ length: 3 }, (_, i) => (
    <div className="skeleton" key={i} aria-hidden="true"><i /><div><i /><i /></div></div>
  ));
}

export default function FilesPage() {
  const router = useRouter();
  const api = getApi();
  const manager = getUploadManager();
  const uploads = useUploads(manager);
  const [list, dispatch] = useReducer(listReducer, initialListState);
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState('');
  const [rejected, setRejected] = useState([]);
  const [announcement, setAnnouncement] = useState('');
  const lastStates = useRef(new Map());

  // Gate: no session, no page. A session that dies mid-use goes to sign in.
  useEffect(() => {
    if (!api.isSignedIn()) { router.replace('/login'); return undefined; }
    setSignedIn(true);
    return onSessionLost(() => router.replace('/login?expired=1'));
  }, [api, router]);

  const load = useCallback(async () => {
    dispatch({ type: 'load' });
    try {
      const page = await api.listFiles({ limit: PAGE_SIZE });
      dispatch({ type: 'loaded', items: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      if (error.code !== 'SESSION_EXPIRED') dispatch({ type: 'failed', error });
    }
  }, [api]);

  useEffect(() => {
    if (!signedIn) return;
    load();
    api.me().then(d => setEmail(d.user.email)).catch(() => {});
  }, [signedIn, load, api]);

  // A finished upload refreshes the top of the list instead of reloading it.
  useEffect(() => onFileStored(async () => {
    try {
      const page = await api.listFiles({ limit: PAGE_SIZE });
      dispatch({ type: 'mergeHead', items: page.items });
    } catch { /* the row still shows "Stored"; the next load picks it up */ }
  }), [api]);

  // Leaving mid-upload loses the in-memory File; ask first.
  useEffect(() => {
    const guard = event => {
      if (!manager.hasActive()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [manager]);

  // Screen readers hear finished and failed uploads, not every progress tick.
  useEffect(() => {
    for (const item of uploads) {
      const before = lastStates.current.get(item.id);
      if (before !== item.state && (item.state === 'done' || item.state === 'failed')) {
        setAnnouncement(item.state === 'done' ? `${item.name} stored.` : `${item.name} stopped uploading.`);
      }
      lastStates.current.set(item.id, item.state);
    }
  }, [uploads]);

  async function loadMore() {
    dispatch({ type: 'loadMore' });
    try {
      const page = await api.listFiles({ limit: PAGE_SIZE, cursor: list.nextCursor });
      dispatch({ type: 'loadedMore', items: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      dispatch({ type: 'loadMoreFailed', error });
    }
  }

  function addFiles(files) {
    setRejected(manager.add(files).rejected);
  }

  async function download(file) {
    const { downloadUrl } = await api.downloadUrl(file.id);
    window.location.assign(downloadUrl); // served as an attachment under its own name
  }

  async function remove(file) {
    await api.deleteFile(file.id);
    dispatch({ type: 'removed', id: file.id });
  }

  async function discard(file) {
    const active = uploads.find(u => u.fileId === file.id);
    if (active) await manager.cancel(active.id);
    else await api.abort(file.id);
    dispatch({ type: 'removed', id: file.id });
  }

  function signOut() {
    api.signOut();
    router.replace('/login');
  }

  if (!signedIn) return null;

  const inManager = new Set(uploads.map(u => u.fileId).filter(Boolean));
  const waiting = unfinished(list.items).filter(f => !inManager.has(f.id));
  const files = stored(list.items);
  const ready = list.status === 'ready';

  return (
    <div className="page">
      <header className="topbar">
        <Wordmark />
        <div className="topbar-account">
          {email && <span>{email}</span>}
          <button type="button" className="button button-quiet" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main>
        <div className="page-head">
          <h1>Files</h1>
          {ready && files.length > 0 && (
            <p>
              {files.length}{list.nextCursor ? '+' : ''} {files.length === 1 ? 'file' : 'files'}, {formatBytes(files.reduce((sum, f) => sum + f.sizeBytes, 0))}
            </p>
          )}
        </div>

        <DropZone onFiles={addFiles} maxBytes={MAX_UPLOAD_BYTES} hasFiles={files.length > 0} />

        {rejected.length > 0 && (
          <div className="notice inline-gap" role="alert">
            {rejected.map(r => <p key={r.name}>{r.reason}</p>)}
          </div>
        )}

        <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>

        {uploads.length > 0 && (
          <section className="section" aria-labelledby="uploads-title">
            <div className="section-head">
              <h2 id="uploads-title">Uploading</h2>
              <span>{uploadSummary(uploads)}</span>
            </div>
            <ul className="rows">
              {uploads.map(item => (
                <UploadRow key={item.id} item={item} onCancel={id => manager.cancel(id)} onRetry={id => manager.retry(id)} />
              ))}
            </ul>
          </section>
        )}

        {waiting.length > 0 && (
          <section className="section" aria-labelledby="unfinished-title">
            <div className="section-head">
              <h2 id="unfinished-title">Unfinished uploads</h2>
              <span>Choose the same file to continue</span>
            </div>
            <ul className="rows">
              {waiting.map(f => (
                <UnfinishedRow key={f.id} file={f} onResume={(row, file) => manager.resume(row, file)} onRemove={discard} />
              ))}
            </ul>
          </section>
        )}

        <section className="section" aria-labelledby="files-title" aria-busy={list.status === 'loading'}>
          <div className="section-head">
            <h2 id="files-title">All files</h2>
            {ready && files.length > 0 && <span>Newest first</span>}
          </div>

          {list.status === 'loading' && <SkeletonRows />}

          {list.status === 'error' && (
            <ErrorNote error={list.error}>
              <p className="inline-gap">
                <button type="button" className="button" onClick={load}>Try again</button>
              </p>
            </ErrorNote>
          )}

          {ready && files.length === 0 && (
            <p className="empty">
              <strong>No files yet</strong>
              Drop a file above to upload your first one.
            </p>
          )}

          {files.length > 0 && (
            <ul className="rows">
              {files.map(f => <FileRow key={f.id} file={f} onDownload={download} onDelete={remove} />)}
            </ul>
          )}

          {ready && list.nextCursor && (
            <div className="load-more">
              {list.moreError && <ErrorNote error={list.moreError} />}
              <button type="button" className="button" onClick={loadMore} disabled={list.loadingMore}>
                {list.loadingMore ? 'Loading' : 'Show older files'}
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
