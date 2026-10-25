const express = require('express');
const { body } = require('express-validator');
const Comment = require('../models/Comment');
const Film    = require('../models/Film');
const { authenticate, requireVerified } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, extractBearer } = require('../middleware/security');
const { verifyAccessToken } = require('../utils/jwt');
const User = require('../models/User');
const { addPoints } = require('../utils/points');
const { incCounter } = require('../utils/counters');
const { updateAchievements } = require('../utils/helpers');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// POST /api/comments
router.post('/', writeLimiter, [
  body('filmId').isMongoId().withMessage('Некорректный ID фильма'),
  body('text').notEmpty().isLength({ max: 1000 }).withMessage('Текст не длиннее 1000 символов'),
  body('parentId').optional().isMongoId().withMessage('Некорректный ID родительского комментария')
], authenticate, requireVerified, asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const { filmId, text, parentId } = req.body;

    const film = await Film.findById(filmId);
    if (!film) throw new NotFoundError('Фильм не найден');

    if (parentId) {
      const parent = await Comment.findById(parentId).select('filmId');
      if (!parent) throw new NotFoundError('Родительский комментарий не найден');
      if (String(parent.filmId) !== String(film._id)) {
        throw new ValidationError('Родительский комментарий относится к другому фильму');
      }
    }

    const comment = new Comment({ userId: req.userId, filmId, text, parentId, status: 'pending' });
    await comment.save();
    await incCounter(req.userId, 'comments', 1);

    const commentWithUser = await Comment.findById(comment._id).populate('userId', 'nickname isAdmin');
    res.json(commentWithUser);
  } catch (error) {
    throw error;
  }
}));

// GET /api/comments/:filmId
router.get('/:filmId', validateObjectId('filmId'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    let isAdmin = false;
    const token = extractBearer(req);
    if (token) {
      try {
        const decoded = verifyAccessToken(token);
        const user = await User.findById(decoded.userId);
        isAdmin = user?.isAdmin || false;
      } catch { /* игнор */ }
    }

    const statusFilter = isAdmin ? {} : { status: 'approved' };

    const comments = await Comment.find({
      filmId: req.params.filmId,
      parentId: null,
      ...statusFilter
    })
      .populate('userId', 'nickname isAdmin')
      .sort({ createdAt: -1 });

    const commentIds = comments.map(c => c._id);

    const replies = await Comment.find({
      parentId: { $in: commentIds },
      ...statusFilter
    })
      .populate('userId', 'nickname isAdmin')
      .sort({ createdAt: 1 });

    const commentsWithReplies = comments.map(c => ({
      ...c.toObject(),
      replies: replies.filter(r => r.parentId.toString() === c._id.toString())
    }));

    res.json(commentsWithReplies);
  } catch (error) {
    throw error;
  }
}));

// POST /api/comments/:id/like
router.post('/:id/like', writeLimiter, validateObjectId('id'), authenticate, asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) throw new NotFoundError('Комментарий не найден');

    if (comment.userId.equals(req.userId)) {
      throw new ValidationError('Нельзя лайкать себя');
    }

    if (comment.likes.includes(req.userId)) {
      throw new ValidationError('Вы уже лайкнули этот комментарий');
    }

    comment.likes.push(req.userId);
    await comment.save();

    await incCounter(comment.userId, 'likesReceived', 1);
    const points = req.isAdmin ? 3 : 1;
    await addPoints(comment.userId, req.userId, 'like', points, comment._id);
    await updateAchievements(comment.userId);

    res.json({ liked: true, likes: comment.likes.length });
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
