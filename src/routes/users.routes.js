const express = require('express');
const mongoose = require('mongoose');
const User    = require('../models/User');
const Rating  = require('../models/Rating');
const Review  = require('../models/Review');
const Comment = require('../models/Comment');
const PrivacyChangeLog = require('../models/PrivacyChangeLog');
const { authenticate } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, extractBearer } = require('../middleware/security');
const { verifyAccessToken } = require('../utils/jwt');
const { EXCLUSIVE_NICKNAME } = require('../config/env');
const { getUserAchievements } = require('../utils/achievements');
const { withPosterUrl } = require('../utils/poster');
const { HIDDEN_FIELDS, privacyOf, canViewProfile, hiddenProfileStub } = require('../utils/privacy');
const { listDiary } = require('../utils/diaryQuery');
const { listWatchlist } = require('../utils/watchlistQuery');
const { listLikes } = require('../utils/filmLikesQuery');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ValidationError, AppError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

/**
 * Зритель из токена: `null` для анонима.
 * @returns {Promise<{userId: string, isAdmin: boolean}|null>}
 */
async function resolveViewer(req) {
  const token = extractBearer(req);
  if (!token) return null;

  try {
    const decoded = verifyAccessToken(token);
    const viewer = await User.findById(decoded.userId).select('isAdmin');
    return { userId: decoded.userId, isAdmin: viewer?.isAdmin || false };
  } catch {
    return null;
  }
}

async function sendProfile(req, res, userId) {
  const user = await User.findById(userId).select('-password');
  if (!user) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);

  // DECISION: B-PRIVACY/A2 — при скрытом профиле посторонний видит только
  // заглушку (E2): ник и аватар. Ни counters, ни достижений, ни оценок,
  // ни дневника в ответе нет — это личные разделы. Рецензии и комментарии
  // продолжают жить там, где опубликованы (C2).
  if (!canViewProfile(viewer, user)) {
    return res.json({ user: hiddenProfileStub(user) });
  }

  const isOwnProfile = Boolean(viewer) && String(viewer.userId) === String(user._id);
  const isAdmin = Boolean(viewer?.isAdmin);

  // Чужие черновики и отклонённые материалы не показываем: полный список
  // доступен только владельцу профиля и администратору.
  const statusFilter = isOwnProfile || isAdmin ? {} : { status: 'approved' };

  const ratings  = await Rating.find({ userId }).populate('filmId', 'title poster posterPath year');
  const reviews  = await Review.find({ userId, ...statusFilter })
    .populate('filmId', 'title poster posterPath year')
    .populate('ratingId');
  const comments = await Comment.find({ userId, ...statusFilter }).populate('filmId', 'title');

  res.json({
    user: {
      id: user._id,
      nickname: user.nickname,
      avatar: user.avatar,
      registeredAt: user.registeredAt,
      isAdmin: user.isAdmin,
      totalPoints: user.totalPoints,
      counters: user.counters || {},
      // B5: фронт должен знать, что дневник закрыт, иначе покажет пустоту
      // вместо «дневник закрыт». Само значение не секрет — это настройка видимости.
      diaryPrivate: user.diaryPrivate === true,
      achievements: user.achievements || [],
      email: isOwnProfile ? user.email : undefined,
      isExclusive: user.nickname === EXCLUSIVE_NICKNAME
    },
    // DECISION: B2/5B — разделение осей в профиле и ленте остаётся вне B2.
    // Бэк уже отдаёт completeness рядом с баллами, поэтому «ноль как балл» —
    // дефект отрисовки на фронте (F1), а не отсутствие данных в контракте.
    // Менять 0 на null здесь нельзя: это отменило бы DECISION 2A.
    ratings: ratings.map(r => ({
      id: r._id,
      film: withPosterUrl(r.filmId, req),
      technicalScore: r.technicalScore,
      combinedScore:  r.combinedScore,
      vibe:           r.vibe,
      completeness:   r.completeness || 'full',
      genrePreset:    r.genrePreset,
      blockWeights:   r.blockWeights,
      scores:         r.scores,
      textReview:     r.textReview,
      createdAt:      r.createdAt
    })),
    reviews: reviews.map(r => ({
      _id: r._id,
      id: r._id,
      film: withPosterUrl(r.filmId, req),
      filmId: withPosterUrl(r.filmId, req),
      ratingId: r.ratingId,
      title: r.title,
      text: r.text,
      // B4: профиль перечисляет поля руками, поэтому флаг нужен здесь — иначе
      // на профиле он бы тихо терялся (остальные ответы отдают документ целиком).
      isSpoiler: r.isSpoiler === true,
      likes: r.likes,
      createdAt: r.createdAt
    })),
    comments: comments.map(c => ({
      id: c._id,
      film: c.filmId,
      text: c.text
    }))
  });
}

async function sendAchievements(res, userId) {
  const userObjectId = new mongoose.Types.ObjectId(String(userId));
  const user = await User.findById(userId).select('achievements nickname counters totalPoints');
  if (!user) throw new NotFoundError('Пользователь не найден');

  const ratingsCount  = user.counters?.ratings || 0;
  const vibesCount    = user.counters?.vibes || 0;
  const reviewsCount  = user.counters?.reviewsApproved || 0;
  const commentsCount = user.counters?.commentsApproved || 0;

  const allPossible = await getUserAchievements(
    userObjectId,
    mongoose.connection.db,
    { ratings: ratingsCount, vibes: vibesCount },
    reviewsCount,
    commentsCount
  );

  res.json({
    nickname: user.nickname,
    earned: user.achievements || [],
    possible: allPossible,
    totalPoints: user.totalPoints || 0,
    progress: {
      ratings: ratingsCount,
      vibes: vibesCount,
      reviews: reviewsCount,
      comments: commentsCount
    }
  });
}

