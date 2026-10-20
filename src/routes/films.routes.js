const express = require('express');
const mongoose = require('mongoose');
const { body } = require('express-validator');
const Film    = require('../models/Film');
const Rating  = require('../models/Rating');
const { authenticate }   = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, extractBearer, verifyToken } = require('../middleware/security');
const { roundTenth } = require('../config/scoring');
const { addPoints }  = require('../utils/points');
const { createEvent, updateAchievements } = require('../utils/helpers');
const { withPosterUrl } = require('../utils/poster');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// ─────────────────────────────────────────────
// ВАЖНО: /top и /search-by-title ДОЛЖНЫ быть ДО /:id
// ─────────────────────────────────────────────

// GET /api/films/top
router.get('/top', asyncHandler(async (req, res, next) => {
  try {
    const sort  = req.query.sort || 'technical';
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    const sortField =
      sort === 'combined' ? 'averageCombined' :
      sort === 'vibe'     ? 'averageVibe'     :
                            'averageRating';

    const films = await Film.aggregate([
      {
        $lookup: {
          from: 'ratings',
          localField: '_id',
          foreignField: 'filmId',
          as: 'ratings'
        }
      },
      {
        $addFields: {
          averageRating:   { $avg: '$ratings.technicalScore' },
          averageVibe:     { $avg: '$ratings.vibe' },
          averageCombined: { $avg: '$ratings.combinedScore' },
          votesCount:      { $size: '$ratings' },
          _sortKey: {
            $ifNull: [{
              $avg: `$ratings.${
                sortField === 'averageCombined' ? 'combinedScore' :
                sortField === 'averageVibe'     ? 'vibe' :
                                                  'technicalScore'
              }`
            }, -1]
          }
        }
      },
      { $match: { _sortKey: { $gt: 0 } } },
      { $project: { ratings: 0, _sortKey: 0 } },
      { $sort: { [sortField]: -1, votesCount: -1, _id: 1 } },
      { $limit: limit }
    ]);

    res.json({ films: films.map(withPosterUrl), sort: sortField, limit });
  } catch (error) {
    throw error;
  }
}));

// GET /api/films/search-by-title
// ⚠️ ДОЛЖЕН быть до /:id — иначе :id перехватит "search-by-title"
router.get('/search-by-title', asyncHandler(async (req, res, next) => {
  try {
    const title = req.query.title;
    if (!title) throw new ValidationError('Название фильма не указано');

    let film = await Film.findOne({ title });
    if (!film) film = await Film.findOne({ title: { $regex: new RegExp(title, 'i') } });
    if (!film) throw new NotFoundError('Фильм не найден');

    res.json(withPosterUrl(film));
  } catch (error) {
    throw error;
  }
}));

// GET /api/films/:id
router.get('/:id', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const film = await Film.findById(req.params.id);
    if (!film) throw new NotFoundError('Фильм не найден');

    const ratingData = await Rating.aggregate([
      { $match: { filmId: film._id } },
      {
        $group: {
          _id: null,
          avgTechnical: { $avg: '$technicalScore' },
          avgVibe:      { $avg: '$vibe' },
          avgCombined:  { $avg: '$combinedScore' },
          total:        { $sum: 1 }
        }
      }
    ]);

    const avgTechnical = ratingData[0]?.avgTechnical || 0;
    const avgVibe      = ratingData[0]?.avgVibe      || 0;
    const avgCombined  = ratingData[0]?.avgCombined  || 0;
    const votesCount   = ratingData[0]?.total        || 0;

    let userRating = null;
    const token = extractBearer(req);
    if (token) {
      try {
        const decoded = verifyToken(token);
        userRating = await Rating.findOne({ filmId: film._id, userId: decoded.userId });
      } catch { /* игнор */ }
    }

    res.json({
      ...withPosterUrl(film),
      averageRating:   roundTenth(avgTechnical),
      averageVibe:     roundTenth(avgVibe),
      averageCombined: roundTenth(avgCombined),
      votesCount,
      userRating
    });
  } catch (error) {
    throw error;
  }
}));

// GET /api/films/:id/ratings
// 🐛 ФИКС: добавлена валидация :id
router.get('/:id/ratings', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const ratings = await Rating.find({ filmId: req.params.id })
      .populate('userId', 'nickname avatar isAdmin')
      .select('technicalScore combinedScore vibe textReview likes createdAt genrePreset blockWeights scores')
      .sort({ createdAt: -1 });

    const formattedRatings = ratings.map(r => ({
      rating: {
        _id:            r._id,
        technicalScore: r.technicalScore,
        combinedScore:  r.combinedScore,
        finalScore:     r.combinedScore,
        vibe:           r.vibe,
        textReview:     r.textReview,
        likes:          r.likes,
        createdAt:      r.createdAt,
        genrePreset:    r.genrePreset,
        blockWeights:   r.blockWeights,
        scores:         r.scores
      },
      user: {
        _id:      r.userId?._id,
        nickname: r.userId?.nickname || 'Пользователь',
        avatar:   r.userId?.avatar,
        isAdmin:  r.userId?.isAdmin || false
      }
    }));

    res.json(formattedRatings);
  } catch (err) {
    throw err;
  }
}));

