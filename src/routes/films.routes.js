const express = require('express');
const mongoose = require('mongoose');
const { body } = require('express-validator');
const Film    = require('../models/Film');
const Rating  = require('../models/Rating');
const Watch   = require('../models/Watch');
const { authenticate }   = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, extractBearer } = require('../middleware/security');
const { verifyAccessToken } = require('../utils/jwt');
const {
  SORT_AXES,
  sortFieldFor,
  FILM_STATS_STAGES,
  participantMatch,
  shapeFilmAggregates,
  shapeFilmDetail
} = require('../utils/filmAggregates');
const { addPoints }  = require('../utils/points');
const { createEvent, updateAchievements } = require('../utils/helpers');
const { withPosterUrl } = require('../utils/poster');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ValidationError, AppError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// Экранирование пользовательского ввода перед сборкой RegExp:
// без этого "[" / "(" / "+" роняют запрос в 500, а "(a+)+$" даёт ReDoS.
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────
// ВАЖНО: /top и /search-by-title ДОЛЖНЫ быть ДО /:id
// ─────────────────────────────────────────────

// GET /api/films/top
// DECISION: B2/6A — в топе участвуют только фильмы, у которых есть число по
// выбранной оси. Фильм без единой полной оценки не занимает место с нулём на
// дне: у него нет значения, по которому его ранжировать. total считает ровно
// участников, а не все фильмы базы.
router.get('/top', asyncHandler(async (req, res, next) => {
  const sort  = req.query.sort || 'technical';
  const limit = Math.min(parseInt(req.query.limit) || 5, 20);
  const sortField = sortFieldFor(sort);

  const [result = {}] = await Film.aggregate([
    ...FILM_STATS_STAGES,
    {
      $facet: {
        films: [
          participantMatch(sortField),
          { $sort: { [sortField]: -1, votesCount: -1, _id: 1 } },
          { $limit: limit }
        ],
        axisTotal: [participantMatch(sortField), { $count: 'total' }],
        // Нужен только для подсказки fallback, но считается всегда: одна
        // лишняя ветка дешевле второго round-trip.
        vibeTotal: [participantMatch(SORT_AXES.vibe), { $count: 'total' }]
      }
    }
  ]);

  const films     = result.films || [];
  const total     = result.axisTotal?.[0]?.total || 0;
  const vibeTotal = result.vibeTotal?.[0]?.total || 0;

  // DECISION: B2/3C — пустой топ отдаётся пустым. Молчаливой подмены на
  // vibe-топ нет: иначе пользователь читал бы числа вайба как топ по
  // техническому. Вместо подмены — честный признак, что vibe-топ есть и его
  // можно предложить по явному клику.
  const fallback = {
    sort: 'vibe',
    available: total === 0 && sortField !== SORT_AXES.vibe && vibeTotal > 0
  };

  res.json({
    films: films.map(film => withPosterUrl(shapeFilmAggregates(film), req)),
    sort: sortField,
    limit,
    total,
    fallback
  });
}));

// GET /api/films/search-by-title
// ⚠️ ДОЛЖЕН быть до /:id — иначе :id перехватит "search-by-title"
router.get('/search-by-title', asyncHandler(async (req, res, next) => {
  try {
    const title = req.query.title;
    if (!title) throw new ValidationError('Название фильма не указано');

    let film = await Film.findOne({ title });
    if (!film) film = await Film.findOne({ title: { $regex: new RegExp(escapeRegex(title), 'i') } });
    if (!film) throw new NotFoundError('Фильм не найден');

    res.json(withPosterUrl(film, req));
  } catch (error) {
    throw error;
  }
}));

// GET /api/films/:id
// DECISION: B2/6.1 — на странице фильма отсутствующее среднее отдаётся нулём
// (язык B1: 0 = «не вычислено», DECISION 2A), а не null и не отсутствием поля:
// фронт показывает на нём «Нет оценок». В списках и топах то же отсутствие
// отдаётся null, потому что там старый фронт рисует null как «—», а 0 нарисовал
// бы красное «0.0». Разница намеренная.
router.get('/:id', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const [film] = await Film.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(String(req.params.id)) } },
    ...FILM_STATS_STAGES
  ]);
  if (!film) throw new NotFoundError('Фильм не найден');

  let userRating = null;
  const token = extractBearer(req);
  if (token) {
    try {
      const decoded = verifyAccessToken(token);
      userRating = await Rating.findOne({ filmId: film._id, userId: decoded.userId });
    } catch { /* игнор */ }
  }

  // DECISION: B5/6 — «N просмотров» публично и считает ВСЕ записи дневника,
  // включая записи пользователей с weight: 0: дневник не гейтится и не взвешивается,
  // анти-накрутка живёт в агрегатах оценок, а сортировки по просмотрам нет.
  // Считаем отдельным запросом по индексу filmId, чтобы не трогать агрегаты B2.
  const watchesCount = await Watch.countDocuments({ filmId: film._id });

  res.json({
    ...withPosterUrl(shapeFilmDetail(film), req),
    watchesCount,
    userRating: userRating
      ? { ...userRating.toObject(), completeness: userRating.completeness || 'full' }
      : null
  });
}));

