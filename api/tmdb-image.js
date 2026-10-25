const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

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

function sendError(res, statusCode, message) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
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

  const url = `https://image.tmdb.org/t/p/${size}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const upstream = await fetch(url, { signal: controller.signal });
    if (!upstream.ok) {
      sendError(res, upstream.status === 404 ? 404 : 502, 'Image upstream error');
      return;
    }

    const contentType = upstream.headers.get('content-type');
    if (!contentType || !contentType.toLowerCase().startsWith('image/')) {
      sendError(res, 502, 'Invalid image response');
      return;
    }

    const contentLength = upstream.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > 5_000_000) {
      sendError(res, 502, 'Image is too large');
      return;
    }

    if (!upstream.body) {
      sendError(res, 502, 'Empty image response');
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Vary', 'Accept-Encoding');
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      if (!res.destroyed) res.destroy(error);
      return;
    }

    if (controller.signal.aborted || error.name === 'AbortError') {
      sendError(res, 504, 'Upstream timeout');
      return;
    }

    sendError(res, 502, 'Image upstream error');
  } finally {
    clearTimeout(timeout);
  }
};
