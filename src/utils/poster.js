function buildPosterUrl(posterPath, size = 'w500') {
  if (!posterPath) return '';

  const base = process.env.IMAGE_PROXY_BASE_URL;
  if (!base) return `https://image.tmdb.org/t/p/${size}${posterPath}`;

  return `${base}/api/tmdb-image?size=${size}&path=${encodeURIComponent(posterPath)}`;
}

function withPosterUrl(film) {
  if (!film) return film;

  const filmObject = typeof film.toObject === 'function' ? film.toObject() : film;
  return {
    ...filmObject,
    posterUrl: buildPosterUrl(filmObject.posterPath)
  };
}

module.exports = { buildPosterUrl, withPosterUrl };
