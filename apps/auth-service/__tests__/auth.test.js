const jwt = require('jsonwebtoken');

const SECRET = 'test-secret';

function makeStore() {
  const store = new Map();
  return {
    async store(userId, tokenId) {
      store.set(`${userId}:${tokenId}`, true);
    },
    async isValid(userId, tokenId) {
      return store.get(`${userId}:${tokenId}`) === true;
    },
    async revoke(userId, tokenId) {
      store.delete(`${userId}:${tokenId}`);
    },
  };
}

describe('access token expiry', () => {
  it('accepts a freshly signed, non-expired token', () => {
    const token = jwt.sign({ sub: 'user-1' }, SECRET, { expiresIn: '15m' });
    const decoded = jwt.verify(token, SECRET);
    expect(decoded.sub).toBe('user-1');
  });

  it('rejects a token signed to expire immediately, once it has expired', done => {
    const token = jwt.sign({ sub: 'user-1' }, SECRET, { expiresIn: '1ms' });
    setTimeout(() => {
      expect(() => jwt.verify(token, SECRET)).toThrow(jwt.TokenExpiredError);
      done();
    }, 20);
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = jwt.sign({ sub: 'user-1' }, 'wrong-secret', { expiresIn: '15m' });
    expect(() => jwt.verify(token, SECRET)).toThrow(jwt.JsonWebTokenError);
  });
});

describe('refresh token rotation', () => {
  it('a rotated-out token can no longer be used a second time', async () => {
    const redis = makeStore();
    await redis.store('user-1', 'token-a');
    await redis.revoke('user-1', 'token-a'); // simulates the refresh endpoint rotating
    await redis.store('user-1', 'token-b');

    expect(await redis.isValid('user-1', 'token-a')).toBe(false); // replay fails
    expect(await redis.isValid('user-1', 'token-b')).toBe(true); // new token works
  });

  it('an unknown token id is never valid', async () => {
    const redis = makeStore();
    await redis.store('user-1', 'token-a');
    expect(await redis.isValid('user-1', 'never-issued')).toBe(false);
  });
});
