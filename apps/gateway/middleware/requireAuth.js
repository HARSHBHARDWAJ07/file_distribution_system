const jwt = require('jsonwebtoken');
const { fail } = require('@cloudstore/shared-types');

const JWT_SECRET = process.env.JWT_SECRET; // must match auth-service's secret

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json(fail('MISSING_TOKEN', 'authorization header is required'));
  }

  const token = header.slice('Bearer '.length);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.sub, email: decoded.email };
    next();
  } catch (err) {
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    return res.status(401).json(fail(code, 'access token is invalid or expired'));
  }
}

module.exports = { requireAuth };