// GET /api/films/:id/ratings
// 🐛 ФИКС: добавлена валидация :id
router.get('/:id/ratings', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const ratings = await Rating.find({ filmId: req.params.id, weight: { $ne: 0 } })
      .populate('userId', 'nickname avatar isAdmin')
      .select('technicalScore combinedScore vibe textReview likes createdAt genrePreset blockWeights scores completeness')
      .sort({ createdAt: -1 });

    const formattedRatings = ratings.map(r => ({
      rating: {
        _id:            r._id,
        technicalScore: r.technicalScore,
        combinedScore:  r.combinedScore,
        finalScore:     r.combinedScore,
        vibe:           r.vibe,
        completeness:   r.completeness || 'full',
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
    const ratings = await Rating.find({ filmId: req.params.id, weight: { $ne: 0 } })
      .populate('userId', 'nickname isAdmin')
      .select('combinedScore technicalScore completeness')
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
        combinedScore:  r.combinedScore,
        completeness:   r.completeness || 'full'
      }
    }));

    res.json(result);
  } catch (err) {
    throw err;
  }
}));

// GET /api/films
// DECISION: B2/6A — каталог показывает ВСЕ фильмы, включая неоценённые: иначе
// только что импортированный фильм исчезает из выдачи. Неоценённые идут в конце
// с averageTechnical = null и votesCount = 0, а total считает все фильмы — это
// и есть фильтр каталога, поэтому total честен относительно него.
// DECISION: B2/2B — sort=new даёт точку входа для свежих импортов. Это
// nice-to-have, а не затычка: 6A делает такие фильмы видимыми и без него,
// поэтому убрать sort=new можно без дыры в контракте.
router.get('/', asyncHandler(async (req, res, next) => {
  const sort  = req.query.sort || 'technical';
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip  = (page - 1) * limit;

  const isNew     = sort === 'new';
  const sortField = sortFieldFor(sort);

  const pipeline = [...FILM_STATS_STAGES];
  pipeline.push(
    isNew
      ? { $sort: { createdAt: -1, _id: -1 } }
      : { $sort: { [sortField]: -1, _id: 1 } }
  );
  pipeline.push({ $skip: skip }, { $limit: limit });

  const [films, total] = await Promise.all([
    Film.aggregate(pipeline),
    Film.countDocuments()
  ]);

  res.json({
    films: films.map(film => withPosterUrl(shapeFilmAggregates(film), req)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    sort: isNew ? 'createdAt' : sortField
  });
}));

// POST /api/films/import
router.post('/import', writeLimiter, authenticate, [
  body('tmdbId').isInt({ min: 1 }).withMessage('Некорректный ID фильма')
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const { tmdbId } = req.body;
    const apiKey = process.env.TMDB_API_KEY;

    const [ruResponse, enResponse] = await (async () => {
      try {
        return await Promise.all([
          fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=ru-RU&append_to_response=credits,videos`),
          fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=en-US`)
        ]);
      } catch {
        throw new AppError('TMDB_UNAVAILABLE', 'Сервис TMDB временно недоступен', 502);
      }
    })();

    if (ruResponse.status === 404) throw new NotFoundError('Фильм не найден в TMDB');
    if (!ruResponse.ok) {
      throw new AppError('TMDB_UNAVAILABLE', 'Сервис TMDB временно недоступен', 502);
    }

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
        film: withPosterUrl(updatedFilm, req),
        alreadyExists: true,
        message: 'Фильм уже есть в каталоге, данные обновлены'
      });
    }

    const points = req.isAdmin ? 5 : 2;
    await addPoints(req.userId, req.userId, 'import', points, film._id);
    await createEvent('film_add', {
      userId: req.userId,
      nickname: req.user.nickname,
      film: film.title,
      filmId: film._id
    });
    await updateAchievements(req.userId);

    res.status(201).json({
      film: withPosterUrl(film, req),
      alreadyExists: false,
      message: 'Фильм успешно добавлен'
    });
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
