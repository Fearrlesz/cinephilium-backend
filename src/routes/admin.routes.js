const express = require('express');
const { body } = require('express-validator');
const User    = require('../models/User');
const Comment = require('../models/Comment');
const Review  = require('../models/Review');
const { authenticate, isAdmin } = require('../middleware/auth');
const { addPoints } = require('../utils/points');
const { incCounter } = require('../utils/counters');
const { createEvent, updateAchievements } = require('../utils/helpers');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ForbiddenError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// POST /api/admin/make — активация админа через секретный ключ
router.post('/make', [
  body('secretKey').notEmpty().withMessage('Введите секретный ключ')
], authenticate, asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const { secretKey } = req.body;
    const adminSecret = process.env.ADMIN_SECRET_KEY;

    if (!adminSecret) {
      throw new Error('ADMIN_SECRET_KEY is not configured');
    }

    if (secretKey !== adminSecret) {
      throw new ForbiddenError('Неверный секретный ключ');
    }

    const user = await User.findById(req.userId);
    if (!user) throw new NotFoundError('Пользователь не найден');

    if (user.isAdmin) {
      return res.json({ message: 'Вы уже являетесь администратором', isAdmin: true });
    }

    user.isAdmin = true;
    await user.save();

    await addPoints(req.userId, req.userId, 'admin_bonus', 100, user._id);
    await updateAchievements(req.userId);

    const updatedUser = await User.findById(req.userId).select('totalPoints');
    res.json({
      message: 'Поздравляю! Вы теперь администратор! 👑',
      isAdmin: true,
      totalPoints: updatedUser.totalPoints
    });
  } catch (error) {
    throw error;
  }
}));

// ─── МОДЕРАЦИЯ ───────────────────────────────────────────

// GET /api/admin/pending/comments
router.get('/pending/comments', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const comments = await Comment.find({ status: 'pending' })
      .populate('userId', 'nickname')
      .populate('filmId', 'title');
    res.json(comments);
  } catch (error) {
    throw error;
  }
}));

// GET /api/admin/pending/reviews
router.get('/pending/reviews', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const reviews = await Review.find({ status: 'pending' })
      .populate('userId', 'nickname')
      .populate('filmId', 'title');
    res.json(reviews);
  } catch (error) {
    throw error;
  }
}));

// PUT /api/admin/comments/:id/approve
router.put('/comments/:id/approve', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const before = await Comment.findById(req.params.id).select('status userId').lean();
    if (!before) throw new NotFoundError('Комментарий не найден');
    await Comment.updateOne({ _id: req.params.id }, { $set: { status: 'approved' } });
    const comment = await Comment.findById(req.params.id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title');
    if (before.status !== 'approved') await incCounter(before.userId, 'commentsApproved', 1);

    const authorIsAdmin = comment.userId?.isAdmin || false;
    const authorPoints = authorIsAdmin ? 10 : 2;

    await addPoints(comment.userId._id, comment.userId._id, 'comment', authorPoints, comment._id);
    await createEvent('comment', comment.userId.nickname, comment.filmId.title, comment.filmId._id, null, comment._id);
    await updateAchievements(comment.userId._id);

    res.json(comment);
  } catch (error) {
    throw error;
  }
}));

// PUT /api/admin/comments/:id/reject
router.put('/comments/:id/reject', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const before = await Comment.findById(req.params.id).select('status userId').lean();
    if (!before) throw new NotFoundError('Комментарий не найден');
    await Comment.updateOne({ _id: req.params.id }, { $set: { status: 'rejected' } });
    const comment = await Comment.findById(req.params.id).populate('userId', 'nickname');
    if (before.status === 'approved') await incCounter(before.userId, 'commentsApproved', -1);

    res.json(comment);
  } catch (error) {
    throw error;
  }
}));

// PUT /api/admin/reviews/:id/approve
router.put('/reviews/:id/approve', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const before = await Review.findById(req.params.id).select('status userId').lean();
    if (!before) throw new NotFoundError('Рецензия не найдена');
    await Review.updateOne({ _id: req.params.id }, { $set: { status: 'approved' } });
    const review = await Review.findById(req.params.id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title');
    if (before.status !== 'approved') await incCounter(before.userId, 'reviewsApproved', 1);

    const authorIsAdmin = review.userId?.isAdmin || false;
    const authorPoints = authorIsAdmin ? 50 : 30;

    await addPoints(review.userId._id, review.userId._id, 'review', authorPoints, review._id);
    await createEvent('review', review.userId.nickname, review.filmId.title, review.filmId._id, null, review._id);
    await updateAchievements(review.userId._id);

    res.json(review);
  } catch (error) {
    throw error;
  }
}));

// PUT /api/admin/reviews/:id/reject
router.put('/reviews/:id/reject', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const before = await Review.findById(req.params.id).select('status userId').lean();
    if (!before) throw new NotFoundError('Рецензия не найдена');
    await Review.updateOne({ _id: req.params.id }, { $set: { status: 'rejected' } });
    const review = await Review.findById(req.params.id)
      .populate('userId', 'nickname')
      .populate('filmId', 'title');
    if (before.status === 'approved') await incCounter(before.userId, 'reviewsApproved', -1);

    res.json(review);
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
