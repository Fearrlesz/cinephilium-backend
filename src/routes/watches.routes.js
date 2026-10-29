const express = require('express');
const mongoose = require('mongoose');
const Watch = require('../models/Watch');
const Film  = require('../models/Film');
const User  = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, extractBearer } = require('../middleware/security');
const { verifyAccessToken } = require('../utils/jwt');
const { incCounter } = require('../utils/counters');
const { withPosterUrl } = require('../utils/poster');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ValidationError, AppError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 30;
const MAX_LIMIT = 100;

// Нормализация тегов: trim, выкинуть пустые, схлопнуть дубли без учёта регистра,
// сохранив первое написание. Превышение лимитов — 400, а не молчаливое обрезание:
// иначе пользователь не поймёт, почему теги пропали.
function normalizeTags(rawTags) {
  if (rawTags === undefined || rawTags === null) return [];
  if (!Array.isArray(rawTags)) throw new ValidationError('tags должен быть массивом строк');

  const result = [];
  const seen = new Set();

  for (const raw of rawTags) {
    if (typeof raw !== 'string') throw new ValidationError('Каждый тег должен быть строкой');
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      throw new ValidationError(`Тег длиннее ${MAX_TAG_LENGTH} символов`);
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }

  if (result.length > MAX_TAGS) throw new ValidationError(`Не больше ${MAX_TAGS} тегов на запись`);
  return result;
}

// Дата просмотра: прошлое — норма (люди заносят старые просмотры задним числом),
// будущего не бывает. Разрешаем любой момент сегодняшнего дня по серверному
// времени, запрещаем начиная с завтрашнего: «отметил, что посмотрю завтра» —
// это watchlist, а не дневник.
function parseWatchedAt(value) {
  if (value === undefined || value === null || value === '') return new Date();

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError('Некорректная дата просмотра');

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  if (date.getTime() > endOfToday.getTime()) {
    throw new ValidationError('Дата просмотра не может быть в будущем');
  }

  return date;
}

function parseBoolean(value, field) {
  if (value === undefined) return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new ValidationError(`${field} должен быть true или false`);
}

function parsePaging(query = {}) {
  const page  = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function presentWatch(watch, req) {
  const object = typeof watch.toObject === 'function' ? watch.toObject() : { ...watch };
  if (object.filmId && typeof object.filmId === 'object' && object.filmId.title) {
    object.filmId = withPosterUrl(object.filmId, req);
  }
  return object;
}

async function loadViewer(req) {
  let viewerId = null;
  let isAdmin = false;

  const token = extractBearer(req);
  if (token) {
    try {
      const decoded = verifyAccessToken(token);
      viewerId = decoded.userId;
      const viewer = await User.findById(viewerId).select('isAdmin');
      isAdmin = viewer?.isAdmin || false;
    } catch { /* игнор: публичный дневник доступен и без токена */ }
  }

  return { viewerId, isAdmin };
}

// POST /api/watches — отметить просмотр.
// Не гейтится ничем: это самое дешёвое действие в системе, дешевле vibe.
// DECISION: B5/8 — оценка НЕ создаёт запись дневника автоматически: дата
// «сегодня» была бы ложью о реальном просмотре. Связь появляется только
// по явному watchId при создании оценки/рецензии (B5/2).
// DECISION: B5/5 — событие в общую ленту не создаётся: дневник — память,
// а не сигнал, и пересмотры не должны забивать поток.
router.post('/', writeLimiter, authenticate, asyncHandler(async (req, res, next) => {
  const body = req.body || {};
  const { filmId } = body;

  if (!filmId || !mongoose.Types.ObjectId.isValid(String(filmId))) {
    throw new ValidationError('Некорректный filmId');
  }

  const film = await Film.findById(filmId);
  if (!film) throw new NotFoundError('Фильм не найден');

  const watch = await Watch.create({
    userId: req.userId,
    filmId,
    watchedAt: parseWatchedAt(body.watchedAt),
    // DECISION: B5/4 — пересмотр ставит пользователь.
    isRewatch: parseBoolean(body.isRewatch, 'isRewatch'),
    tags: normalizeTags(body.tags)
  });

  await incCounter(req.userId, 'watches', 1);

  res.status(201).json(presentWatch(watch, req));
}));

// GET /api/watches/me — свой дневник.
router.get('/me', authenticate, asyncHandler(async (req, res, next) => {
  const { page, limit, skip } = parsePaging(req.query);

  const [items, total] = await Promise.all([
    Watch.find({ userId: req.userId })
      .populate('filmId', 'title poster posterPath year')
      .sort({ watchedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Watch.countDocuments({ userId: req.userId })
  ]);

  res.json({
    items: items.map(watch => presentWatch(watch, req)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  });
}));

// GET /api/watches/user/:userId — публичный дневник.
// DECISION: B5/3 — дневник открыт по умолчанию, но владелец может его закрыть.
// Закрытый отдаётся только владельцу и админу; остальным — 403 DIARY_PRIVATE,
// чтобы фронт показал «дневник закрыт», а не пустоту.
router.get('/user/:userId', validateObjectId('userId'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const target = await User.findById(req.params.userId).select('diaryPrivate');
  if (!target) throw new NotFoundError('Пользователь не найден');

  const { viewerId, isAdmin } = await loadViewer(req);
  const isOwner = Boolean(viewerId) && String(viewerId) === String(target._id);

  if (target.diaryPrivate && !isOwner && !isAdmin) {
    throw new AppError('DIARY_PRIVATE', 'Пользователь закрыл свой дневник', 403);
  }

  const { page, limit, skip } = parsePaging(req.query);
  const filter = { userId: target._id };

  const [items, total] = await Promise.all([
    Watch.find(filter)
      .populate('filmId', 'title poster posterPath year')
      .sort({ watchedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Watch.countDocuments(filter)
  ]);

  res.json({
    items: items.map(watch => presentWatch(watch, req)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    private: target.diaryPrivate === true
  });
}));

// PATCH /api/watches/settings — открыть/закрыть дневник.
router.patch('/settings', authenticate, asyncHandler(async (req, res, next) => {
  const value = req.body?.private;
  if (value === undefined) throw new ValidationError('Нужно поле private');

  const isPrivate = parseBoolean(value, 'private');
  await User.updateOne({ _id: req.userId }, { $set: { diaryPrivate: isPrivate } });

  res.json({ private: isPrivate });
}));

// DELETE /api/watches/:id — удалить свою запись.
// Чужую отдаём как 404, чтобы не подтверждать существование записи.
// Каскада нет: удаление записи дневника не трогает связанную оценку/рецензию —
// это разные сущности со своим жизненным циклом.
router.delete('/:id', writeLimiter, authenticate, validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const watch = await Watch.findById(req.params.id);
  if (!watch || String(watch.userId) !== String(req.userId)) {
    throw new NotFoundError('Запись дневника не найдена');
  }

  await Watch.deleteOne({ _id: watch._id });
  await incCounter(req.userId, 'watches', -1);

  res.json({ deleted: true, id: watch._id });
}));

module.exports = router;
