// Выдача вкладок профиля (B9): оценки, рецензии, комментарии.
//
// Один формат для всех трёх вкладок — `{ items, pagination }` (P0-2), одна
// пагинация `utils/paging.js`, как у дневника (B5), watchlist (B6) и лайков (B7).
// Приватность здесь не проверяется: её проверяет вызывающий роут через
// canViewProfile, а статус-фильтр (approved для чужих) приходит снаружи.
const Rating  = require('../models/Rating');
const Review  = require('../models/Review');
const Comment = require('../models/Comment');
const { withPosterUrl } = require('./poster');
const { parsePaging, paginationMeta } = require('./paging');

const FILM_FIELDS = 'title poster posterPath year';

function presentRating(rating, req) {
  return {
    id: rating._id,
    film: withPosterUrl(rating.filmId, req),
    // DECISION: B9/2B+4A — публичная вкладка отдаёт и vibe, и full одним списком.
    // completeness есть в каждом элементе, поэтому «ноль как балл» отличим от
    // настоящей низкой оценки. counters.ratings (только full) намеренно не равен
    // pagination.total этой вкладки (все оценки) — см. README/CHANGELOG.
    technicalScore: rating.technicalScore,
    combinedScore:  rating.combinedScore,
    vibe:           rating.vibe,
    completeness:   rating.completeness || 'full',
    genrePreset:    rating.genrePreset,
    blockWeights:   rating.blockWeights,
    scores:         rating.scores,
    textReview:     rating.textReview,
    createdAt:      rating.createdAt
  };
}

function presentReview(review, req) {
  const film = withPosterUrl(review.filmId, req);
  return {
    _id: review._id,
    id: review._id,
    film,
    filmId: film,
    ratingId: review.ratingId,
    title: review.title,
    text: review.text,
    // B4: профиль перечисляет поля руками, поэтому флаг обязателен и здесь —
    // иначе на вкладке рецензий он бы тихо терялся.
    isSpoiler: review.isSpoiler === true,
    // Владелец и админ видят pending/rejected, поэтому статус нужен для UI.
    status: review.status,
    likes: review.likes,
    createdAt: review.createdAt
  };
}

function presentComment(comment, req) {
  const targetType = comment.targetType || 'film';
  const populatedTarget = comment.targetId;

  // targetId у комментария к рецензии популен объектом Review (см. listComments).
  // У комментария к фильму это ObjectId — объект не подменяем, чтобы тип поля
  // не зависел от targetType.
  const isReviewTarget = targetType === 'review'
    && populatedTarget
    && typeof populatedTarget === 'object'
    && populatedTarget.title !== undefined;

  return {
    id: comment._id,
    film: withPosterUrl(comment.filmId, req),
    text: comment.text,
    // DECISION: B9/9A — вкладка отдаёт оба типа комментариев, targetType есть
    // в каждом элементе: без него комментарий к фильму не отличить от ответа
    // под рецензией (у обоих filmId заполнен).
    targetType,
    targetId: isReviewTarget
      ? populatedTarget._id
      : (comment.targetId || comment.filmId?._id || comment.filmId),
    // Для targetType: 'review' — популенная рецензия, к которой написан ответ.
    // Для targetType: 'film' — null, сама цель уже в `film`.
    target: isReviewTarget
      ? {
          id: populatedTarget._id,
          title: populatedTarget.title,
          text: populatedTarget.text,
          isSpoiler: populatedTarget.isSpoiler === true,
          status: populatedTarget.status,
          createdAt: populatedTarget.createdAt
        }
      : null,
    parentId: comment.parentId || null,
    likes: comment.likes || [],
    status: comment.status,
    createdAt: comment.createdAt
  };
}

// DECISION: B9/3A — сортировка по дате создания, новые сверху. Параметр ?sort=
// в B9 не добавляется (это была бы 3C), поэтому сортировка фиксирована.
async function listRatings(userId, query, req) {
  const { page, limit, skip } = parsePaging(query);
  const filter = { userId };

  const [items, total] = await Promise.all([
    Rating.find(filter)
      .populate('filmId', FILM_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Rating.countDocuments(filter)
  ]);

  return {
    items: items.map(rating => presentRating(rating, req)),
    pagination: paginationMeta({ page, limit, total })
  };
}

async function listReviews(userId, query, statusFilter, req) {
  const { page, limit, skip } = parsePaging(query);
  const filter = { userId, ...statusFilter };

  const [items, total] = await Promise.all([
    Review.find(filter)
      .populate('filmId', FILM_FIELDS)
      .populate('ratingId')
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Review.countDocuments(filter)
  ]);

  return {
    items: items.map(review => presentReview(review, req)),
    pagination: paginationMeta({ page, limit, total })
  };
}

async function listComments(userId, query, statusFilter, req) {
  const { page, limit, skip } = parsePaging(query);
  const filter = { userId, ...statusFilter };

  const [items, total] = await Promise.all([
    Comment.find(filter)
      .populate('filmId', FILM_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Comment.countDocuments(filter)
  ]);

  // targetId у комментария к рецензии — это Review; у комментария к фильму —
  // Film. Популируем только review-подмножество, чтобы не подменять ObjectId
  // film-комментариев пустым результатом поиска в чужой коллекции.
  const reviewTargets = items.filter(comment =>
    (comment.targetType || 'film') === 'review' && comment.targetId
  );
  if (reviewTargets.length > 0) {
    await Comment.populate(reviewTargets, {
      path: 'targetId',
      model: 'Review',
      select: 'title text isSpoiler status createdAt'
    });
  }

  return {
    items: items.map(comment => presentComment(comment, req)),
    pagination: paginationMeta({ page, limit, total })
  };
}

module.exports = {
  presentRating,
  presentReview,
  presentComment,
  listRatings,
  listReviews,
  listComments
};
