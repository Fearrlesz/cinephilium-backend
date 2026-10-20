const express  = require('express');
const mongoose = require('mongoose');
const Rating  = require('../models/Rating');
const Film    = require('../models/Film');
const User    = require('../models/User');
const { authenticate }     = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
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
const { withPosterUrl } = require('../utils/poster');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// POST /api/ratings
router.post('/', authenticate, asyncHandler(async (req, res, next) => {
  try {
    const { filmId, scores, vibe, genrePreset, blockWeights, textReview } = req.body;

    if (!filmId || !mongoose.Types.ObjectId.isValid(filmId)) {
      throw new ValidationError('Некорректный filmId');
    }

    if (!scores || typeof scores !== 'object') {
      throw new ValidationError('scores обязателен и должен быть объектом');
    }

    for (const [block, crits] of Object.entries(BLOCK_CRITERIA)) {
      if (!scores[block] || typeof scores[block] !== 'object') {
        throw new ValidationError(`Блок ${block} отсутствует или некорректен`);
      }
      for (const crit of crits) {
        const val = scores[block][crit];
        if (!Number.isFinite(val) || val < 1 || val > 10) {
          throw new ValidationError(`Некорректное значение ${block}.${crit} (нужно 1–10)`);
        }
      }
    }

    if (!Number.isFinite(vibe) || vibe < 1 || vibe > 10) {
      throw new ValidationError('vibe должен быть от 1 до 10');
    }

    let weightsArray;

    if (genrePreset && GENRE_PRESETS[genrePreset] && genrePreset !== 'hybrid') {
      weightsArray = GENRE_PRESETS[genrePreset];
    } else if (Array.isArray(blockWeights) && blockWeights.length === 5) {
      const allValid = blockWeights.every(w => Number.isFinite(w) && w >= 0 && w <= 100);
      const sum = blockWeights.reduce((a, b) => a + b, 0);
      if (!allValid || sum !== 100) {
        throw new ValidationError('Сумма весов блоков должна быть строго 100');
      }
      weightsArray = blockWeights;
    } else if (blockWeights && typeof blockWeights === 'object') {
      const arr = weightsObjectToArray(blockWeights);
      const allValid = arr.every(w => Number.isFinite(w) && w >= 0 && w <= 100);
      const sum = arr.reduce((a, b) => a + b, 0);
      if (!allValid || sum !== 100) {
        throw new ValidationError('Сумма весов блоков должна быть строго 100');
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
      throw new ValidationError(e.message);
    }

    const combinedScore = roundTenth(technicalScore * TECHNICAL_WEIGHT + vibe * VIBE_WEIGHT);

    const film = await Film.findById(filmId);
    if (!film) throw new NotFoundError('Фильм не найден');

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
    throw err;
  }
}));

// GET /api/ratings/user
router.get('/user', authenticate, asyncHandler(async (req, res, next) => {
  try {
    const ratings = await Rating.find({ userId: req.userId })
      .populate('filmId')
      .sort({ createdAt: -1 });

    res.json(ratings.map(rating => ({
      ...rating.toObject(),
      filmId: withPosterUrl(rating.filmId)
    })));
  } catch (error) {
    throw error;
  }
}));

// GET /api/ratings/:id/details
router.get('/:id/details', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const rating = await Rating.findById(req.params.id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster posterPath');

    if (!rating) throw new NotFoundError('Оценка не найдена');

    res.json({
      ...rating.toObject(),
      filmId: withPosterUrl(rating.filmId)
    });
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
