// CORS постеров: регрессия «постер не грузится в шеринг-карточку».
//
// Механизм бага (C-2): прокси отдавал постеры с `Cache-Control: immutable` на
// год, но перезаписывал `Vary` значением `Accept-Encoding`, затирая
// `Vary: Origin` от cors-мидлвара. Обычный `<img>` на странице фильма качал
// картинку без `Origin` — ответ без `Access-Control-Allow-Origin` уезжал в кэш
// браузера на год. Дальше canvas (`new Image()` + `crossOrigin='anonymous'`,
// шеринг-карточка) просил тот же URL, браузер отдавал отравленную запись без
// CORS — картинка молча не загружалась, карточка рисовалась градиентом.
//
// Здесь фиксируется серверная половина фикса: `Vary` дополняется, а не
// перезаписывается; `Access-Control-Allow-Origin` есть и на 200, и на 304;
// ошибки прокси не кэшируются. Фронтенд качает постер через fetch → blob
// (см. shareCardRenderer.js), поэтому ему нужен именно ACAO на сетевом ответе.

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { PassThrough } = require('node:stream');

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1/placeholder';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-poster-cors';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-poster-cors';
process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'test-admin-key';
process.env.CLIENT_URL = process.env.CLIENT_URL || 'https://cinephilium.ru';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://cinephilium.ru';
process.env.COOKIE_SECURE = 'false';

const express = require('express');
const tmdbImageHandler = require('../api/tmdb-image');
const corsMiddleware = require('../src/config/cors');

// В тестах ниже global.fetch подменяется на фейковый апстрим, поэтому реальный
// клиентский fetch запоминаем заранее — иначе «запрос» к серверу вернёт муляж.
const clientFetch = global.fetch;

const FRONTEND_ORIGIN = 'https://cinephilium.ru';
const IMAGE_BYTES = Buffer.from('cors-image-bytes');

function imageUpstream() {
  return async () =>
    new Response(IMAGE_BYTES, {
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(IMAGE_BYTES.length)
      }
    });
}

// Тот же приём, что в tests/poster.test.js: handler работает с «сырым» res,
// поэтому обходимся PassThrough + минимальной реализацией заголовков.
async function invokeDirect(query, options = {}) {
  const {
    method = 'GET',
    headers = {},
    presetHeaders = {},
    upstream = imageUpstream()
  } = options;

  const response = new PassThrough();
  response.statusCode = 0;
  response.headers = {};
  response.setHeader = (name, value) => {
    response.headers[name.toLowerCase()] = value;
  };
  response.getHeader = name => response.headers[name.toLowerCase()];

  Object.entries(presetHeaders).forEach(([name, value]) => response.setHeader(name, value));

  let body = '';
  response.setEncoding('utf8');
  response.on('data', chunk => {
    body += chunk;
  });

  const originalFetch = global.fetch;
  global.fetch = upstream;
  try {
    await tmdbImageHandler({ method, query, headers }, response);
  } finally {
    global.fetch = originalFetch;
  }

  return { statusCode: response.statusCode, headers: response.headers, body };
}

function varyTokens(headers) {
  return String(headers.vary || '')
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
}

test('cors-мидлвар и прокси вместе не теряют Vary: Origin', async () => {
  // Ровно та композиция, что в src/app.js: cors() до обработчика.
  const app = express();
  app.use(corsMiddleware);
  app.get('/api/tmdb-image', tmdbImageHandler);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const originalFetch = global.fetch;
  global.fetch = imageUpstream();
  try {
    const { port } = server.address();
    // variant=card — параметр кэш-бастинга с фронтенда: handler его игнорирует.
    const url = `http://127.0.0.1:${port}/api/tmdb-image?size=w780&path=%2Fcard.jpg&variant=card`;
    const response = await clientFetch(url, { headers: { Origin: FRONTEND_ORIGIN } });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN);

    const tokens = varyTokens({ vary: response.headers.get('vary') });
    assert.ok(
      tokens.includes('origin'),
      `Vary потерял Origin — ответ без ACAO отравит кэш: "${response.headers.get('vary')}"`
    );
    assert.ok(tokens.includes('accept-encoding'), `Vary без Accept-Encoding: ${tokens.join(', ')}`);
    assert.equal(
      response.headers.get('cache-control'),
      'public, max-age=31536000, immutable'
    );
  } finally {
    global.fetch = originalFetch;
    server.close();
    await once(server, 'close');
  }
});

test('без cors-мидлвара (Vercel) прокси сам ставит Access-Control-Allow-Origin', async () => {
  const response = await invokeDirect({ path: '/standalone.jpg', size: 'w500' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.deepEqual(varyTokens(response.headers), ['accept-encoding']);
});

test('ACAO и Vary от cors-мидлвара не перезаписываются', async () => {
  const response = await invokeDirect(
    { path: '/preset.jpg', size: 'w500' },
    {
      headers: { origin: FRONTEND_ORIGIN },
      presetHeaders: {
        'Access-Control-Allow-Origin': FRONTEND_ORIGIN,
        Vary: 'Origin'
      }
    }
  );

  assert.equal(response.headers['access-control-allow-origin'], FRONTEND_ORIGIN);
  assert.deepEqual(varyTokens(response.headers), ['origin', 'accept-encoding']);
});

test('Vary не дублирует Accept-Encoding', async () => {
  const response = await invokeDirect(
    { path: '/dedup.jpg', size: 'w500' },
    { presetHeaders: { Vary: 'Accept-Encoding, Origin' } }
  );

  assert.deepEqual(varyTokens(response.headers), ['accept-encoding', 'origin']);
});

test('304 сохраняет CORS-заголовки — иначе canvas отвалится после ревалидации', async () => {
  tmdbImageHandler.clearCache();
  try {
    const first = await invokeDirect({ path: '/revalidate.jpg', size: 'w342' });
    assert.equal(first.statusCode, 200);
    assert.ok(first.headers.etag, 'ETag нужен для условного запроса');

    const notModified = await invokeDirect(
      { path: '/revalidate.jpg', size: 'w342' },
      {
        headers: { origin: FRONTEND_ORIGIN, 'if-none-match': first.headers.etag },
        presetHeaders: { 'Access-Control-Allow-Origin': FRONTEND_ORIGIN, Vary: 'Origin' }
      }
    );

    assert.equal(notModified.statusCode, 304);
    assert.equal(notModified.body, '');
    assert.equal(notModified.headers['access-control-allow-origin'], FRONTEND_ORIGIN);
    assert.deepEqual(varyTokens(notModified.headers), ['origin', 'accept-encoding']);
  } finally {
    tmdbImageHandler.clearCache();
  }
});

test('ошибки прокси не кэшируются и видны фронтенду', async () => {
  const response = await invokeDirect({ path: '/../etc/passwd' });

  assert.equal(response.statusCode, 400);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.deepEqual(JSON.parse(response.body), { error: 'Invalid path' });
});