// GET /api/films/:id/users
// 🐛 ФИКС: добавлена валидация :id
router.get('/:id/users', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const ratings = await Rating.find({ filmId: req.params.id })
      .populate('userId', 'nickname isAdmin')
      .select('combinedScore technicalScore')
      .lean();

    const result = ratings.map(r => ({
      user: {
        _id:      r.userId?._id,
        nickname: r.userId?.nickname || 'Пользователь',
        isAdmin:  r.userId?.isAdmin || false
      },
      rating: {
        _id:            r._id,
        finalScore:     r.combinedScore ?? r.technicalScore ?? 0,
        technicalScore: r.technicalScore,
        combinedScore:  r.combinedScore
      }
    }));

    res.json(result);
  } catch (err) {
    throw err;
  }
}));

// GET /api/films
router.get('/', asyncHandler(async (req, res, next) => {
  try {
    const sort  = req.query.sort || 'technical';
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    let sortField;
    switch (sort) {
      case 'combined': sortField = 'averageCombined'; break;
      case 'vibe':     sortField = 'averageVibe';     break;
      case 'technical':
      default:         sortField = 'averageRating';   break;
    }

    const films = await Film.aggregate([
      {
        $lookup: {
          from: 'ratings',
          localField: '_id',
          foreignField: 'filmId',
          as: 'ratings'
        }
      },
      {
        $addFields: {
          averageRating:   { $avg: '$ratings.technicalScore' },
          averageVibe:     { $avg: '$ratings.vibe' },
          averageCombined: { $avg: '$ratings.combinedScore' },
          votesCount:      { $size: '$ratings' }
        }
      },
      { $project: { ratings: 0 } },
      { $sort: { [sortField]: -1, _id: 1 } },
      { $skip: skip },
      { $limit: limit }
    ]);

    const total = await Film.countDocuments();

    res.json({
      films: films.map(withPosterUrl),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      sort: sortField
    });
  } catch (error) {
    throw error;
  }
}));

// POST /api/films/import
router.post('/import', writeLimiter, authenticate, [
  body('tmdbId').isInt({ min: 1 }).withMessage('Некорректный ID фильма')
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const { tmdbId } = req.body;
    const apiKey = process.env.TMDB_API_KEY;

    const [ruResponse, enResponse] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=ru-RU&append_to_response=credits,videos`),
      fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=en-US`)
    ]);

    if (!ruResponse.ok) throw new Error(`TMDB API error (ru): ${ruResponse.status}`);

    const filmData = await ruResponse.json();
    const enData   = enResponse.ok ? await enResponse.json() : {};

    if (!filmData.title) throw new NotFoundError('Фильм не найден в TMDB');

    const posterPath = filmData.poster_path || enData.poster_path || null;

    const filmDataForSave = {
      tmdbId:      filmData.id,
      title:       filmData.title,
      year:        filmData.release_date ? new Date(filmData.release_date).getFullYear() : null,
      posterPath:  posterPath || '',
      poster:      '',
      description: (filmData.overview || enData.overview || '').slice(0, 1000),
      genres:      filmData.genres?.map(g => g.name) || [],
      director:    filmData.credits?.crew?.find(c => c.job === 'Director')?.name || 'Неизвестен',
      actors:      filmData.credits?.cast?.slice(0, 5).map(a => a.name) || [],
      trailer:     filmData.videos?.results?.find(v => v.type === 'Trailer')?.key
        ? `https://www.youtube.com/embed/${filmData.videos.results.find(v => v.type === 'Trailer').key}`
        : '',
      createdBy:   req.userId
    };

    let film = await Film.findOne({ tmdbId: filmData.id });

    if (!film) {
      film = new Film(filmDataForSave);
      await film.save();
    } else {
      await Film.findOneAndUpdate({ tmdbId: filmData.id }, filmDataForSave);
      const updatedFilm = await Film.findOne({ tmdbId: filmData.id });
      return res.status(200).json({
        film: withPosterUrl(updatedFilm),
        alreadyExists: true,
        message: 'Фильм уже есть в каталоге, данные обновлены'
      });
    }

    const points = req.isAdmin ? 5 : 2;
    await addPoints(req.userId, req.userId, 'import', points, film._id);
    await createEvent('film_add', req.user.nickname, film.title, film._id);
    await updateAchievements(req.userId);

    res.status(201).json({
      film: withPosterUrl(film),
      alreadyExists: false,
      message: 'Фильм успешно добавлен'
    });
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
