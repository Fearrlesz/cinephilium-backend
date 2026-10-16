const express  = require('express');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Rating  = require('../models/Rating');
const Film    = require('../models/Film');
const User    = require('../models/User');
const { authenticate }     = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter } = require('../middleware/security');
const {
  BLOCK_CRITERIA,
  GENRE_PRESETS,
  DEFAULT_WEIGHTS_ARRAY,
  TECHNICAL_WEIGHT,
  VIBE_WEIGHT,
  roundTenth,
  calculateTechnicalScore,
  weightsArrayToObject,
  weightsObjectToArray
} = require('../config/scoring');
const { addPoints } = require('../utils/points');
const { createEvent, updateAchievements } = require('../utils/helpers');

const router = express.Router();

// POST /api/ratings
router.post('/', writeLimiter, authenticate, async (req, res) => {
  try {
    const { filmId, scores, vibe, genrePreset, blockWeights, textReview } = req.body;

    if (!filmId || !mongoose.Types.ObjectId.isValid(filmId)) {
      return res.status(400).json({ message: 'Некорректный filmId' });
    }

    if (!scores || typeof scores !== 'object') {
      return res.status(400).json({ message: 'scores обязателен и должен быть объектом' });
    }

    for (const [block, crits] of Object.entries(BLOCK_CRITERIA)) {
      if (!scores[block] || typeof scores[block] !== 'object') {
        return res.status(400).json({ message: `Блок ${block} отсутствует или некорректен` });
      }
      for (const crit of crits) {
        const val = scores[block][crit];
        if (!Number.isFinite(val) || val < 1 || val > 10) {
          return res.status(400).json({
            message: `Некорректное значение ${block}.${crit} (нужно 1–10)`
          });
        }
      }
    }

    if (!Number.isFinite(vibe) || vibe < 1 || vibe > 10) {
      return res.status(400).json({ message: 'vibe должен быть от 1 до 10' });
    }

    let weightsArray;

    if (genrePreset && GENRE_PRESETS[genrePreset] && genrePreset !== 'hybrid') {
      weightsArray = GENRE_PRESETS[genrePreset];
    } else if (Array.isArray(blockWeights) && blockWeights.length === 5) {
      const allValid = blockWeights.every(w => Number.isFinite(w) && w >= 0 && w <= 100);
      const sum = blockWeights.reduce((a, b) => a + b, 0);
      if (!allValid || sum !== 100) {
        return res.status(400).json({ message: 'Сумма весов блоков должна быть строго 100' });
      }
      weightsArray = blockWeights;
    } else if (blockWeights && typeof blockWeights === 'object') {
      const arr = weightsObjectToArray(blockWeights);
      const allValid = arr.every(w => Number.isFinite(w) && w >= 0 && w <= 100);
      const sum = arr.reduce((a, b) => a + b, 0);
      if (!allValid || sum !== 100) {
        return res.status(400).json({ message: 'Сумма весов блоков должна быть строго 100' });
      }
      weightsArray = arr;
    } else {
      weightsArray = DEFAULT_WEIGHTS_ARRAY;
    }

    const weights = weightsArrayToObject(weightsArray);

    let technicalScore;
    try {
      technicalScore = calculateTechnicalScore(scores, weights);
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }

    const combinedScore = roundTenth(technicalScore * TECHNICAL_WEIGHT + vibe * VIBE_WEIGHT);

    const film = await Film.findById(filmId);
    if (!film) return res.status(404).json({ error: 'Фильм не найден' });

    const existingRating = await Rating.findOne({ userId: req.userId, filmId });
    const isNew = !existingRating;

    const rating = await Rating.findOneAndUpdate(
      { userId: req.userId, filmId },
      {
        $set: {
          genrePreset: genrePreset || null,
          blockWeights: weights,
          scores,
          vibe,
          technicalScore,
          combinedScore,
          textReview: textReview || ''
        }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    if (isNew) {
      const points = req.isAdmin ? 20 : 10;
      await addPoints(req.userId, req.userId, 'rating', points, rating._id);

      const user = await User.findById(req.userId);
      const nickname = user?.nickname || 'Пользователь';

      await createEvent(
        'rating',
        nickname,
        film.title,
        film._id,
        rating.combinedScore,
        rating._id,
        {
          technicalScore: rating.technicalScore,
          combinedScore:  rating.combinedScore,
          vibe:           rating.vibe
        }
      );

      await updateAchievements(req.userId);
    }

    res.status(201).json({
      rating,
      technicalScore,
      combinedScore,
      vibe,
      finalScore: combinedScore
    });
  } catch (err) {
    console.error('Ошибка сохранения оценки:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

// GET /api/ratings/user
router.get('/user', authenticate, async (req, res) => {
  try {
    const ratings = await Rating.find({ userId: req.userId })
      .populate('filmId')
      .sort({ createdAt: -1 });

    res.json(ratings);
  } catch (error) {
    console.error('Ошибка получения оценок:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// GET /api/ratings/:id/details
router.get('/:id/details', validateObjectId('id'), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const rating = await Rating.findById(req.params.id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster');

    if (!rating) return res.status(404).json({ error: 'Оценка не найдена' });

    res.json(rating);
  } catch (error) {
    console.error('Ошибка загрузки деталей:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
