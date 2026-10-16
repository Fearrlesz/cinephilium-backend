const express = require('express');
const { body, validationResult } = require('express-validator');
const Comment = require('../models/Comment');
const Film    = require('../models/Film');
const { authenticate }     = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, extractBearer, verifyToken } = require('../middleware/security');
const User = require('../models/User');
const { addPoints } = require('../utils/points');
const { existsById, updateAchievements } = require('../utils/helpers');

const router = express.Router();

// POST /api/comments
router.post('/', writeLimiter, [
  body('filmId').isMongoId().withMessage('Некорректный ID фильма'),
  body('text').notEmpty().isLength({ max: 1000 }).withMessage('Текст не длиннее 1000 символов'),
  body('parentId').optional().isMongoId().withMessage('Некорректный ID родительского комментария')
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { filmId, text, parentId } = req.body;

    const film = await Film.findById(filmId);
    if (!film) return res.status(404).json({ error: 'Фильм не найден' });

    if (parentId) {
      const parentExists = await existsById(Comment, parentId);
      if (!parentExists) return res.status(404).json({ error: 'Родительский комментарий не найден' });
    }

    const comment = new Comment({ userId: req.userId, filmId, text, parentId, status: 'pending' });
    await comment.save();

    const commentWithUser = await Comment.findById(comment._id).populate('userId', 'nickname isAdmin');
    res.json(commentWithUser);
  } catch (error) {
    console.error('Ошибка добавления комментария:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// GET /api/comments/:filmId
router.get('/:filmId', validateObjectId('filmId'), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

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
    console.error('Ошибка загрузки комментариев:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// POST /api/comments/:id/like
router.post('/:id/like', writeLimiter, validateObjectId('id'), authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

    if (comment.userId.equals(req.userId)) {
      return res.status(400).json({ error: 'Нельзя лайкать себя' });
    }

    if (comment.likes.includes(req.userId)) {
      return res.status(400).json({ error: 'Вы уже лайкнули этот комментарий' });
    }

    comment.likes.push(req.userId);
    await comment.save();

    const points = req.isAdmin ? 3 : 1;
    await addPoints(comment.userId, req.userId, 'like', points, comment._id);
    await updateAchievements(comment.userId);

    res.json({ liked: true, likes: comment.likes.length });
  } catch (error) {
    console.error('Ошибка лайка комментария:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
