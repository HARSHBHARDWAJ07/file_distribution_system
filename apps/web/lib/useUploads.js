'use client';
import { useEffect, useState } from 'react';

// Subscribes to the upload manager, coalescing its events: XHR progress fires
// many times a second per part, but the UI re-renders at most once per frame.
export function useUploads(manager) {
  const [items, setItems] = useState(() => manager.getSnapshot());

  useEffect(() => {
    let frame = 0;
    const flush = () => { frame = 0; setItems(manager.getSnapshot()); };
    const unsubscribe = manager.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(flush);
    });
    flush();
    return () => { unsubscribe(); if (frame) cancelAnimationFrame(frame); };
  }, [manager]);

  return items;
}
