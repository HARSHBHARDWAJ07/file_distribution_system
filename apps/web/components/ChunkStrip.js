// One segment per part, sized by the part's bytes: amber while it travels,
// verdigris once storage holds it, striped while it waits to retry, crimson
// if it failed. Decorative for screen readers; the row states the same in text.
export default function ChunkStrip({ parts }) {
  if (!parts.length) {
    return <div className="strip" aria-hidden="true"><div className="strip-part" style={{ '--weight': 1 }} /></div>;
  }
  return (
    <div className="strip" data-dense={parts.length > 40} aria-hidden="true">
      {parts.map(p => (
        <div
          key={p.n}
          className="strip-part"
          data-state={p.state}
          style={{ '--weight': p.size, '--fill': `${p.size ? (p.loaded / p.size) * 100 : 0}%` }}
        >
          <div className="strip-fill" />
        </div>
      ))}
    </div>
  );
}
