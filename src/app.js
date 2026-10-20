const express = require('express');
const mongoose = require('mongoose');

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
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const asyncHandler = require('./utils/asyncHandler');

mongoose.set('strictQuery', false);

const app = express();

app.use(express.json());

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

// ===== HEALTHCHECK =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

if (process.env.NODE_ENV === 'test') {
  app.get('/api/test/internal-error', asyncHandler(async () => {
    throw new Error('boom');
  }));
}

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
