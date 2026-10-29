const express  = require('express');
const mongoose = require('mongoose');
const Rating  = require('../models/Rating');
const Film    = require('../models/Film');
const User    = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, ratingLimiter } = require('../middleware/security');
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
const { incCounter } = require('../utils/counters');
const { withPosterUrl } = require('../utils/poster');
const { createEvent, updateAchievements } = require('../utils/helpers');
const { findOwnWatch, setWatchLink } = require('../utils/watchLink');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ValidationError, AppError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// vibe-оценок можно создать не больше 50 за скользящие 24 часа.
const VIBE_DAILY_LIMIT = 50;
const VIBE_WINDOW_MS = 24 * 60 * 60 * 1000;
const FULL_PAYLOAD_FIELDS = ['scores', 'genrePreset', 'blockWeights', 'textReview'];

function hasFullPayload(body = {}) {
  return FULL_PAYLOAD_FIELDS.some(field => body[field] !== undefined);
}

/**
 * Атомарно занимает слот vibe-оценки в скользящем окне пользователя.
 * Одна pipeline-операция: отфильтровать старые отметки, проверить размер,
 * добавить новую. Mongo сериализует обновления одного документа, поэтому
 * два параллельных запроса не смогут оба пройти при 49/50.
 */
async function consumeVibeSlot(userId) {
  const now = new Date();
  const since = new Date(now.getTime() - VIBE_WINDOW_MS);

  const raw = await User.collection.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(String(userId)) },
    [
      {
        $set: {
          vibeWindow: {
            $filter: {
              input: { $ifNull: ['$vibeWindow', []] },
              as: 'at',
              cond: { $gte: ['$$at', since] }
            }
          }
        }
      },
      {
        $set: {
          vibeAccepted: { $lt: [{ $size: '$vibeWindow' }, VIBE_DAILY_LIMIT] }
        }
      },
      {
        $set: {
          vibeWindow: {
            $cond: [
              '$vibeAccepted',
              { $concatArrays: ['$vibeWindow', [now]] },
              '$vibeWindow'
            ]
          }
        }
      }
    ],
    {
      returnDocument: 'after',
      projection: { vibeWindow: 1, vibeAccepted: 1 }
    }
  );

  const quota = raw?.value ?? raw;
  if (!quota || quota.vibeAccepted !== true) {
    const oldest = quota?.vibeWindow?.[0];
    const retryAt = oldest
      ? new Date(new Date(oldest).getTime() + VIBE_WINDOW_MS)
      : new Date(now.getTime() + VIBE_WINDOW_MS);
    return { accepted: false, retryAt };
  }
  return { accepted: true };
}

