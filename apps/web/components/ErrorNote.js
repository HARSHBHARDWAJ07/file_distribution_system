import { describeError } from '../lib/format.js';

// Every failure the user can hit: what happened, and the request id that finds
// the exact server log line.
export default function ErrorNote({ error, children, id }) {
  const { message, requestId } = describeError(error);
  return (
    <div className="notice" role="alert" id={id}>
      <p>{message}</p>
      {requestId && <p className="reference">Reference: <code>{requestId}</code></p>}
      {children}
    </div>
  );
}
