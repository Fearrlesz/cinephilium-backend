// Единая публичная проекция Rating (C-1).
//
// `ip` — персональные данные (152-ФЗ/GDPR), `weight` — антифрод-сигнал
// («теневой бан» оценки), `vibeCreatedAt` — служебная отметка для дневного капа.
// Ни одно из них не должно покидать сервер. Поэтому вместо `...rating.toObject()`
// наружу уходит только явный список полей ниже: новая колонка в схеме сама
// не утечёт — её придётся добавить сюда осознанно (и это видно на ревью).
const PUBLIC_RATING_FIELDS = [
  '_id',
  // ObjectId либо { _id, nickname, isAdmin } — уже ограничен populate.
  'userId',
  // ObjectId либо фильм, урезанный populate; постер подставляет роут.
  'filmId',
  'completeness',
  'genrePreset',
  'blockWeights',
  'scores',
  'vibe',
  'technicalScore',
  'combinedScore',
  'textReview',
  'createdAt'
];

// Поля Rating, которые разрешено тянуть внутрь `Review.ratingId`.
// Список, а не `+ip`: иначе `ip`/`weight` вернутся через populate в рецензиях,
// профильной вкладке и ленте, минуя toPublicRating().
const REVIEW_RATING_SELECT = [
  '_id',
  'completeness',
  'vibe',
  'technicalScore',
  'combinedScore',
  'genrePreset',
  'blockWeights',
  'scores',
  'textReview',
  'createdAt'
].join(' ');

function plain(rating) {
  if (!rating) return null;
  return typeof rating.toObject === 'function' ? rating.toObject() : rating;
}

/**
 * Публичное представление оценки: белый список полей + fallback completeness.
 * Принимает Mongoose-документ, populate-документ или lean-объект.
 */
function toPublicRating(rating) {
  const source = plain(rating);
  if (!source) return null;

  const result = {};
  for (const field of PUBLIC_RATING_FIELDS) {
    if (source[field] !== undefined) result[field] = source[field];
  }

  // DECISION: 2A — отсутствие completeness читается как full, а не как «нет».
  result.completeness = source.completeness || 'full';
  return result;
}

module.exports = { PUBLIC_RATING_FIELDS, REVIEW_RATING_SELECT, toPublicRating };
