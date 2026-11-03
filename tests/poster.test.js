process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/cinephilium-test-poster';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';
// Фронтенд (https://film.ru) и бэкенд (https://api.film.ru) — разные домены.
process.env.IMAGE_PROXY_BASE_URL = 'https://api.film.ru';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Film = require('../src/models/Film');
const Rating = require('../src/models/Rating');
const User = require('../src/models/User');
const Action = require('../src/models/Action');
const Event = require('../src/models/Event');
const Review = require('../src/models/Review');
const Comment = require('../src/models/Comment');
const Watch = require('../src/models/Watch');
const app = require('../src/app');
const { buildPosterUrl } = require('../src/utils/poster');
const { migratePosters } = require('../scripts/migrate-posters');
const tmdbImageHandler = require('../api/tmdb-image');
const { PassThrough } = require('node:stream');
const requestFetch = global.fetch;

let server;
let baseUrl;
let originalWatchCount;

before(async () => {
  // В этом файле нет подключения к Mongo: тесты подменяют запросы моделей.
  // Страница фильма с B5 дополнительно считает записи дневника — без заглушки
  // запрос буферизуется и падает по таймауту (10 с) в 500.
  originalWatchCount = Watch.countDocuments;
  Watch.countDocuments = async () => 0;

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Watch.countDocuments = originalWatchCount;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

test('buildPosterUrl uses the configured image proxy', () => {
  assert.equal(
    buildPosterUrl('/abc.jpg'),
    'https://api.film.ru/api/tmdb-image?size=w500&path=%2Fabc.jpg'
  );
});

test('buildPosterUrl returns an empty string for an empty poster path', () => {
  assert.equal(buildPosterUrl(''), '');
});

test('buildPosterUrl falls back to TMDB when the proxy base is unset', () => {
  const originalBase = process.env.IMAGE_PROXY_BASE_URL;
  delete process.env.IMAGE_PROXY_BASE_URL;
  try {
    assert.equal(buildPosterUrl('/abc.jpg'), 'https://image.tmdb.org/t/p/w500/abc.jpg');
  } finally {
    process.env.IMAGE_PROXY_BASE_URL = originalBase;
  }
});

test('GET /api/films/:id includes a posterUrl based on posterPath', async () => {
  // /api/films/:id собирает средние и документ одним Film.aggregate (B2),
  // поэтому подменяем именно его: тест про постеры, а не про Mongo.
  const originalAggregate = Film.aggregate;
  const filmId = '507f1f77bcf86cd799439011';
  Film.aggregate = async () => ([{
    _id: filmId,
    posterPath: '/abc.jpg',
    poster: ''
  }]);

  try {
    const response = await requestFetch(`${baseUrl}/api/films/${filmId}`);
    const film = await response.json();
    assert.equal(response.status, 200);
    assert.equal(
      film.posterUrl,
      'https://api.film.ru/api/tmdb-image?size=w500&path=%2Fabc.jpg'
    );
    assert.equal(film.posterPath, '/abc.jpg');
  } finally {
    Film.aggregate = originalAggregate;
  }
});

test('POST /api/films/import persists posterPath and leaves poster empty', async () => {
  const originalFindOne = Film.findOne;
  const originalSave = Film.prototype.save;
  const originalUserFindById = User.findById;
  const originalUserFindByIdAndUpdate = User.findByIdAndUpdate;
  const originalActionCreate = Action.create;
  const originalEventCreate = Event.create;
  const originalRatingCount = Rating.countDocuments;
  const originalReviewCount = Review.countDocuments;
  const originalCommentCount = Comment.countDocuments;
  const originalFetch = global.fetch;
  const originalDb = mongoose.connection.db;
  const userId = '507f1f77bcf86cd799439012';
  const user = { _id: userId, nickname: 'Tester', isAdmin: false, achievements: [] };

  Film.findOne = async () => null;
  Film.prototype.save = async function save() { return this; };
  User.findById = async () => user;
  User.findByIdAndUpdate = async () => user;
  Action.create = async () => ({});
  Event.create = async () => ({});
  Rating.countDocuments = async () => 0;
  Review.countDocuments = async () => 0;
  Comment.countDocuments = async () => 0;
  mongoose.connection.db = {
    collection: () => ({
      find: () => ({
        sort() { return this; },
        limit() { return this; },
        toArray: async () => []
      }),
      countDocuments: async () => 0
    })
  };
  global.fetch = async url => ({
    ok: true,
    json: async () => String(url).includes('language=ru-RU')
      ? {
          id: 123,
          title: 'Test film',
          poster_path: '/abc.jpg',
          release_date: '2020-01-01',
          genres: [],
          credits: { crew: [], cast: [] },
          videos: { results: [] }
        }
      : {}
  });

  try {
    const token = require('../src/utils/jwt').signAccessToken(userId);
    const response = await requestFetch(`${baseUrl}/api/films/import`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ tmdbId: 123 })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.film.posterPath, '/abc.jpg');
    // poster сохранён для обратной совместимости: старый фронтенд читает его как готовый URL
    assert.equal(body.film.poster, 'https://api.film.ru/api/tmdb-image?size=w500&path=%2Fabc.jpg');
  } finally {
    Film.findOne = originalFindOne;
    Film.prototype.save = originalSave;
    User.findById = originalUserFindById;
    User.findByIdAndUpdate = originalUserFindByIdAndUpdate;
    Action.create = originalActionCreate;
    Event.create = originalEventCreate;
    Rating.countDocuments = originalRatingCount;
    Review.countDocuments = originalReviewCount;
    Comment.countDocuments = originalCommentCount;
    mongoose.connection.db = originalDb;
    global.fetch = originalFetch;
  }
});

