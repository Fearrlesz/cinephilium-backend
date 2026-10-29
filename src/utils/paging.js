// Общая пагинация списков: дневник (B5), публичные списки профиля, watchlist (B6).
// Одна реализация, чтобы page/limit не разъезжались между эндпоинтами.
const MAX_LIMIT = 100;

function parsePaging(query = {}) {
  const page  = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function paginationMeta({ page, limit, total }) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}

module.exports = { MAX_LIMIT, parsePaging, paginationMeta };
