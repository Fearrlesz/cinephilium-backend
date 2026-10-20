const jwt = require('jsonwebtoken');
function verifyToken(token) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET не установлен — генерация и проверка токенов невозможны');
  }
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
}

function extractBearer(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

module.exports = {
  verifyToken,
  extractBearer
};
