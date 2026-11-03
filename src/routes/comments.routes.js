const express = require('express');
const mongoose = require('mongoose');
const { body } = require('express-validator');
const Comment = require('../models/Comment');
const Film    = require('../models/Film');
const Review  = require('../models/Review');
const { authenticate } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, extractBearer } = require('../middleware/security');
const { verifyAccessToken } = require('../utils/jwt');
const User = require('../models/User');
const { addPoints } = require('../utils/points');
const { incCounter } = require('../utils/counters');
const { updateAchievements } = require('../utils/helpers');
const { requireRatingForFilm } = require('../utils/ratingGate');
const { parsePaging, paginationMeta } = require('../utils/paging');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ValidationError, AppError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

const TARGET_TYPES = ['film', 'review'];

// DECISION: B8/legacy-read — у документов до B8 нет targetType/targetId. Считаем
// их комментариями к фильму прямо в фильтрах, чтобы окно «деплой → миграция»
// не заставляло старые комментарии исчезнуть с сайта.
const FILM_TARGET_FILTER = {
  $or: [{ targetType: 'film' }, { targetType: { $exists: false } }]
};

// Фильтр по цели. Для фильма идём по legacy-полю filmId (он равен targetId
// и проиндексирован), плюс отсекаем комментарии к рецензиям того же фильма.
function targetFilter(targetType, targetId) {
  if (targetType === 'film') return { filmId: targetId, ...FILM_TARGET_FILTER };
  return { targetType: 'review', targetId };
}

// $or из фильтра цели и $or из видимости нельзя склеивать одним spread —
// второй затрёт первый. Собираем через $and.
function withVisibility(filter, visibility) {
  return Object.keys(visibility).length > 0 ? { $and: [filter, visibility] } : filter;
}

async function resolveViewer(req) {
  let viewerId = null;
  let isAdmin = false;

  const token = extractBearer(req);
  if (token) {
    try {
      const decoded = verifyAccessToken(token);
      viewerId = decoded.userId;
      const user = await User.findById(viewerId).select('isAdmin');
      isAdmin = user?.isAdmin || false;
    } catch { /* игнор */ }
  }

  return { viewerId, isAdmin };
}

// Свой pending автор видит сразу, чужие — только после одобрения (правило 3.0).
function visibilityFor({ viewerId, isAdmin }) {
  if (isAdmin) return {};
  if (viewerId) return { $or: [{ status: 'approved' }, { status: 'pending', userId: viewerId }] };
  return { status: 'approved' };
}

/**
 * Нормализует цель комментария до `req.commentTarget`.
 *
 * DECISION: B8/compat — старый фронт шлёт `{ filmId, text }` без targetType:
 * считаем это комментарием к фильму, а targetId берём из targetId или filmId.
 * Иначе деплой B8 сломал бы комментарии до деплоя F-серии.
 *
 * DECISION: B8/2A — для targetType 'review' filmId из тела игнорируется,
 * источник истины — review.filmId (сервер ставит его сам).
 */
function resolveTarget(req, _res, next) {
  const body = req.body || {};
  const rawType = body.targetType;
  const targetType = (rawType === undefined || rawType === null || rawType === '')
    ? 'film'
    : rawType;

  if (!TARGET_TYPES.includes(targetType)) {
    throw new ValidationError('targetType должен быть film или review');
  }

  const rawTargetId = targetType === 'film'
    ? (body.targetId ?? body.filmId)
    : body.targetId;

  if (!rawTargetId || !mongoose.Types.ObjectId.isValid(String(rawTargetId))) {
    throw new ValidationError(
      targetType === 'film' ? 'Некорректный ID фильма' : 'Некорректный ID рецензии'
    );
  }

  req.commentTarget = { targetType, targetId: String(rawTargetId) };

  // Гейт B3 читает req.body.filmId — для комментария к фильму он должен быть там,
  // даже если клиент прислал его как targetId.
  if (targetType === 'film') req.body.filmId = String(rawTargetId);

  next();
}

// Гейтинг B3 применяется ТОЛЬКО к комментариям к фильму. Обсуждение текста
// рецензии оценки не требует — это осознанное решение B8, а не недосмотр.
const ratingGate = requireRatingForFilm();
function filmRatingGate(req, res, next) {
  if (req.commentTarget?.targetType !== 'film') return next();
  return ratingGate(req, res, next);
}