test('poster migration fills missing paths and skips films already migrated', async () => {
  const films = [
    {
      poster: 'https://image.tmdb.org/t/p/w500/first.jpg',
      posterPath: '',
      async save() {}
    },
    {
      poster: 'https://image.tmdb.org/t/p/original/folder/second.jpg',
      posterPath: '',
      async save() {}
    },
    {
      poster: 'https://image.tmdb.org/t/p/w500/third.jpg',
      posterPath: '/existing.jpg',
      async save() {}
    }
  ];
  const messages = [];
  const Model = { find: async () => films };

  const result = await migratePosters(Model, { log: message => messages.push(message) });

  assert.deepEqual(result, { migrated: 2, skipped: 1 });
  assert.deepEqual(films.map(film => film.posterPath), [
    '/first.jpg',
    '/folder/second.jpg',
    '/existing.jpg'
  ]);
  assert.deepEqual(messages, ['migrated: 2, skipped: 1']);
});

async function invokeImageHandler(query, method = 'GET', upstreamFetch, headers = {}) {
  const response = new PassThrough();
  response.statusCode = 0;
  response.headers = {};
  response.setHeader = (name, value) => {
    response.headers[name.toLowerCase()] = value;
  };
  let body = '';
  response.setEncoding('utf8');
  response.on('data', chunk => { body += chunk; });

  const originalFetch = global.fetch;
  if (upstreamFetch) global.fetch = upstreamFetch;
  try {
    await tmdbImageHandler({ method, query, headers }, response);
  } finally {
    global.fetch = originalFetch;
  }
  return { statusCode: response.statusCode, headers: response.headers, body };
}

test('TMDB image proxy rejects missing and unsafe paths', async () => {
  const missing = await invokeImageHandler({});
  const unsafe = await invokeImageHandler({ path: '/../etc/passwd' });
  assert.equal(missing.statusCode, 400);
  assert.deepEqual(JSON.parse(missing.body), { error: 'Invalid path' });
  assert.equal(unsafe.statusCode, 400);
  assert.deepEqual(JSON.parse(unsafe.body), { error: 'Invalid path' });
});

test('TMDB image proxy rejects unsupported sizes', async () => {
  const response = await invokeImageHandler({ path: '/abc.jpg', size: 'huge' });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'Invalid size' });
});

