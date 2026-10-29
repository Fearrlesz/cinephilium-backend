const express = require('express');
const mongoose = require('mongoose');
const User    = require('../models/User');
const Rating  = require('../models/Rating');
const Review  = require('../models/Review');
const Comment = require('../models/Comment');
const { authenticate } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { extractBearer } = require('../middleware/security');
const { verifyAccessToken } = require('../utils/jwt');
const { EXCLUSIVE_NICKNAME } = require('../config/env');
const { getUserAchievements } = require('../utils/achievements');
const { withPosterUrl } = require('../utils/poster');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

async function sendProfile(req, res, userId) {
  const user = await User.findById(userId).select('-password');
  if (!user) throw new NotFoundError('Пользователь не найден');

  let isOwnProfile = false;
  let isAdmin = false;
  const token = extractBearer(req);
  if (token) {
    try {
      const decoded = verifyAccessToken(token);
      // 🐛 ФИКС: приведение к строке для надёжного сравнения
      isOwnProfile = String(decoded.userId) === String(userId);
      if (!isOwnProfile) {
        const viewer = await User.findById(decoded.userId).select('isAdmin');
        isAdmin = viewer?.isAdmin || false;
      }
    } catch { /* игнор */ }
  }

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

// GET /api/users/nickname/:nickname — поиск профиля по никнейму (страница критика).
// Отдаём компактный lookup: фронтенд использует его только чтобы получить _id.
router.get('/nickname/:nickname', asyncHandler(async (req, res) => {
  const nickname = String(req.params.nickname || '').trim();
  if (!nickname) throw new NotFoundError('Пользователь не найден');

  const found = await User.findOne({ nickname }).select('_id nickname avatar');
  if (!found) throw new NotFoundError('Пользователь не найден');

  res.json({
    _id: found._id,
    id: found._id,
    nickname: found.nickname,
    avatar: found.avatar
  });
}));

// GET /api/users/:id
router.get('/:id', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;
  await sendProfile(req, res, req.params.id);
}));

// GET /api/users/:id/achievements
router.get('/:id/achievements', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;
  await sendAchievements(res, req.params.id);
}));

module.exports = router;
