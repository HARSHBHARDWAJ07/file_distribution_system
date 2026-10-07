// One fetch wrapper for the whole UI. It attaches the access token, refreshes
// it once on TOKEN_EXPIRED (single-flight: refresh tokens rotate, so two
// parallel refreshes would invalidate each other), and turns every failure
// into an ApiError with a stable code and the server's request id.

export class ApiError extends Error {
  constructor({ status = 0, code = 'UNKNOWN', message = 'Something went wrong.', requestId = null, retryAfter = null }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter; // seconds, from a 429
  }

  // Worth trying again: the network, the server side, or a rate limit.
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500
      || this.code === 'COMPLETE_IN_PROGRESS';
  }
}

const AUTH_RETRY_CODES = new Set(['TOKEN_EXPIRED', 'MISSING_TOKEN', 'INVALID_TOKEN']);

export function createApi({ baseUrl, tokens, fetchImpl = (...a) => fetch(...a), onSessionLost = () => {} }) {
  let refreshing = null;

  async function send(method, path, body, { auth = true, signal } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const access = tokens.getAccess();
    if (auth && access) headers.Authorization = `Bearer ${access}`;

    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ApiError({ code: 'NETWORK_ERROR', message: "Can't reach the server. Check your connection, then try again." });
    }

    const requestId = res.headers.get('x-request-id');
    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new ApiError({ status: res.status, code: 'BAD_RESPONSE', message: 'The server sent a response this page could not read.', requestId });
    }
    if (!res.ok || !payload?.success) {
      const error = payload?.error || {};
      throw new ApiError({
        status: res.status,
        code: error.code || 'UNKNOWN',
        message: error.message || `Request failed with status ${res.status}.`,
        requestId: error.requestId || requestId,
        retryAfter: Number(res.headers.get('retry-after')) || null,
      });
    }
    return payload.data;
  }

  function refresh() {
    if (!refreshing) {
      refreshing = (async () => {
        const refreshToken = tokens.getRefresh();
        if (!refreshToken) throw new ApiError({ status: 401, code: 'NOT_SIGNED_IN', message: 'Sign in to continue.' });
        try {
          const data = await send('POST', '/api/auth/refresh', { refreshToken }, { auth: false });
          tokens.setTokens(data);
          return data.accessToken;
        } catch (err) {
          if (err.status === 401 || err.status === 400) {
            tokens.clear();
            onSessionLost();
            throw new ApiError({ status: 401, code: 'SESSION_EXPIRED', message: 'Your session ended. Sign in again.', requestId: err.requestId });
          }
          throw err; // network trouble: keep the session, let the caller retry
        }
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function request(method, path, body, opts = {}) {
    if (opts.auth === false) return send(method, path, body, opts);
    if (!tokens.getAccess()) await refresh(); // first call after a reload
    try {
      return await send(method, path, body, opts);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401 || !AUTH_RETRY_CODES.has(err.code)) throw err;
      await refresh();
      return send(method, path, body, opts); // once only
    }
  }

  const enc = encodeURIComponent;
  return {
    request,
    isSignedIn: () => tokens.hasSession(),

    async signup(email, password) {
      return send('POST', '/api/auth/signup', { email, password }, { auth: false });
    },
    async login(email, password) {
      const data = await send('POST', '/api/auth/login', { email, password }, { auth: false });
      tokens.setTokens(data);
      return data.user;
    },
    signOut() {
      tokens.clear();
    },
    me: () => request('GET', '/api/me'),

    listFiles({ limit = 20, cursor } = {}) {
      const q = new URLSearchParams({ limit: String(limit) });
      if (cursor) q.set('cursor', cursor);
      return request('GET', `/api/files?${q}`);
    },
    initUpload: (body, opts) => request('POST', '/api/files/uploads/init', body, opts),
    getStatus: (fileId, opts) => request('GET', `/api/files/uploads/${enc(fileId)}/status`, undefined, opts),
    getPartUrl: (fileId, n, opts) => request('GET', `/api/files/uploads/${enc(fileId)}/parts/${n}`, undefined, opts),
    recordPart: (fileId, n, etag, opts) => request('POST', `/api/files/uploads/${enc(fileId)}/parts/${n}`, { etag }, opts),
    complete: (fileId, opts) => request('POST', `/api/files/uploads/${enc(fileId)}/complete`, {}, opts),
    abort: fileId => request('POST', `/api/files/uploads/${enc(fileId)}/abort`, {}),
    downloadUrl: fileId => request('GET', `/api/files/${enc(fileId)}/download`),
    deleteFile: fileId => request('DELETE', `/api/files/${enc(fileId)}`),
  };
}