// POST /api/comments — корневой комментарий или ответ.
//
// DECISION: B3/1A — комментарии, написанные до гейтинга, не трогаем.
// DECISION: B3/4A — отдельного «can-post» нет: фронт смотрит на userRating.
// DECISION: B3/5A — гонка «vibe и комментарий одновременно» — задача фронта.
// DECISION: B8/1A — комментарий к рецензии разрешён только к опубликованной:
// посторонним 404 (не раскрываем черновик), автору и админу — 403 REVIEW_NOT_PUBLISHED.
// Отклонённая рецензия ведёт себя так же, как pending.
// DECISION: B8/parent — ответ обязан совпадать по targetType/targetId, родитель
// должен быть approved, вложенность — один уровень.
router.post('/', writeLimiter, [
  body('text').notEmpty().isLength({ max: 1000 }).withMessage('Текст не длиннее 1000 символов'),
  body('parentId').optional().isMongoId().withMessage('Некорректный ID родительского комментария')
], authenticate, resolveTarget, filmRatingGate, asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const { text, parentId } = req.body;
  const { targetType, targetId } = req.commentTarget;

  let filmId;

  if (targetType === 'film') {
    const film = await Film.findById(targetId);
    if (!film) throw new NotFoundError('Фильм не найден');
    filmId = film._id;
  } else {
    const review = await Review.findById(targetId).select('filmId userId status');
    if (!review) throw new NotFoundError('Рецензия не найдена');

    if (review.status !== 'approved') {
      const isAuthor = String(review.userId) === String(req.userId);
      const isAdmin = Boolean(req.user?.isAdmin);
      // Посторонний не должен узнать, что черновик вообще существует.
      if (!isAuthor && !isAdmin) throw new NotFoundError('Рецензия не найдена');
      throw new AppError(
        'REVIEW_NOT_PUBLISHED',
        'Рецензию можно комментировать только после публикации',
        403
      );
    }

    filmId = review.filmId;
  }

  if (parentId) {
    const parent = await Comment.findById(parentId).select('filmId targetType targetId parentId status');
    if (!parent) throw new NotFoundError('Родительский комментарий не найден');

    const parentType = parent.targetType || 'film';
    const parentTargetId = parent.targetId || parent.filmId;

    if (parentType !== targetType || String(parentTargetId) !== String(targetId)) {
      throw new ValidationError('Родительский комментарий относится к другой цели');
    }
    // Нельзя отвечать на невидимый pending: получилось бы обсуждение невидимого.
    if (parent.status !== 'approved') {
      throw new ValidationError('Отвечать можно только на опубликованный комментарий');
    }
    if (parent.parentId) {
      throw new ValidationError('Ответы поддерживаются только на верхнем уровне');
    }
  }

  const comment = new Comment({
    userId: req.userId,
    filmId,
    targetType,
    targetId,
    text,
    parentId,
    status: 'pending'
  });
  await comment.save();
  await incCounter(req.userId, 'comments', 1);

  const commentWithUser = await Comment.findById(comment._id).populate('userId', 'nickname isAdmin');
  res.json(commentWithUser);
}));

// GET /api/comments?targetType=film|review&targetId=... — единый список с пагинацией.
// DECISION: B8/api — без targetType это 400: клиент обязан сказать, какой слой
// обсуждения ему нужен, иначе «по умолчанию фильм» скрывал бы ошибку.
router.get('/', asyncHandler(async (req, res, next) => {
  const { targetType, targetId } = req.query;

  if (targetType === undefined || targetType === '') {
    throw new ValidationError('targetType обязателен: film или review');
  }
  if (!TARGET_TYPES.includes(targetType)) {
    throw new ValidationError('targetType должен быть film или review');
  }
  if (!targetId || !mongoose.Types.ObjectId.isValid(String(targetId))) {
    throw new ValidationError('Некорректный targetId');
  }

  const { page, limit, skip } = parsePaging(req.query);
  const visibility = visibilityFor(await resolveViewer(req));
  const filter = targetFilter(targetType, String(targetId));
  const rootsFilter = withVisibility({ ...filter, parentId: null }, visibility);

  const [roots, total] = await Promise.all([
    Comment.find(rootsFilter)
      .populate('userId', 'nickname isAdmin')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Comment.countDocuments(rootsFilter)
  ]);

  const commentIds = roots.map(comment => comment._id);
  const replies = commentIds.length > 0
    ? await Comment.find({ parentId: { $in: commentIds }, ...visibility })
      .populate('userId', 'nickname isAdmin')
      .sort({ createdAt: 1 })
    : [];

  const items = roots.map(comment => ({
    ...comment.toObject(),
    replies: replies.filter(reply => String(reply.parentId) === String(comment._id))
  }));

  res.json({ items, pagination: paginationMeta({ page, limit, total }) });
}));

// GET /api/comments/:filmId — старый роут, обратная совместимость.
// DECISION: B8/3A — отдаёт ТОЛЬКО комментарии к фильму. Иначе комментарии
// к рецензиям (у них filmId берётся из рецензии) протекали бы в список фильма
// и дублировались: они и так видны под рецензией. Формат ответа не меняется.
router.get('/:filmId', validateObjectId('filmId'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const visibility = visibilityFor(await resolveViewer(req));
  const filter = withVisibility({
    filmId: req.params.filmId,
    ...FILM_TARGET_FILTER,
    parentId: null
  }, visibility);

  const comments = await Comment.find(filter)
    .populate('userId', 'nickname isAdmin')
    .sort({ createdAt: -1 });

  const commentIds = comments.map(comment => comment._id);

  const replies = commentIds.length > 0
    ? await Comment.find({ parentId: { $in: commentIds }, ...visibility })
      .populate('userId', 'nickname isAdmin')
      .sort({ createdAt: 1 })
    : [];

  const commentsWithReplies = comments.map(comment => ({
    ...comment.toObject(),
    replies: replies.filter(reply => String(reply.parentId) === String(comment._id))
  }));

  res.json(commentsWithReplies);
}));

// POST /api/comments/:id/like — не гейтится, без изменений.
router.post('/:id/like', writeLimiter, validateObjectId('id'), authenticate, asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

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
}));

module.exports = router;
