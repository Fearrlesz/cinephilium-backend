// middleware/security.js
// Централизованный набор middleware для безопасности Express-приложения.

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

/* ============================================================
   1. Helmet — защитные HTTP-заголовки
   ============================================================
   Ставит X-Frame-Options, X-Content-Type-Options, HSTS и др.
   CSP отключаем — HTML отдаёт фронтенд (Vercel), не этот сервер.
   crossOriginResourcePolicy: 'cross-origin' — чтобы прокси постеров
   с этого домена можно было грузить с фронта на другом домене.
*/
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
});

/* ============================================================
   2. Общий rate limiter — защита от флуда и DoS
   ============================================================ */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 минута
  limit: 200,                // 200 запросов с одного IP за минуту
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много запросов, попробуйте позже' }
});

/* ============================================================
   3. Жёсткий лимит для авторизации — защита от брутфорса
   ============================================================ */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 минут
  limit: 10,                 // 10 попыток логина/регистрации с одного IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true, // успешные попытки не считаются
  message: { error: 'Слишком много попыток входа. Попробуйте через 15 минут' }
});

/* ============================================================
   4. Лимит для записи (создание контента)
   ============================================================ */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,                 // 30 созданий/лайков в минуту
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много действий, замедлитесь' }
});

/* ============================================================
   5. Ограничение размера JSON-тела
   ============================================================ */
const bodyLimit = '100kb';

/* ============================================================
   6. Защита от NoSQL-инъекций
   ============================================================
   Рекурсивно вычищает ключи, начинающиеся с "$", и точки "." из
   req.body / req.query / req.params. Это те самые символы, через
   которые MongoDB-операторы ($ne, $gt, $where, ...) обходят логику.
*/
function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
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

  // req.query / req.params в Express 4 — геттеры, в Express 5 — getter-only.
  // Поэтому подменяем их через defineProperty (own data property),
  // чтобы очищенное значение реально сохранилось на объекте запроса.
  for (const prop of ['query', 'params']) {
    if (req[prop] && typeof req[prop] === 'object') {
      const cleaned = sanitizeValue(req[prop]);
      Object.defineProperty(req, prop, {
        value: cleaned,
        writable: true,
        configurable: true,
        enumerable: true
      });
    }
  }

  next();
}

/* ============================================================
   7. Защита от подделки JWT (alg: none)
   ============================================================
   Жёстко фиксируем HS256. Без этой опции атакующий мог бы подсунуть
   токен с {"alg":"none"} и обойти проверку подписи.
*/
function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, {
    algorithms: ['HS256']
  });
}

/* ============================================================
   8. Хелпер: извлечение Bearer-токена
   ============================================================ */
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
