const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');

// Безопасность
const {
  helmetMiddleware,
  globalLimiter,
  bodyLimit,
  noSqlSanitizer
} = require('./middleware/security');

// Конфиг
const corsMiddleware = require('./config/cors');

// Роуты
const authRoutes     = require('./routes/auth.routes');
const filmsRoutes    = require('./routes/films.routes');
const commentsRoutes = require('./routes/comments.routes');
const reviewsRoutes  = require('./routes/reviews.routes');
const ratingsRoutes  = require('./routes/ratings.routes');
const usersRoutes    = require('./routes/users.routes');
const adminRoutes    = require('./routes/admin.routes');
const tmdbRoutes     = require('./routes/tmdb.routes');
const eventsRoutes   = require('./routes/events.routes');
const topRoutes      = require('./routes/top.routes');
const contactRoutes  = require('./routes/contact.routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const asyncHandler = require('./utils/asyncHandler');

mongoose.set('strictQuery', false);

const app = express();

// ===== TRUST PROXY =====
// Критично для корректной работы express-rate-limit за reverse-proxy (Render, Heroku, nginx и т.п.)
app.set('trust proxy', 1);

// ===== CORS (до всего остального) =====
app.use(corsMiddleware);

// ===== БЕЗОПАСНОСТЬ (порядок важен!) =====
app.use(helmetMiddleware);                    // 1. заголовки
app.use(globalLimiter);                       // 2. общий лимит запросов
app.use(express.json({ limit: bodyLimit }));  // 3. парсинг тела с лимитом
app.use(cookieParser());                       // 4. cookie для refresh-токенов
app.use(noSqlSanitizer);                      // 5. санитайз ПОСЛЕ парсинга

// ===== МАРШРУТЫ =====
app.use('/api/auth',     authRoutes);
app.use('/api/films',    filmsRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/reviews',  reviewsRoutes);
app.use('/api/ratings',  ratingsRoutes);
app.use('/api/users',    usersRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/tmdb',     tmdbRoutes);
app.use('/api/events',   eventsRoutes);
app.use('/api/top',      topRoutes);
app.use('/api/contact',  contactRoutes);

// ===== HEALTHCHECK =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== ПРОКСИ ПОСТЕРОВ TMDB =====
// Тот же handler, что Vercel подхватывает из api/, но смонтированный в Express:
// без этого buildPosterUrl() отдаёт ссылки на несуществующий /api/tmdb-image.
const tmdbImageHandler = require('../api/tmdb-image');
app.get('/api/tmdb-image', tmdbImageHandler);

// Совместимость с фронтендом, который строит ссылки вида /api/poster/w500/<path>.
app.get('/api/poster/:size/*path', (req, res) => {
  const rawPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
  const compatReq = Object.create(req);
  Object.defineProperty(compatReq, 'query', {
    value: { size: req.params.size, path: '/' + String(rawPath || '').replace(/^\/+/, '') },
    enumerable: true,
    configurable: true
  });
  return tmdbImageHandler(compatReq, res);
});

if (process.env.NODE_ENV === 'test') {
  app.get('/api/test/internal-error', asyncHandler(async () => {
    throw new Error('boom');
  }));
}

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
