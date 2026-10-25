// Ссылки на постеры.
//
// `image.tmdb.org` в России недоступен, поэтому отдавать клиенту прямой адрес
// TMDB нельзя: браузер получит обрыв соединения и нарисует заглушку. Любой
// постер превращается в адрес прокси `/api/tmdb-image` на нашем домене.
//
// База прокси берётся из IMAGE_PROXY_BASE_URL, а если переменная не задана —
// из самого запроса. Так деплой не ломается из-за того, что в env случайно
// указали домен фронтенда вместо бэкенда.

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/';
const PROXY_PATH = '/api/tmdb-image';

/**
 * Приводит базу к виду `https://host`:
 * обрезает хвостовые слэши и случайно скопированный `/api`.
 * Возвращает пустую строку, если это не http(s)-адрес.
 */
function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return '';
  let base = value.trim();
  if (!base) return '';
  base = base.replace(/\/+$/, '').replace(/\/api$/i, '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/i.test(base)) return '';
  return base;
}

/**
 * Публичный origin текущего запроса — всегда наш бэкенд, который и отдаёт
 * постер. Работает и на Render, и на своём VPS за nginx/reverse-proxy.
 */
function requestOrigin(req) {
  if (!req || typeof req.get !== 'function') return '';
  const host = req.get('host');
  if (!host) return '';
  return `${req.protocol || 'http'}://${host}`;
}

function proxyBase(req) {
  const configured = normalizeBaseUrl(process.env.IMAGE_PROXY_BASE_URL);
  const origin = normalizeBaseUrl(requestOrigin(req));

  if (!configured) return origin;

  // В переменную часто кладут домен фронтенда (Vercel). Прокси там нет, поэтому
  // для запросов с другого origin используем origin самого запроса — это всегда
  // бэкенд, который и отдаёт картинку. Если фронт и бэк на одном домене
  // (origin совпал), конфиг корректен и остаётся как есть.
  if (origin && configured !== origin && frontendOrigins().includes(configured)) {
    return origin;
  }

  return configured;
}

/**
 * Домены фронтенда из конфига: CLIENT_URL и список CORS_ORIGIN.
 * Читаем process.env напрямую, чтобы модуль не зависел от порядка загрузки env.
 */
function frontendOrigins() {
  return [process.env.CLIENT_URL, ...String(process.env.CORS_ORIGIN || '').split(',')]
    .map(normalizeBaseUrl)
    .filter(Boolean);
}

/**
 * Достаёт TMDB-путь постера из любого варианта ссылки: прямой адрес TMDB
 * (`https://image.tmdb.org/t/p/w500/x.jpg`), наш прокси-адрес или легаси-поле
 * `poster`, куда раньше писали готовый URL.
 */
function posterPathFromUrl(value) {
  if (typeof value !== 'string' || !value) return '';

  const direct = value.match(/^https?:\/\/image\.tmdb\.org\/t\/p\/(?:w\d+|original)(\/[^?#]+)/i);
  if (direct) return direct[1];

  if (!value.includes(PROXY_PATH)) return '';

  const proxied = value.match(/[?&]path=([^&#]+)/);
  if (!proxied) return '';

  try {
    const path = decodeURIComponent(proxied[1]);
    return /^\/[A-Za-z0-9/_.-]+$/.test(path) ? path : '';
  } catch {
    return '';
  }
}

function buildPosterUrl(posterPath, size = 'w500', req) {
  if (!posterPath) return '';

  const path = posterPath.startsWith('/') ? posterPath : `/${posterPath}`;
  const base = proxyBase(req);
  if (!base) return `${TMDB_IMAGE_BASE}${size}${path}`;

  return `${base}${PROXY_PATH}?size=${encodeURIComponent(size)}&path=${encodeURIComponent(path)}`;
}

function withPosterUrl(film, req) {
  if (!film) return film;

  const filmObject = typeof film.toObject === 'function' ? film.toObject() : film;
  const posterPath = filmObject.posterPath || posterPathFromUrl(filmObject.poster);
  const posterUrl = buildPosterUrl(posterPath, 'w500', req);

  return {
    ...filmObject,
    // Заодно чиним старые документы: путь появляется из легаси-ссылки.
    posterPath: posterPath || '',
    posterUrl,
    // Обратная совместимость: старый фронтенд читает film.poster как готовый
    // URL и рендерит его напрямую. При включённом прокси это должен быть
    // прокси-адрес, иначе в РФ снова будет заглушка.
    poster: proxyBase(req) && posterUrl ? posterUrl : (filmObject.poster || posterUrl)
  };
}

module.exports = { buildPosterUrl, withPosterUrl, normalizeBaseUrl, posterPathFromUrl };
