const jwt = require('jsonwebtoken');
const { fail } = require('@cloudstore/shared-types');

// jwtSecret must match auth-service's secret.
function requireAuth(jwtSecret) {
  if (!jwtSecret) throw new Error('JWT_SECRET must be set'); // otherwise every token "fails" confusingly

  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json(fail('MISSING_TOKEN', 'authorization header is required'));
    }

    const token = header.slice('Bearer '.length);
    try {
      const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
      if (typeof decoded.sub !== 'string') throw new jwt.JsonWebTokenError('token has no subject');
      req.user = { id: decoded.sub, email: decoded.email };
      next();
    } catch (err) {
      const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
      return res.status(401).json(fail(code, 'access token is invalid or expired'));
    }
  };
}

module.exports = { requireAuth };