test('TMDB image proxy accepts w200 — размер из поиска на фронтенде', async () => {
  const response = await invokeImageHandler(
    { path: '/search-result.jpg', size: 'w200' },
    'GET',
    async url => {
      assert.equal(url, 'https://image.tmdb.org/t/p/w200/search-result.jpg');
      return new Response(Buffer.from('search-poster'), {
        headers: { 'content-type': 'image/jpeg', 'content-length': '13' }
      });
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'search-poster');
});

test('алиас /api/poster/w200/... тоже отдаёт постер', async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => {
    assert.equal(url, 'https://image.tmdb.org/t/p/w200/alias.jpg');
    return new Response(Buffer.from('alias-poster'), {
      headers: { 'content-type': 'image/jpeg', 'content-length': '12' }
    });
  };

  try {
    const response = await requestFetch(`${baseUrl}/api/poster/w200/alias.jpg`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(await response.text(), 'alias-poster');
  } finally {
    global.fetch = originalFetch;
  }
});

test('TMDB image proxy streams image bytes and sets cache headers', async () => {
  const response = await invokeImageHandler(
    { path: '/abc.jpg' },
    'GET',
    async url => {
      assert.equal(url, 'https://image.tmdb.org/t/p/w500/abc.jpg');
      return new Response(Buffer.from('image bytes'), {
        headers: { 'content-type': 'image/jpeg', 'content-length': '11' }
      });
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'image bytes');
  assert.equal(response.headers['content-type'], 'image/jpeg');
  assert.equal(
    response.headers['cache-control'],
    'public, max-age=31536000, immutable'
  );
  assert.equal(response.headers.vary, 'Accept-Encoding');
});

test('buildPosterUrl нормализует базу прокси (слэш и случайный /api)', () => {
  const originalBase = process.env.IMAGE_PROXY_BASE_URL;

  try {
    process.env.IMAGE_PROXY_BASE_URL = 'https://api.film.ru/';
    assert.equal(
      buildPosterUrl('/abc.jpg'),
      'https://api.film.ru/api/tmdb-image?size=w500&path=%2Fabc.jpg'
    );

    process.env.IMAGE_PROXY_BASE_URL = 'https://api.film.ru/api/';
    assert.equal(
      buildPosterUrl('/abc.jpg', 'w342'),
      'https://api.film.ru/api/tmdb-image?size=w342&path=%2Fabc.jpg'
    );
  } finally {
    process.env.IMAGE_PROXY_BASE_URL = originalBase;
  }
});

test('легаси-poster с прямой ссылкой TMDB отдаётся через прокси', async () => {
  const filmId = '507f1f77bcf86cd799439013';
  const originalAggregate = Film.aggregate;
  Film.aggregate = async () => ([{
    _id: filmId,
    posterPath: '',
    poster: 'https://image.tmdb.org/t/p/w500/legacy.jpg'
  }]);

  try {
    const response = await requestFetch(`${baseUrl}/api/films/${filmId}`);
    const film = await response.json();

    assert.equal(response.status, 200);
    // Старый фронтенд рендерит film.poster напрямую: там не должно остаться TMDB.
    assert.equal(
      film.poster,
      'https://api.film.ru/api/tmdb-image?size=w500&path=%2Flegacy.jpg'
    );
    assert.equal(film.posterPath, '/legacy.jpg');
  } finally {
    Film.aggregate = originalAggregate;
  }
});

test('без IMAGE_PROXY_BASE_URL база прокси берётся из origin запроса', async () => {
  const originalBase = process.env.IMAGE_PROXY_BASE_URL;
  delete process.env.IMAGE_PROXY_BASE_URL;
  const filmId = '507f1f77bcf86cd799439014';
  const originalAggregate = Film.aggregate;
  Film.aggregate = async () => ([{
    _id: filmId,
    posterPath: '/request-origin.jpg',
    poster: ''
  }]);

  try {
    const response = await requestFetch(`${baseUrl}/api/films/${filmId}`);
    const film = await response.json();
    assert.equal(response.status, 200);
    assert.equal(film.posterUrl, `${baseUrl}/api/tmdb-image?size=w500&path=%2Frequest-origin.jpg`);
  } finally {
    process.env.IMAGE_PROXY_BASE_URL = originalBase;
    Film.aggregate = originalAggregate;
  }
});

test('домен фронтенда в IMAGE_PROXY_BASE_URL игнорируется: берётся origin запроса', async () => {
  const originalBase = process.env.IMAGE_PROXY_BASE_URL;
  const originalCors = process.env.CORS_ORIGIN;
  const originalClient = process.env.CLIENT_URL;
  const frontend = 'https://cinephilium-frontendnew.vercel.app';

  process.env.IMAGE_PROXY_BASE_URL = frontend;
  process.env.CORS_ORIGIN = frontend;
  process.env.CLIENT_URL = frontend;

  const filmId = '507f1f77bcf86cd799439015';
  const originalAggregate = Film.aggregate;
  Film.aggregate = async () => ([{
    _id: filmId,
    posterPath: '/front-host.jpg',
    poster: ''
  }]);

  try {
    const response = await requestFetch(`${baseUrl}/api/films/${filmId}`);
    const film = await response.json();
    assert.equal(response.status, 200);
    // /api/tmdb-image на Vercel не существует — ссылка должна идти на бэкенд.
    assert.equal(
      film.posterUrl,
      `${baseUrl}/api/tmdb-image?size=w500&path=%2Ffront-host.jpg`
    );
  } finally {
    process.env.IMAGE_PROXY_BASE_URL = originalBase;
    process.env.CORS_ORIGIN = originalCors;
    process.env.CLIENT_URL = originalClient;
    Film.aggregate = originalAggregate;
  }
});

test('прокси постеров кэширует байты и отдаёт 304 по If-None-Match', async () => {
  tmdbImageHandler.clearCache();
  const originalFetch = global.fetch;
  let upstreamCalls = 0;
  global.fetch = async () => {
    upstreamCalls += 1;
    return new Response(Buffer.from('cached-image-bytes'), {
      headers: { 'content-type': 'image/jpeg', 'content-length': '18' }
    });
  };

  try {
    const first = await invokeImageHandler({ path: '/cached.jpg', size: 'w342' });
    const second = await invokeImageHandler({ path: '/cached.jpg', size: 'w342' });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body, 'cached-image-bytes');
    assert.equal(upstreamCalls, 1, 'второй запрос должен прийти из кэша');
    assert.ok(first.headers.etag, 'ETag обязателен для условных запросов');

    const notModified = await invokeImageHandler(
      { path: '/cached.jpg', size: 'w342' },
      'GET',
      undefined,
      { 'if-none-match': first.headers.etag }
    );
    assert.equal(notModified.statusCode, 304);
    assert.equal(notModified.body, '');
  } finally {
    global.fetch = originalFetch;
    tmdbImageHandler.clearCache();
  }
});

test('постеры не упираются в общий лимит API (200/мин)', async () => {
  tmdbImageHandler.clearCache();
  const originalFetch = global.fetch;
  let upstreamCalls = 0;
  global.fetch = async () => {
    upstreamCalls += 1;
    return new Response(Buffer.from('img'), {
      headers: { 'content-type': 'image/jpeg', 'content-length': '3' }
    });
  };

  try {
    const url = `${baseUrl}/api/tmdb-image?size=w45&path=%2Fgrid.jpg`;
    const responses = await Promise.all(
      Array.from({ length: 210 }, () => requestFetch(url))
    );
    const statuses = responses.map(response => response.status);
    assert.ok(
      statuses.every(status => status === 200),
      `часть постеров получила не 200: ${[...new Set(statuses)].join(', ')}`
    );
    assert.equal(upstreamCalls, 1, 'одинаковые постеры должны склеиваться');
  } finally {
    global.fetch = originalFetch;
    tmdbImageHandler.clearCache();
  }
});