// POST /api/ratings
router.post('/', writeLimiter, ratingLimiter, authenticate, asyncHandler(async (req, res, next) => {
  try {
    const body = req.body || {};
    const { filmId, vibe } = body;

    if (!filmId || !mongoose.Types.ObjectId.isValid(filmId)) {
      throw new ValidationError('Некорректный filmId');
    }

    const film = await Film.findById(filmId);
    if (!film) throw new NotFoundError('Фильм не найден');

    const existing = await Rating.findOne({ userId: req.userId, filmId });
    const trustWeight = typeof req.user?.trustWeight === 'number' ? req.user.trustWeight : 1;

    // DECISION: B5/2 — связь с дневником ставится только по явному watchId.
    // Автопривязки нет: при нескольких просмотрах непонятно, к какому приклеивать.
    let watchToLink = null;
    if (body.watchId !== undefined && body.watchId !== null && body.watchId !== '') {
      if (!mongoose.Types.ObjectId.isValid(String(body.watchId))) {
        throw new ValidationError('Некорректный watchId');
      }
      watchToLink = await findOwnWatch(body.watchId, req.userId, filmId);
      if (!watchToLink) {
        throw new ValidationError('Запись дневника не найдена или относится к другому фильму');
      }
    }

    const linkWatch = async ratingId => {
      if (!watchToLink) return;
      await setWatchLink({
        watchId: watchToLink._id,
        userId: req.userId,
        filmId,
        field: 'ratingId',
        targetId: ratingId
      });
    };

    // ── Лайт: только vibe. Любое полное поле переводит запрос в полную ветку.
    if (!hasFullPayload(body)) {
      if (!Number.isFinite(vibe) || vibe < 1 || vibe > 10) {
        throw new ValidationError('vibe должен быть от 1 до 10');
      }

      if (existing && (existing.completeness || 'full') === 'full') {
        // DECISION: 1A — full-оценка не упрощается: ни через API, ни в обход.
        throw new AppError(
          'ALREADY_FULL_RATING',
          'Полная оценка уже стоит — упростить её нельзя',
          400
        );
      }

      // Повторный vibe — просто правка вайба, без новых баллов и счётчика.
      if (existing) {
        const updated = await Rating.findOneAndUpdate(
          { _id: existing._id },
          { $set: { vibe, ip: req.ip || '' } },
          { new: true, runValidators: true }
        );
        await linkWatch(updated._id);
        return res.status(201).json({
          rating: {
            ...updated.toObject(),
            scores: null,
            blockWeights: null,
            genrePreset: null
          },
          technicalScore: 0,
          combinedScore: 0,
          vibe,
          finalScore: 0,
          completeness: 'vibe'
        });
      }

      const slot = await consumeVibeSlot(req.userId);
      if (!slot.accepted) {
        throw new AppError(
          'VIBE_LIMIT_REACHED',
          'Слишком много vibe-оценок за сутки',
          429,
          {
            limit: VIBE_DAILY_LIMIT,
            window: '24h',
            retryAt: slot.retryAt.toISOString()
          }
        );
      }

      const rating = await Rating.findOneAndUpdate(
        { userId: req.userId, filmId },
        {
          $set: {
            completeness: 'vibe',
            vibe,
            technicalScore: 0,
            combinedScore: 0,
            textReview: '',
            weight: trustWeight,
            ip: req.ip || '',
            vibeCreatedAt: new Date()
          },
          $unset: { scores: 1, blockWeights: 1, genrePreset: 1 }
        },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      );

      await incCounter(req.userId, 'vibes', 1);
      await addPoints(req.userId, req.userId, 'rating', 2, rating._id);

      await createEvent(
        'vibe',
        req.user?.nickname || 'Пользователь',
        film.title,
        film._id,
        null,
        rating._id,
        { vibe, completeness: 'vibe' }
      );
      // updateAchievements на vibe не вызывается — только на полной оценке.

      await linkWatch(rating._id);

      return res.status(201).json({
        rating: {
          ...rating.toObject(),
          scores: null,
          blockWeights: null,
          genrePreset: null
        },
        technicalScore: 0,
        combinedScore: 0,
        vibe,
        finalScore: 0,
        completeness: 'vibe'
      });
    }

    // ── Полная оценка: 15 критериев + vibe.
    const { scores, genrePreset, blockWeights, textReview } = body;

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

    // DECISION: 3A — на апгрейде vibe можно изменить; если поле не пришло,
    // остаётся вайб из лайт-оценки.
    let effectiveVibe = vibe;
    if (effectiveVibe === undefined && existing && Number.isFinite(existing.vibe)) {
      effectiveVibe = existing.vibe;
    }
    if (!Number.isFinite(effectiveVibe) || effectiveVibe < 1 || effectiveVibe > 10) {
      throw new ValidationError('vibe должен быть от 1 до 10');
    }

    if (textReview !== undefined && textReview !== null) {
      if (typeof textReview !== 'string') {
        throw new ValidationError('textReview должен быть строкой');
      }
      if (textReview.length > 2000) {
        throw new ValidationError('textReview не длиннее 2000 символов');
      }
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

    const combinedScore = roundTenth(technicalScore * TECHNICAL_WEIGHT + effectiveVibe * VIBE_WEIGHT);
    const previousCompleteness = existing ? (existing.completeness || 'full') : null;
    const weight = existing && typeof existing.weight === 'number'
      ? existing.weight
      : trustWeight;

    const rating = await Rating.findOneAndUpdate(
      { userId: req.userId, filmId },
      {
        $set: {
          completeness: 'full',
          genrePreset: genrePreset || null,
          blockWeights: weights,
          scores,
          vibe: effectiveVibe,
          technicalScore,
          combinedScore,
          textReview: textReview || '',
          // Анти-накрутка: вес существующей записи не пересчитываем,
          // иначе помеченная оценка могла бы «ожиреть» при апдейте.
          weight,
          ip: req.ip || ''
        }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    if (!existing) {
      await incCounter(req.userId, 'ratings', 1);
      const points = req.isAdmin ? 20 : 10;
      await addPoints(req.userId, req.userId, 'rating', points, rating._id);

      await createEvent(
        'rating',
        req.user?.nickname || 'Пользователь',
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
    } else if (previousCompleteness === 'vibe') {
      // Апгрейд: доплачиваем до 10 (2 уже было за vibe) и пересчитываем достижения.
      // +8 — ровно по спецификации P1; админский множитель остаётся только
      // у новой полной оценки (старый фронт), апгрейд его не получает.
      await incCounter(req.userId, 'ratings', 1);
      // Достижения считаем до снятия vibe со счётчика, иначе «Первое впечатление»
      // никогда не выдастся тем, кто сразу апгрейдится.
      await updateAchievements(req.userId);
      await incCounter(req.userId, 'vibes', -1);
      await addPoints(req.userId, req.userId, 'rating', 8, rating._id);

      await createEvent(
        'rating',
        req.user?.nickname || 'Пользователь',
        film.title,
        film._id,
        rating.combinedScore,
        rating._id,
        {
          technicalScore: rating.technicalScore,
          combinedScore:  rating.combinedScore,
          vibe:           rating.vibe,
          upgradedFrom:   'vibe'
        }
      );
    }

    await linkWatch(rating._id);

    res.status(201).json({
      rating,
      technicalScore,
      combinedScore,
      vibe: effectiveVibe,
      finalScore: combinedScore,
      completeness: 'full'
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
      completeness: rating.completeness || 'full',
      filmId: withPosterUrl(rating.filmId, req)
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
      completeness: rating.completeness || 'full',
      filmId: withPosterUrl(rating.filmId, req)
    });
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
