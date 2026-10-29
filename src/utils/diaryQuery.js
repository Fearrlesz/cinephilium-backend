// Общая выдача дневника: свой список, публичный дневник пользователя и алиас
// GET /api/users/:id/watches (B-PRIVACY). Одна реализация, чтобы пагинация
// и правила приватности не разъехались между точками входа.
const Watch = require('../models/Watch');
const { withPosterUrl } = require('./poster');
const { parsePaging, paginationMeta } = require('./paging');

function presentWatch(watch, req) {
  const object = typeof watch.toObject === 'function' ? watch.toObject() : { ...watch };
  if (object.filmId && typeof object.filmId === 'object' && object.filmId.title) {
    object.filmId = withPosterUrl(object.filmId, req);
  }
  return object;
}

async function listDiary(userId, query, req) {
  const { page, limit, skip } = parsePaging(query);
  const filter = { userId };

  const [items, total] = await Promise.all([
    Watch.find(filter)
      .populate('filmId', 'title poster posterPath year')
      .sort({ watchedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Watch.countDocuments(filter)
  ]);

  return {
    items: items.map(watch => presentWatch(watch, req)),
    pagination: paginationMeta({ page, limit, total })
  };
}

module.exports = { presentWatch, listDiary };
