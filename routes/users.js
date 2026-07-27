const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Rating = require('../models/Rating');
const Review = require('../models/Review');
const auth = require('../middleware/auth');

// GET /api/users/:id - получить профиль пользователя с его оценками и рецензиями
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const ratings = await Rating.find({ userId: req.params.id })
      .populate('filmId', 'title year poster')
      .sort({ createdAt: -1 });

    const reviews = await Review.find({ 
      userId: req.params.id,
      status: 'approved' 
    })
      .populate('filmId', 'title year poster')
      .populate('ratingId', 'finalScore')
      .sort({ createdAt: -1 });

    res.json({
      user,
      ratings,
      reviews
    });
  } catch (error) {
    console.error('Ошибка получения профиля:', error);
    res.status(500).json({ error: 'Не удалось загрузить профиль' });
  }
});

// GET /api/users/me/achievements - получить достижения текущего пользователя
router.get('/me/achievements', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    res.json({
      achievements: user.achievements || [],
      totalPoints: user.totalPoints || 0
    });
  } catch (error) {
    console.error('Ошибка получения достижений:', error);
    res.status(500).json({ error: 'Не удалось загрузить достижения' });
  }
});

module.exports = router;
