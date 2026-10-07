const jwt = require('jsonwebtoken');
const { AppError } = require('@cloudstore/http-utils');

// jwtSecret must match auth-service's secret.
function requireAuth(jwtSecret) {
  if (!jwtSecret) throw new Error('JWT_SECRET must be set'); // otherwise every token "fails" confusingly

  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return next(new AppError(401, 'MISSING_TOKEN', 'authorization header is required'));
    }

    try {
      // Pinned algorithm: rejects "alg: none" and algorithm-confusion tokens,
      // including ones validly signed with our secret under another algorithm.
      const decoded = jwt.verify(header.slice('Bearer '.length), jwtSecret, { algorithms: ['HS256'] });
      if (typeof decoded.sub !== 'string') throw new jwt.JsonWebTokenError('token has no subject');
      req.user = { id: decoded.sub, email: decoded.email };
      next();
    } catch (err) {
      const expired = err.name === 'TokenExpiredError';
      next(new AppError(401, expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        expired ? 'access token has expired' : 'access token is invalid'));
    }
  };
}

module.exports = { requireAuth };
