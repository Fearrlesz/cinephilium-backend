const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const {
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  JWT_ACCESS_TTL,
  JWT_REFRESH_TTL_DAYS
} = require('../config/env');

function signAccessToken(userId) {
  return jwt.sign({ userId: String(userId), type: 'access' }, JWT_ACCESS_SECRET, {
    expiresIn: JWT_ACCESS_TTL,
    algorithm: 'HS256'
  });
}

function signRefreshToken(userId, sessionId) {
  return jwt.sign({
    userId: String(userId),
    sessionId: String(sessionId),
    type: 'refresh',
    jti: randomUUID()
  }, JWT_REFRESH_SECRET, {
    expiresIn: `${JWT_REFRESH_TTL_DAYS}d`,
    algorithm: 'HS256'
  });
}

function verifyAccessToken(token) {
  const decoded = jwt.verify(token, JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
  if (decoded.type !== 'access' || !decoded.userId) {
    throw new jwt.JsonWebTokenError('Invalid access token');
  }
  return { userId: decoded.userId };
}

function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
  if (decoded.type !== 'refresh' || !decoded.userId || !decoded.sessionId) {
    throw new jwt.JsonWebTokenError('Invalid refresh token');
  }
  return { userId: decoded.userId, sessionId: decoded.sessionId };
}

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken };