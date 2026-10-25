function buildPosterUrl(posterPath, size = 'w500') {
  if (!posterPath) return '';

  const base = process.env.IMAGE_PROXY_BASE_URL;
  if (!base) return `https://image.tmdb.org/t/p/${size}${posterPath}`;

  return `${base}/api/tmdb-image?size=${size}&path=${encodeURIComponent(posterPath)}`;
}

function withPosterUrl(film) {
  if (!film) return film;

  const filmObject = typeof film.toObject === 'function' ? film.toObject() : film;
  const posterUrl = buildPosterUrl(filmObject.posterPath);
  return {
    ...filmObject,
    posterUrl,
    // Обратная совместимость: старый фронтенд читает film.poster как готовый URL.
    poster: filmObject.poster || posterUrl
  };
}

module.exports = { buildPosterUrl, withPosterUrl };
