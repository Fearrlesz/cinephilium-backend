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
   crossOriginEmbedderPolicy: false — чтобы не ломать загрузку
   внешних картинок (TMDB) с фронта.
*/
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
});

/* ============================================================
   2. Общий rate limiter — защита от флуда и DoS
   ============================================================
   С express-rate-limit@8+ синтаксис `limit` остался прежним,
   но добавлена корректная обработка IPv6 (CVE-2026-30827).
   ВАЖНО: на Render обязательно должен быть app.set('trust proxy', 1),
   иначе все запросы будут считаться с одного IP.
*/
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

   ВАЖНО: В Express 5 req.query и req.params — getter-only свойства.
   Их нельзя присвоить напрямую. Используем defineProperty, чтобы
   создать own data property с очищенным значением.
*/
function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === 'object') {
    const clean = {};
    for (const key of Object.keys(value)) {
      // Пропускаем ключи с $ или . (MongoDB-операторы)
      if (key.startsWith('$') || key.includes('.')) continue;
      clean[key] = sanitizeValue(value[key]);
    }
    return clean;
  }
  return value;
}

function noSqlSanitizer(req, _res, next) {
  // Очищаем body
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }

  // Очищаем query и params через defineProperty
  // (в Express 5 они getter-only, обычное присваивание не сработает)
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
        // Fallback: если defineProperty недоступен — логируем и продолжаем
        console.warn(`⚠️ Не удалось перезаписать req.${prop}:`, err.message);
      }
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
  // Защита от запуска с пустым/отсутствующим секретом
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET не установлен — генерация и проверка токенов невозможны');
  }

  return jwt.verify(token, process.env.JWT_SECRET, {
    algorithms: ['HS256']
  });
}

/* ============================================================
   8. Хелпер: извлечение Bearer-токена
   ============================================================
   Возвращает null, если заголовка нет или он не в формате "Bearer <token>".
*/
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
