import Link from 'next/link';

// Three parts, one file: the same idea the upload strip shows.
export default function Wordmark({ href = '/files' }) {
  return (
    <Link href={href} className="wordmark" aria-label="CloudStore home">
      <span className="wordmark-parts" aria-hidden="true"><i /><i /><i /></span>
      CloudStore
    </Link>
  );
}
