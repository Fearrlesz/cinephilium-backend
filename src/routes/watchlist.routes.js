const express = require('express');
const mongoose = require('mongoose');
const WatchlistItem = require('../models/WatchlistItem');
const Film = require('../models/Film');
const { authenticate } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, watchlistLimiter } = require('../middleware/security');
const { incCounter } = require('../utils/counters');
const { listWatchlist } = require('../utils/watchlistQuery');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// POST /api/watchlist — добавить фильм в «хочу посмотреть».
//
// DECISION: B6/unique — уникальность (userId, filmId) это фича, а не ограничение:
// повторное добавление не 409, а текущее состояние { inWatchlist: true }.
// Двойной клик не наказывается, гонка двух POST разрешается уникальным индексом.
//
// DECISION: B6/not-gated — не гейтится ни оценкой (B3/B4), ни приватностью:
// это самое дешёвое действие в системе, а свой список доступен владельцу всегда.
//
// DECISION: B6/event — событие в ленту не создаётся: watchlist — намерение,
// а не действие (в отличие от оценки/рецензии/комментария).
//
// DECISION: B6/2A — достижения не трогаем и updateAchievements не вызываем:
// намерение не кормит геймификацию, отдельной ачивки нет.
//
// DECISION: B6/6B — лимитер watchlistLimiter: 200 добавлений в час на АККАУНТ
// (ключ userId), а не на IP. Инфраструктура лимитеров это выдержала без переделки:
// лимитер стоит после authenticate.
router.post('/', writeLimiter, authenticate, watchlistLimiter, asyncHandler(async (req, res, next) => {
  const { filmId } = req.body || {};

  if (!filmId || !mongoose.Types.ObjectId.isValid(String(filmId))) {
    throw new ValidationError('Некорректный filmId');
  }

  const film = await Film.findById(filmId);
  if (!film) throw new NotFoundError('Фильм не найден');

  const existing = await WatchlistItem.findOne({ userId: req.userId, filmId });
  if (existing) {
    return res.json({ inWatchlist: true, filmId: String(film._id), addedAt: existing.addedAt });
  }

  let item;
  try {
    item = await WatchlistItem.create({ userId: req.userId, filmId });
  } catch (error) {
    // Гонка двух одновременных POST: уникальный индекс пропустил только один.
    // Второй запрос — не ошибка, а тот же результат: фильм уже в списке.
    if (error?.code === 11000) {
      const raced = await WatchlistItem.findOne({ userId: req.userId, filmId });
      return res.json({ inWatchlist: true, filmId: String(film._id), addedAt: raced?.addedAt });
    }
    throw error;
  }

  await incCounter(req.userId, 'watchlist', 1);

  res.status(201).json({ inWatchlist: true, filmId: String(film._id), addedAt: item.addedAt });
}));

// GET /api/watchlist/user — свой список. Приватность не гейтит (B6/not-gated).
router.get('/user', authenticate, asyncHandler(async (req, res, next) => {
  res.json(await listWatchlist(req.userId, req.query, req));
}));

// GET /api/watchlist/check/:filmId — состояние кнопки на странице фильма.
router.get('/check/:filmId', authenticate, validateObjectId('filmId'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const exists = await WatchlistItem.exists({ userId: req.userId, filmId: req.params.filmId });
  res.json({ inWatchlist: Boolean(exists), filmId: req.params.filmId });
}));

// DELETE /api/watchlist/:id — убрать из списка.
//
// DECISION: B6/1A — идемпотентно: несуществующая (или уже удалённая) запись даёт
// 200 и { inWatchlist: false } — то же состояние, что после успешного удаления.
// Никакого 404 на «уже удалено» и никакого { deleted: bool }: клиент всегда получает
// актуальное состояние. Счётчик не уходит в минус — incCounter это гарантирует.
//
// Чужую запись не трогаем и не подтверждаем её существование: 404.
router.delete('/:id', writeLimiter, authenticate, validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const item = await WatchlistItem.findById(req.params.id);
  if (!item) return res.json({ inWatchlist: false });

  if (String(item.userId) !== String(req.userId)) {
    throw new NotFoundError('Запись не найдена');
  }

  await WatchlistItem.deleteOne({ _id: item._id });
  await incCounter(req.userId, 'watchlist', -1);

  res.json({ inWatchlist: false });
}));

module.exports = router;
