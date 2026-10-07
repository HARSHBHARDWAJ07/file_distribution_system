// Access token in memory only (gone on reload, so XSS can't read it from
// storage); refresh token in localStorage so a reload stays signed in.
// Trade-off, documented in the README: localStorage is readable by XSS. An
// httpOnly-cookie BFF is stronger, but needs the API on the frontend's own
// origin, which free cross-origin hosting (Vercel + Render) doesn't give us.

const REFRESH_KEY = 'cloudstore.refreshToken';

// localStorage can be missing (SSR) or throw (private mode, blocked storage).
function safeStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__cloudstore_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function createTokenStore(storage = safeStorage()) {
  let accessToken = null;
  let memoryRefresh = null; // fallback when storage is unavailable

  const read = () => {
    try { return storage ? storage.getItem(REFRESH_KEY) : memoryRefresh; } catch { return memoryRefresh; }
  };
  const write = value => {
    memoryRefresh = value;
    try {
      if (!storage) return;
      if (value) storage.setItem(REFRESH_KEY, value);
      else storage.removeItem(REFRESH_KEY);
    } catch { /* memory copy still works for this tab */ }
  };

  return {
    getAccess: () => accessToken,
    getRefresh: read,
    hasSession: () => Boolean(accessToken || read()),
    setTokens({ accessToken: access, refreshToken }) {
      accessToken = access ?? null;
      if (refreshToken) write(refreshToken);
    },
    clear() {
      accessToken = null;
      write(null);
    },
  };
}
