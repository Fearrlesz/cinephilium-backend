// middleware/security.js
// Централизованный набор middleware для безопасности Express-приложения.

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

/* 1. Helmet */
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
});

/* 2. Общий rate limiter */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте позже' }
});

/* 3. Жёсткий лимит для авторизации */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Слишком много попыток входа. Попробуйте через 15 минут' }
});

/* 4. Лимит для записи */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много действий, замедлитесь' }
});

/* 5. Ограничение размера JSON-тела */
const bodyLimit = '100kb';

/* 6. Защита от NoSQL-инъекций */
function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const clean = {};
    for (const key of Object.keys(value)) {
      if (key.startsWith('$') || key.includes('.')) continue;
      clean[key] = sanitizeValue(value[key]);
    }
    return clean;
  }
  return value;
}

function noSqlSanitizer(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }

  for (const prop of ['query', 'params']) {
    if (req[prop] && typeof req[prop] === 'object') {
      const cleaned = sanitizeValue(req[prop]);
      try {
        Object.defineProperty(req, prop, {
          value: cleaned,
          writable: true,
          configurable: true,
          enumerable: true
        });
      } catch (err) {
        console.warn(`⚠️ Не удалось перезаписать req.${prop}:`, err.message);
      }
    }
  }

  next();
}

/* 7. Защита от подделки JWT (alg: none) */
function verifyToken(token) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET не установлен — генерация и проверка токенов невозможны');
  }
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
}

/* 8. Хелпер: извлечение Bearer-токена */
function extractBearer(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

module.exports = {
  helmetMiddleware,
  globalLimiter,
  authLimiter,
  writeLimiter,
  bodyLimit,
  noSqlSanitizer,
  verifyToken,
  extractBearer
};
