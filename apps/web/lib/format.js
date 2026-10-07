// Display helpers: sizes, times, progress, and error messages in the UI's voice.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatWhen(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const seconds = Math.round((now - t) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

// Never 100% until the server has confirmed the file is complete: bytes
// landing in storage isn't the same as the upload being done.
export function progressPercent(item) {
  if (item.state === 'done') return 100;
  if (!item.total) return 0;
  return Math.min(99, Math.floor((item.loaded / item.total) * 100));
}

const MESSAGES = {
  NETWORK_ERROR: "Can't reach the server. Check your connection, then try again.",
  SESSION_EXPIRED: 'Your session ended. Sign in again.',
  RATE_LIMITED: 'Too many requests in a short time. Wait a moment, then try again.',
  INVALID_CREDENTIALS: 'That email and password don\'t match an account.',
  EMAIL_TAKEN: 'An account with this email already exists. Sign in instead.',
  UPSTREAM_TIMEOUT: 'The server took too long to answer. It may be waking up; try again in a moment.',
  UPSTREAM_UNREACHABLE: 'Part of the service is unavailable right now. Try again in a moment.',
  STORAGE_REJECTED: 'Storage refused the upload. Try again; if it keeps failing, quote the reference below.',
};

// { message, requestId } for any error the UI can show. Messages from the
// API are already written for people; known codes get a friendlier version.
export function describeError(err) {
  if (!err) return { message: '', requestId: null };
  const message = MESSAGES[err.code] || err.message || 'Something went wrong.';
  return { message, requestId: err.requestId || null };
}
