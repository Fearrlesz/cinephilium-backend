// Прокси постеров TMDB.
//
// Зачем он нужен: `image.tmdb.org` в России недоступен (соединение рвётся на
// уровне DPI), поэтому браузер не может загрузить постер напрямую. Сервер же
// (Render, любой зарубежный VPS) картинку достаёт и отдаёт клиенту со своего
// домена. Один и тот же handler использует и Express (`src/app.js`), и Vercel
// (`api/`), поэтому он не зависит от express-специфичных вещей.

const crypto = require('node:crypto');

const ALLOWED_SIZES = new Set([
  'w45',
  'w92',
  'w154',
  'w185',
  'w300',
  'w342',
  'w500',
  'w780',
  'original'
]);

const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 5_000_000;

// Постеры одинаковые у всех посетителей, а каждая промашка кэша — это поход
// в TMDB из процесса Render. Держим небольшой LRU в памяти инстанса: он
// экономит и трафик, и время ответа (TTFB падает с ~1 с до единиц мс).
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const cache = new Map();
let cacheBytes = 0;

// Одну и ту же картинку могут запросить параллельно (сетка постеров):
// не гоняем N одинаковых запросов в TMDB, а ждём один.
const inflight = new Map();

function sendError(res, statusCode, message) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}

function imageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function cacheKey(size, path) {
  return `${size}${path}`;
}

function etagFor(buffer) {
  return `"${crypto.createHash('sha1').update(buffer).digest('hex')}"`;
}

function isNotModified(req, etag) {
  const header = req.headers?.['if-none-match'];
  if (typeof header !== 'string' || !header) return false;
  return header
    .split(',')
    .map(value => value.trim())
    .some(value => value === etag || value === '*');
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  // Освежаем позицию в LRU: последний ключ — самый «горячий».
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key, entry) {
  if (entry.buffer.length > MAX_IMAGE_BYTES) return;
  const existing = cache.get(key);
  if (existing) {
    cacheBytes -= existing.buffer.length;
    cache.delete(key);
  }
  cache.set(key, entry);
  cacheBytes += entry.buffer.length;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) {
    const [oldestKey, oldestEntry] = cache.entries().next().value;
    cache.delete(oldestKey);
    cacheBytes -= oldestEntry.buffer.length;
  }
}

function sendImage(res, entry) {
  res.statusCode = 200;
  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Content-Length', entry.buffer.length);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('ETag', entry.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  res.end(entry.buffer);
}

function sendNotModified(res, entry) {
  res.statusCode = 304;
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('ETag', entry.etag);
  res.end();
}

async function downloadImage(size, path) {
  const url = `https://image.tmdb.org/t/p/${size}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(url, { signal: controller.signal });

    if (!upstream.ok) {
      throw imageError(upstream.status === 404 ? 'NOT_FOUND' : 'UPSTREAM');
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw imageError('INVALID_CONTENT');
    }

    const contentLength = upstream.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_IMAGE_BYTES) {
      throw imageError('TOO_LARGE');
    }

    if (!upstream.body) throw imageError('UPSTREAM');

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length === 0) throw imageError('UPSTREAM');
    if (buffer.length > MAX_IMAGE_BYTES) throw imageError('TOO_LARGE');

    return { buffer, contentType, etag: etagFor(buffer) };
  } catch (error) {
    if (error.code) throw error;
    if (controller.signal.aborted || error.name === 'AbortError') {
      throw imageError('TIMEOUT');
    }
    throw imageError('UPSTREAM');
  } finally {
    clearTimeout(timeout);
  }
}

function errorResponseFor(code) {
  switch (code) {
    case 'NOT_FOUND':
      return [404, 'Image upstream error'];
    case 'TIMEOUT':
      return [504, 'Upstream timeout'];
    case 'TOO_LARGE':
      return [502, 'Image is too large'];
    case 'INVALID_CONTENT':
      return [502, 'Invalid image response'];
    default:
      return [502, 'Image upstream error'];
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendError(res, 405, 'Method not allowed');
    return;
  }

  const { path } = req.query;
  if (
    typeof path !== 'string' ||
    path.length < 1 ||
    path.length > 200 ||
    !/^\/[A-Za-z0-9/_.-]+$/.test(path) ||
    path.includes('..') ||
    path.startsWith('//')
  ) {
    sendError(res, 400, 'Invalid path');
    return;
  }

  const size = req.query.size === undefined ? 'w500' : req.query.size;
  if (typeof size !== 'string' || !ALLOWED_SIZES.has(size)) {
    sendError(res, 400, 'Invalid size');
    return;
  }

  const key = cacheKey(size, path);

  const cached = cacheGet(key);
  if (cached) {
    if (isNotModified(req, cached.etag)) sendNotModified(res, cached);
    else sendImage(res, cached);
    return;
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = downloadImage(size, path).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }

  try {
    const entry = await pending;
    cacheSet(key, entry);
    if (isNotModified(req, entry.etag)) sendNotModified(res, entry);
    else sendImage(res, entry);
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy(error);
      return;
    }
    const [status, message] = errorResponseFor(error.code);
    sendError(res, status, message);
  }
};

// Для тестов: сбросить кэш между сценариями.
module.exports.clearCache = function clearCache() {
  cache.clear();
  inflight.clear();
  cacheBytes = 0;
};
