// Rate limiting with a pluggable store: Redis (shared across gateway
// instances) in production, in-memory for tests and single-instance dev.
//
// Algorithm: sliding-window counter. A fixed window lets up to 2x the limit
// through across a boundary (10 at 0:59 + 10 at 1:01 = 20 in two seconds).
// The sliding counter weights the previous window by how much of it still
// overlaps the last 60s:  estimate = prev * (1 - elapsed/window) + current.
// It costs one extra counter per key and smooths the boundary burst away.
// fixedWindowMemoryStore is kept so the difference stays demonstrable in tests.
const { AppError } = require('@cloudstore/http-utils');

const windowOf = (t, windowMs) => Math.floor(t / windowMs);

function slidingEstimate(prev, current, elapsedMs, windowMs) {
  return prev * ((windowMs - elapsedMs) / windowMs) + current;
}

// Per-process counters: correct for exactly one gateway instance.
function memoryStore({ now = Date.now } = {}) {
  const counts = new Map(); // `${key}:${windowIndex}` -> count
  return {
    async hit(key, windowSeconds) {
      const windowMs = windowSeconds * 1000;
      const t = now();
      const w = windowOf(t, windowMs);
      const curKey = `${key}:${w}`;
      counts.set(curKey, (counts.get(curKey) || 0) + 1);
      if (counts.size > 20000) { // drop windows nothing can read any more
        for (const k of counts.keys()) if (Number(k.slice(k.lastIndexOf(':') + 1)) < w - 1) counts.delete(k);
      }
      const elapsed = t - w * windowMs;
      return {
        count: slidingEstimate(counts.get(`${key}:${w - 1}`) || 0, counts.get(curKey), elapsed, windowMs),
        resetInMs: windowMs - elapsed,
      };
    },
  };
}

// The old algorithm, kept only to compare burst behaviour in tests.
function fixedWindowMemoryStore({ now = Date.now } = {}) {
  const counts = new Map();
  return {
    async hit(key, windowSeconds) {
      const windowMs = windowSeconds * 1000;
      const t = now();
      const curKey = `${key}:${windowOf(t, windowMs)}`;
      counts.set(curKey, (counts.get(curKey) || 0) + 1);
      return { count: counts.get(curKey), resetInMs: windowMs - (t % windowMs) };
    },
  };
}

// Same sliding counter in Redis: INCR the current window's key, read the
// previous one. Self-healing TTL: if a process died between INCR and PEXPIRE
// the key would never expire, so any hit that finds no TTL sets one. Keys
// live two windows, long enough to serve as "previous".
function redisStore(redis, { now = Date.now } = {}) {
  return {
    async hit(key, windowSeconds) {
      const windowMs = windowSeconds * 1000;
      const t = now();
      const w = windowOf(t, windowMs);
      const curKey = `${key}:${w}`;
      const current = await redis.incr(curKey);
      if ((await redis.pttl(curKey)) < 0) await redis.pexpire(curKey, windowMs * 2);
      const prev = Number(await redis.get(`${key}:${w - 1}`)) || 0;
      const elapsed = t - w * windowMs;
      return { count: slidingEstimate(prev, current, elapsed, windowMs), resetInMs: windowMs - elapsed };
    },
  };
}

// keyFor(req) picks who is being limited (IP before login, user id after).
// Fails open: if the store errors, the request is let through with a warning.
// Locking every user out because a free-tier cache hiccuped is worse than
// briefly not limiting - a deliberate availability-over-strictness choice.
function rateLimit({ name, limit, windowSeconds, keyFor, store, logger }) {
  return async (req, res, next) => {
    let hit;
    try {
      hit = await store.hit(`rl:${name}:${keyFor(req)}`, windowSeconds);
    } catch (err) {
      (req.log || logger).warn({ err, limiter: name }, 'rate limiter store unavailable, failing open');
      return next();
    }

    const resetSeconds = Math.max(1, Math.ceil(hit.resetInMs / 1000));
    res.set({
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(Math.max(0, Math.floor(limit - hit.count))),
      'X-RateLimit-Reset': String(resetSeconds),
    });
    if (hit.count > limit) {
      return next(new AppError(429, 'RATE_LIMITED', `too many requests, retry in ${resetSeconds}s`,
        { 'Retry-After': String(resetSeconds) }));
    }
    next();
  };
}

module.exports = { rateLimit, memoryStore, fixedWindowMemoryStore, redisStore };
