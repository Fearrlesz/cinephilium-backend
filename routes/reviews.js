const express = require('express');
const router = express.Router();
const Review = require('../models/Review');
const auth = require('../middleware/auth');

// GET /api/reviews/user - получить все рецензии текущего пользователя
router.get('/user', auth, async (req, res) => {
  try {
    const reviews = await Review.find({ userId: req.userId })
      .populate('filmId', 'title year poster')
      .populate('ratingId', 'finalScore')
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (error) {
    console.error('Ошибка получения рецензий пользователя:', error);
    res.status(500).json({ error: 'Не удалось загрузить рецензии' });
  }
});

// POST /api/reviews - создать рецензию
router.post('/', auth, async (req, res) => {
  try {
    const { filmId, ratingId, title, text } = req.body;
    
    const review = new Review({
      userId: req.userId,
      filmId,
      ratingId,
      title,
      text
    });
    
    await review.save();
    res.status(201).json(review);
  } catch (error) {
    console.error('Ошибка создания рецензии:', error);
    res.status(500).json({ error: 'Не удалось создать рецензию' });
  }
});

// POST /api/reviews/:id/like - лайк/дизлайк рецензии
router.post('/:id/like', auth, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) {
      return res.status(404).json({ error: 'Рецензия не найдена' });
    }
    
    const userId = req.userId;
    const likeIndex = review.likes.indexOf(userId);
    
    if (likeIndex === -1) {
      review.likes.push(userId);
    } else {
      review.likes.splice(likeIndex, 1);
    }
    
    await review.save();
    res.json(review);
  } catch (error) {
    console.error('Ошибка лайка рецензии:', error);
    res.status(500).json({ error: 'Не удалось поставить лайк' });
  }
});

module.exports = router;
