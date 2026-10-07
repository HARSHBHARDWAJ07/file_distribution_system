const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_TTL = '15m';
const JWT_SECRET = process.env.JWT_SECRET;

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' });
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

module.exports = { signAccessToken, verifyAccessToken };
