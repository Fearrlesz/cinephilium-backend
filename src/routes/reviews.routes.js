const express = require('express');
const { body } = require('express-validator');
const Review  = require('../models/Review');
const Rating  = require('../models/Rating');
const Film    = require('../models/Film');
const User    = require('../models/User');
const { authenticate }     = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, extractBearer, verifyToken } = require('../middleware/security');
const { addPoints } = require('../utils/points');
const { updateAchievements } = require('../utils/helpers');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ForbiddenError, ValidationError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// POST /api/reviews
router.post('/', writeLimiter, [
  body('filmId').isMongoId().withMessage('Некорректный ID фильма'),
  body('ratingId').isMongoId().withMessage('Некорректный ID оценки'),
  body('title').notEmpty().isLength({ max: 100 }).withMessage('Заголовок не длиннее 100 символов'),
  body('text')
    .notEmpty().withMessage('Текст рецензии обязателен')
    .isLength({ min: 450 }).withMessage('Текст рецензии должен быть не короче 450 символов')
    .isLength({ max: 15000 }).withMessage('Текст рецензии не длиннее 15000 символов')
], authenticate, asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const { filmId, ratingId, title, text } = req.body;

    const film = await Film.findById(filmId);
    if (!film) throw new NotFoundError('Фильм не найден');

    const rating = await Rating.findOne({ _id: ratingId, userId: req.userId });
    if (!rating) throw new ForbiddenError('Вы не можете использовать чужую оценку для рецензии');

    const existing = await Review.findOne({ userId: req.userId, filmId });
    if (existing) throw new ValidationError('Вы уже написали рецензию на этот фильм');

    const review = new Review({ userId: req.userId, filmId, ratingId, title, text, status: 'pending' });
    await review.save();

    const reviewWithUser = await Review.findById(review._id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster')
      .populate('ratingId');

    res.json(reviewWithUser);
  } catch (error) {
    throw error;
  }
}));

// GET /api/reviews/user
router.get('/user', authenticate, asyncHandler(async (req, res, next) => {
  try {
    const reviews = await Review.find({ userId: req.userId })
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster year')
      .populate('ratingId')
      .sort({ createdAt: -1 });

    res.json(reviews);
  } catch (error) {
    throw error;
  }
}));

// GET /api/reviews/details/:id
router.get('/details/:id', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const review = await Review.findById(req.params.id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster description director actors genres year')
      .populate('ratingId');

    if (!review) throw new NotFoundError('Рецензия не найдена');

    res.json(review);
  } catch (error) {
    throw error;
  }
}));

// GET /api/reviews/:filmId
router.get('/:filmId', validateObjectId('filmId'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    let isAdmin = false;
    const token = extractBearer(req);
    if (token) {
      try {
        const decoded = verifyToken(token);
        const user = await User.findById(decoded.userId);
        isAdmin = user?.isAdmin || false;
      } catch { /* игнор */ }
    }

    const statusFilter = isAdmin ? {} : { status: 'approved' };

    const reviews = await Review.find({
      filmId: req.params.filmId,
      ...statusFilter
    })
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster')
      .populate('ratingId')
      .sort({ createdAt: -1 });

    res.json(reviews);
  } catch (error) {
    throw error;
  }
}));

// POST /api/reviews/:id/like
router.post('/:id/like', writeLimiter, validateObjectId('id'), authenticate, asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const review = await Review.findById(req.params.id);
    if (!review) throw new NotFoundError('Рецензия не найдена');

    if (review.userId.equals(req.userId)) {
      throw new ValidationError('Нельзя лайкать себя');
    }

    if (review.likes.includes(req.userId)) {
      throw new ValidationError('Вы уже лайкнули эту рецензию');
    }

    review.likes.push(req.userId);
    await review.save();

    const points = req.isAdmin ? 20 : 5;
    await addPoints(review.userId, req.userId, 'like', points, review._id);
    await updateAchievements(review.userId);

    res.json({ liked: true, likes: review.likes.length });
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
