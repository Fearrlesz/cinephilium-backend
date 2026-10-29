// Выдача «Понравившихся»: свой список и публичный список профиля (B7).
// Приватность проверяет вызывающий через canViewProfile — здесь её нет.
const FilmLike = require('../models/FilmLike');
const { withPosterUrl } = require('./poster');
const { parsePaging, paginationMeta } = require('./paging');

function presentLike(like, req) {
  const object = typeof like.toObject === 'function' ? like.toObject() : { ...like };

  // weight — служебное анти-накруточное поле (снимок trustWeight), наружу не отдаём:
  // это внутренняя кухня анти-накрутки, а не данные профиля.
  delete object.weight;

  if (object.filmId && typeof object.filmId === 'object' && object.filmId.title) {
    object.filmId = withPosterUrl(object.filmId, req);
  }
  return object;
}

async function listLikes(userId, query, req) {
  const { page, limit, skip } = parsePaging(query);
  const filter = { userId };

  const [items, total] = await Promise.all([
    FilmLike.find(filter)
      .populate('filmId', 'title poster posterPath year likesCount')
      .sort({ addedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    FilmLike.countDocuments(filter)
  ]);

  return {
    items: items.map(like => presentLike(like, req)),
    pagination: paginationMeta({ page, limit, total })
  };
}

module.exports = { presentLike, listLikes };
