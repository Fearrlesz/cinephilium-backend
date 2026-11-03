// Выдача watchlist: свой список и публичный список профиля (B6).
// Правило приватности не живёт здесь — его проверяет вызывающий через
// canViewProfile из utils/privacy.js (не дублируем логику).
const WatchlistItem = require('../models/WatchlistItem');
const { withPosterUrl } = require('./poster');
const { parsePaging, paginationMeta } = require('./paging');

function presentItem(item, req) {
  const object = typeof item.toObject === 'function' ? item.toObject() : { ...item };
  if (object.filmId && typeof object.filmId === 'object' && object.filmId.title) {
    object.filmId = withPosterUrl(object.filmId, req);
  }
  return object;
}

async function listWatchlist(userId, query, req) {
  const { page, limit, skip } = parsePaging(query);
  const filter = { userId };

  const [items, total] = await Promise.all([
    WatchlistItem.find(filter)
      .populate('filmId', 'title poster posterPath year')
      .sort({ addedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    WatchlistItem.countDocuments(filter)
  ]);

  return {
    items: items.map(item => presentItem(item, req)),
    pagination: paginationMeta({ page, limit, total })
  };
}

module.exports = { presentItem, listWatchlist };