// GET /api/users/me/achievements — должно быть объявлено ДО /:id/achievements,
// иначе "me" попадёт в :id и не пройдёт валидацию ObjectId.
router.get('/me/achievements', authenticate, asyncHandler(async (req, res) => {
  await sendAchievements(res, req.userId);
}));

// GET /api/users/me/privacy — текущее состояние флагов.
router.get('/me/privacy', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('privacy');
  if (!user) throw new NotFoundError('Пользователь не найден');
  res.json(privacyOf(user));
}));

// PUT /api/users/me/privacy — partial update { hideProfile?, hideFromFeed? }.
// DECISION: B-PRIVACY/D1 — флаги независимы: непереданный остаётся как был.
// DECISION: B-PRIVACY/G2 — лог пишется только при фактическом изменении значения.
router.put('/me/privacy', authenticate, writeLimiter, asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('privacy');
  if (!user) throw new NotFoundError('Пользователь не найден');

  const current = privacyOf(user);
  const next = { ...current };

  for (const field of HIDDEN_FIELDS) {
    const value = req.body?.[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw new ValidationError(`${field} должен быть true или false`);
    }
    next[field] = value;
  }

  const changed = HIDDEN_FIELDS.filter(field => current[field] !== next[field]);

  if (changed.length > 0) {
    const set = {};
    for (const field of changed) set[`privacy.${field}`] = next[field];
    await User.updateOne({ _id: req.userId }, { $set: set });

    await PrivacyChangeLog.insertMany(changed.map(field => ({
      userId: req.userId,
      field,
      oldValue: current[field],
      newValue: next[field],
      ip: req.ip || ''
    })));
  }

  res.json(next);
}));

// GET /api/users/me/likes — свой список «Понравившихся».
// DECISION: B7/not-gated — всегда доступен владельцу, приватность профиля его
// не гейтит: скрывается чужой взгляд, а не свой список.
// Объявлен ДО /:id/likes, иначе "me" попадёт в :id и не пройдёт валидацию ObjectId.
router.get('/me/likes', authenticate, asyncHandler(async (req, res) => {
  res.json(await listLikes(req.userId, req.query, req));
}));

// GET /api/users/nickname/:nickname — поиск профиля по никнейму (страница критика).
// Отдаём компактный lookup: фронтенд использует его только чтобы получить _id.
router.get('/nickname/:nickname', asyncHandler(async (req, res) => {
  const nickname = String(req.params.nickname || '').trim();
  if (!nickname) throw new NotFoundError('Пользователь не найден');

  const found = await User.findOne({ nickname }).select('_id nickname avatar privacy');
  if (!found) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);
  // E2: скрытый профиль отдаёт только ник и аватар — их и так видно в рецензиях.
  if (!canViewProfile(viewer, found)) return res.json(hiddenProfileStub(found));

  res.json({
    _id: found._id,
    id: found._id,
    nickname: found.nickname,
    avatar: found.avatar
  });
}));

// GET /api/users/:id/watches — публичный дневник пользователя (алиас B5-роута
// GET /api/watches/user/:userId, см. DECISION B-PRIVACY/alias).
// DECISION: B-PRIVACY/retro-fit — дневник относится к личным разделам (A2),
// поэтому при скрытом профиле без прав отдаём 404, а не заглушку.
router.get('/:id/watches', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const target = await User.findById(req.params.id).select('privacy diaryPrivate');
  if (!target) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);
  if (!canViewProfile(viewer, target)) {
    throw new AppError('PROFILE_HIDDEN', 'Профиль скрыт', 404);
  }

  const result = await listDiary(target._id, req.query, req);
  res.json({ ...result, private: target.diaryPrivate === true });
}));

// GET /api/users/:id/watchlist — публичный список «хочу посмотреть».
// DECISION: B6/4=404 — при скрытом профиле и зрителе без прав 404, как у дневника
// (B-PRIVACY/retro-fit), а не заглушка: watchlist — личный раздел (A2), а 404 —
// язык личных разделов; страница профиля при этом отдаёт заглушку.
// Проверка — через canViewProfile из utils/privacy.js, без дублирования логики.
router.get('/:id/watchlist', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const target = await User.findById(req.params.id).select('privacy');
  if (!target) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);
  if (!canViewProfile(viewer, target)) {
    throw new AppError('PROFILE_HIDDEN', 'Профиль скрыт', 404);
  }

  res.json(await listWatchlist(target._id, req.query, req));
}));

// GET /api/users/:id/likes — публичный список «Понравившихся».
// DECISION: B7/6=404 — при скрытом профиле и зрителе без прав 404, как дневник
// (B-PRIVACY/retro-fit) и watchlist (B6/4=404): «Понравившиеся» — личный раздел.
// Проверка через canViewProfile, без копии логики; ветка «друзья» появится там же.
router.get('/:id/likes', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const target = await User.findById(req.params.id).select('privacy');
  if (!target) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);
  if (!canViewProfile(viewer, target)) {
    throw new AppError('PROFILE_HIDDEN', 'Профиль скрыт', 404);
  }

  res.json(await listLikes(target._id, req.query, req));
}));

// GET /api/users/:id
router.get('/:id', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;
  await sendProfile(req, res, req.params.id);
}));

// GET /api/users/:id/achievements
router.get('/:id/achievements', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const target = await User.findById(req.params.id).select('privacy');
  if (!target) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);
  if (!canViewProfile(viewer, target)) {
    throw new AppError('PROFILE_HIDDEN', 'Профиль скрыт', 404);
  }

  await sendAchievements(res, req.params.id);
}));

module.exports = router;
