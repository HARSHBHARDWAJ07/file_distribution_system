// Fixed-window rate limiting with a pluggable store: Redis (shared across
// gateway instances) in production, in-memory for tests and single-instance
// dev. Known weakness of a fixed window: up to 2x the limit can pass across a
// window boundary (10 at 0:59 + 10 at 1:01). A sliding window fixes that.
const { AppError } = require('@cloudstore/http-utils');

// Per-process counters: correct for exactly one gateway instance.
function memoryStore({ now = Date.now } = {}) {
  const windows = new Map();
  return {
    async hit(key, windowSeconds) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + windowSeconds * 1000 };
        windows.set(key, w);
      }
      w.count++;
      if (windows.size > 10000) { // don't let one-off IPs grow the map forever
        for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
      }
      return { count: w.count, resetInMs: w.resetAt - t };
    },
  };
}

// INCR + TTL. Self-healing: if a process died between INCR and PEXPIRE the
// key would have no TTL and block that client forever, so any hit that finds
// no TTL sets one.
function redisStore(redis) {
  return {
    async hit(key, windowSeconds) {
      const count = await redis.incr(key);
      let ttlMs = await redis.pttl(key);
      if (ttlMs < 0) {
        await redis.pexpire(key, windowSeconds * 1000);
        ttlMs = windowSeconds * 1000;
      }
      return { count, resetInMs: ttlMs };
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
      'X-RateLimit-Remaining': String(Math.max(0, limit - hit.count)),
      'X-RateLimit-Reset': String(resetSeconds),
    });
    if (hit.count > limit) {
      return next(new AppError(429, 'RATE_LIMITED', `too many requests, retry in ${resetSeconds}s`,
        { 'Retry-After': String(resetSeconds) }));
    }
    next();
  };
}

module.exports = { rateLimit, memoryStore, redisStore };
