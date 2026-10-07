'use client';
import ChunkStrip from './ChunkStrip';
import ErrorNote from './ErrorNote';
import { formatBytes, progressPercent } from '../lib/format.js';

function statusLine(item) {
  const total = item.parts.length;
  const stored = item.parts.filter(p => p.state === 'done').length;
  switch (item.state) {
    case 'queued': return 'Waiting for another upload to finish';
    case 'completing': return 'Assembling the file in storage';
    case 'done': return 'Stored';
    case 'failed': return total > 1 ? `Stopped with ${stored} of ${total} parts stored` : 'Stopped';
    default:
      if (item.retrying) return 'Connection trouble, retrying';
      if (!total) return 'Starting';
      return total > 1 ? `${stored} of ${total} parts stored` : 'Uploading';
  }
}

export default function UploadRow({ item, onCancel, onRetry }) {
  const pct = progressPercent(item);
  const errorId = `upload-error-${item.id}`;
  return (
    <li className="upload" data-state={item.state} aria-describedby={item.error ? errorId : undefined}>
      <div className="upload-top">
        <span className="upload-name">{item.name}</span>
        <span className="upload-pct" aria-hidden="true">{item.state === 'failed' ? 'Stopped' : `${pct}%`}</span>
      </div>
      <ChunkStrip parts={item.parts} />
      <div className="upload-meta">
        <span>
          {formatBytes(item.loaded)} of {formatBytes(item.total)}. {statusLine(item)}
          <span className="visually-hidden">, {pct} percent</span>
        </span>
        <span className="actions">
          {item.state === 'failed' && (
            <button type="button" className="button button-primary" onClick={() => onRetry(item.id)}>Retry</button>
          )}
          {item.state !== 'done' && (
            <button type="button" className="button button-quiet" onClick={() => onCancel(item.id)}
              aria-label={`Cancel upload of ${item.name}`}>Cancel</button>
          )}
        </span>
      </div>
      {item.state === 'failed' && <ErrorNote error={item.error} id={errorId} />}
    </li>
  );
}
