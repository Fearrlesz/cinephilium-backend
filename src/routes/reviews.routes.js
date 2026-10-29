const express = require('express');
const { body } = require('express-validator');
const Review  = require('../models/Review');
const Film    = require('../models/Film');
const User    = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, extractBearer } = require('../middleware/security');
const { verifyAccessToken } = require('../utils/jwt');
const { addPoints } = require('../utils/points');
const { incCounter } = require('../utils/counters');
const { updateAchievements } = require('../utils/helpers');
const { withPosterUrl } = require('../utils/poster');
const { requireRatingForFilm } = require('../utils/ratingGate');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// POST /api/reviews
// Гейтинг: рецензию пишет только тот, кто прошёл 15 критериев. Vibe даёт право
// комментировать (B3), full — право писать рецензию: это иерархия вклада, а не
// произвол. Гейт стоит до валидации тела и до модерации, как в B3.
//
// DECISION: B4/1A — ratingId из тела игнорируется всегда: сервер берёт _id своей
// оценки. У пары user+film оценка одна (unique), поэтому у корректного клиента
// значение совпало бы, а старый фронт, который его присылает, продолжает работать.
// DECISION: B4/2 — минимум текста остаётся 350 символов: понижение до 10 отклонено
// заказчиком. Максимум 15000 — как было.
// DECISION: B4/3 — планка длины едина для создания и будущего редактирования: она
// живёт в схеме Review, поэтому правка унаследует её без отдельного кода.
// DECISION: B4/4 — фильтра ?spoiler на бэке нет: isSpoiler отдаётся у каждого
// элемента, фильтрует фронт. Параметр можно добавить позже аддитивно.
// DECISION: B4/5 — в админ-очереди isSpoiler ничего не скрывает: модератор обязан
// видеть текст целиком, иначе не сможет оценить. Скрытие — только публичный фронт.
// DECISION: B5/out-of-scope — автоотметка «просмотрено» и добавление фильма в лист
// при наличии оценки в B4 не реализуются: это дневник (B5). В коде такой логики
// сейчас нет, схему Review и этот роут под неё не трогаем.
router.post('/', writeLimiter, [
  body('filmId').isMongoId().withMessage('Некорректный ID фильма'),
  body('title').notEmpty().isLength({ max: 100 }).withMessage('Заголовок не длиннее 100 символов'),
  body('text')
    .notEmpty().withMessage('Текст рецензии обязателен')
    .isLength({ min: 350 }).withMessage('Текст рецензии должен быть не короче 350 символов')
    .isLength({ max: 15000 }).withMessage('Текст рецензии не длиннее 15000 символов'),
  body('isSpoiler').optional().isBoolean().withMessage('isSpoiler должен быть true или false')
], authenticate, requireRatingForFilm({
  completeness: 'full',
  code: 'FULL_RATING_REQUIRED_FOR_REVIEW',
  message: 'Рецензия доступна только после полной оценки фильма (15 критериев)',
  attachAs: 'reviewRating'
}), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const { filmId, title, text, isSpoiler } = req.body;

    const film = await Film.findById(filmId);
    if (!film) throw new NotFoundError('Фильм не найден');

    const existing = await Review.findOne({ userId: req.userId, filmId });
    if (existing) throw new ValidationError('Вы уже написали рецензию на этот фильм');

    const review = new Review({
      userId: req.userId,
      filmId,
      // DECISION B4/1A: id оценки ставит сервер, из тела он не читается.
      ratingId: req.reviewRating._id,
      title,
      text,
      // Приводим явно: фронт может прислать булево, а строка 'true' из формы
      // не должна стать true случайно.
      isSpoiler: isSpoiler === true || isSpoiler === 'true',
      status: 'pending'
    });
    await review.save();
    await incCounter(req.userId, 'reviews', 1);

    const reviewWithUser = await Review.findById(review._id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster posterPath')
      .populate('ratingId');

    res.json({
      ...reviewWithUser.toObject(),
      filmId: withPosterUrl(reviewWithUser.filmId, req)
    });
  } catch (error) {
    throw error;
  }
}));

// GET /api/reviews/user
router.get('/user', authenticate, asyncHandler(async (req, res, next) => {
  try {
    const reviews = await Review.find({ userId: req.userId })
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster posterPath year')
      .populate('ratingId')
      .sort({ createdAt: -1 });

    res.json(reviews.map(review => ({
      ...review.toObject(),
      filmId: withPosterUrl(review.filmId, req)
    })));
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
      .populate('filmId', 'title poster posterPath description director actors genres year')
      .populate('ratingId');

    if (!review) throw new NotFoundError('Рецензия не найдена');

    // Черновик и отклонённая рецензия не должны утекать по прямому id.
    let isAdmin = false;
    let viewerId = null;
    const token = extractBearer(req);
    if (token) {
      try {
        const decoded = verifyAccessToken(token);
        viewerId = decoded.userId;
        const viewer = await User.findById(decoded.userId);
        isAdmin = viewer?.isAdmin || false;
      } catch { /* игнор */ }
    }
    const isAuthor = Boolean(viewerId) && String(review.userId?._id) === String(viewerId);
    if (review.status !== 'approved' && !isAdmin && !isAuthor) {
      throw new NotFoundError('Рецензия не найдена');
    }

    res.json({
      ...review.toObject(),
      filmId: withPosterUrl(review.filmId, req)
    });
  } catch (error) {
    throw error;
  }
}));

// GET /api/reviews/:filmId
router.get('/:filmId', validateObjectId('filmId'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    let isAdmin = false;
    let viewerId = null;
    const token = extractBearer(req);
    if (token) {
      try {
        const decoded = verifyAccessToken(token);
        viewerId = decoded.userId;
        const user = await User.findById(viewerId).select('isAdmin');
        isAdmin = user?.isAdmin || false;
      } catch { /* игнор */ }
    }

    // Свой черновик автор должен видеть в карточке фильма сразу после отправки,
    // иначе он «исчезает» до модерации. Чужие pending по-прежнему скрыты.
    const visibility = isAdmin
      ? {}
      : viewerId
        ? { $or: [{ status: 'approved' }, { status: 'pending', userId: viewerId }] }
        : { status: 'approved' };

    const reviews = await Review.find({
      filmId: req.params.filmId,
      ...visibility
    })
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster posterPath')
      .populate('ratingId')
      .sort({ createdAt: -1 });

    res.json(reviews.map(review => ({
      ...review.toObject(),
      filmId: withPosterUrl(review.filmId, req)
    })));
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

    await incCounter(review.userId, 'likesReceived', 1);
    const points = req.isAdmin ? 20 : 5;
    await addPoints(review.userId, req.userId, 'like', points, review._id);
    await updateAchievements(review.userId);

    res.json({ liked: true, likes: review.likes.length });
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
