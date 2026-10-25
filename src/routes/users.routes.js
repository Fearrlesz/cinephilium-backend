const express = require('express');
const mongoose = require('mongoose');
const User    = require('../models/User');
const Rating  = require('../models/Rating');
const Review  = require('../models/Review');
const Comment = require('../models/Comment');
const { validateObjectId } = require('../middleware/validate');
const { extractBearer } = require('../middleware/security');
const { verifyAccessToken } = require('../utils/jwt');
const { EXCLUSIVE_NICKNAME } = require('../config/env');
const { getUserAchievements } = require('../utils/achievements');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// GET /api/users/:id
router.get('/:id', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const userId = req.params.id;
    const user = await User.findById(userId).select('-password');
    if (!user) throw new NotFoundError('Пользователь не найден');

    const ratings  = await Rating.find({ userId }).populate('filmId', 'title poster year');
    const reviews  = await Review.find({ userId })
      .populate('filmId', 'title poster year')
      .populate('ratingId');
    const comments = await Comment.find({ userId }).populate('filmId', 'title');

    let isOwnProfile = false;
    const token = extractBearer(req);
    if (token) {
      try {
        const decoded = verifyAccessToken(token);
        // 🐛 ФИКС: приведение к строке для надёжного сравнения
        isOwnProfile = String(decoded.userId) === String(userId);
      } catch { /* игнор */ }
    }

    res.json({
      user: {
        id: user._id,
        nickname: user.nickname,
        avatar: user.avatar,
        registeredAt: user.registeredAt,
        isAdmin: user.isAdmin,
        totalPoints: user.totalPoints,
        achievements: user.achievements || [],
        email: isOwnProfile ? user.email : undefined,
        isExclusive: user.nickname === EXCLUSIVE_NICKNAME
      },
      ratings: ratings.map(r => ({
        id: r._id,
        film: r.filmId,
        technicalScore: r.technicalScore,
        combinedScore:  r.combinedScore,
        vibe:           r.vibe,
        genrePreset:    r.genrePreset,
        blockWeights:   r.blockWeights,
        scores:         r.scores,
        textReview:     r.textReview,
        createdAt:      r.createdAt
      })),
      reviews: reviews.map(r => ({
        _id: r._id,
        id: r._id,
        film: r.filmId,
        filmId: r.filmId,
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
  } catch (error) {
    throw error;
  }
}));

// GET /api/users/:id/achievements
router.get('/:id/achievements', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const userId = req.params.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const user = await User.findById(userId).select('achievements nickname counters');
    if (!user) throw new NotFoundError('Пользователь не найден');

    const ratingsCount  = user.counters?.ratings || 0;
    const reviewsCount  = user.counters?.reviewsApproved || 0;
    const commentsCount = user.counters?.commentsApproved || 0;

    const allPossible = await getUserAchievements(
      userObjectId,
      mongoose.connection.db,
      ratingsCount,
      reviewsCount,
      commentsCount
    );

    res.json({
      nickname: user.nickname,
      earned: user.achievements || [],
      possible: allPossible,
      progress: { ratings: ratingsCount, reviews: reviewsCount, comments: commentsCount }
    });
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
