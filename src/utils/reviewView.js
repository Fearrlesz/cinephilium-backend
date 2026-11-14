// Публичная проекция Review (C-1).
//
// У самой рецензии секретов нет, но `...review.toObject()` тащил `__v` и —
// главное — вложенный `ratingId` целиком. Здесь поле `ratingId` проходит через
// toPublicRating(), а остальные поля перечислены явно: новая колонка в схеме
// не утечёт сама по себе.
const { toPublicRating } = require('./ratingView');

const PUBLIC_REVIEW_FIELDS = [
  '_id',
  'userId',
  'filmId',
  'ratingId',
  'title',
  'text',
  'isSpoiler',
  'status',
  'likes',
  'createdAt',
  'updatedAt'
];

function plain(review) {
  if (!review) return null;
  return typeof review.toObject === 'function' ? review.toObject() : review;
}

/**
 * Публичное представление рецензии. Популенный `ratingId` урезается до белого
 * списка Rating; непопуленный ObjectId остаётся как есть.
 */
function toPublicReview(review) {
  const source = plain(review);
  if (!source) return null;

  const result = {};
  for (const field of PUBLIC_REVIEW_FIELDS) {
    if (source[field] !== undefined) result[field] = source[field];
  }

  if (ratingIdIsPopulated(review)) {
    result.ratingId = toPublicRating(source.ratingId);
  }
  return result;
}

function ratingIdIsPopulated(review) {
  if (!review || typeof review.populated !== 'function') return false;
  return Boolean(review.populated('ratingId'));
}

module.exports = { PUBLIC_REVIEW_FIELDS, toPublicReview };
