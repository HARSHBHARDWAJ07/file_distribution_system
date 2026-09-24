const jwt = require('jsonwebtoken');

const ACCESS_TOKEN_TTL = '15m';
const JWT_SECRET = process.env.JWT_SECRET;

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { signAccessToken, verifyAccessToken };
