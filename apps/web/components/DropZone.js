'use client';
import { useRef, useState } from 'react';
import { formatBytes } from '../lib/format.js';

// Drag and drop for pointers; the button opens the same picker for keyboard
// and touch, so nothing depends on dragging.
export default function DropZone({ onFiles, maxBytes, hasFiles }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);

  const take = list => { if (list?.length) onFiles([...list]); };

  return (
    <section
      className="dropzone"
      data-over={over}
      aria-labelledby="dropzone-title"
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
    >
      <div>
        <h2 id="dropzone-title">{over ? 'Release to upload' : hasFiles ? 'Drop files here to upload' : 'Drop your first file here'}</h2>
        <p>Up to {formatBytes(maxBytes)} each. Files over 5 MB upload in parts, so a dropped connection can resume.</p>
      </div>
      <input ref={input} id="file-input" type="file" multiple className="visually-hidden" tabIndex={-1} aria-hidden="true"
        onChange={e => { take(e.target.files); e.target.value = ''; }} />
      <button type="button" className="button button-primary" onClick={() => input.current?.click()}>
        Choose files
      </button>
    </section>
  );
}
