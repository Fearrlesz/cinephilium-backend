// Регрессия C-1: служебные поля Rating (ip, weight, vibeCreatedAt) не должны
// покидать сервер ни на одном публичном или «своём» роуте.
// Запуск: node --test tests/rating-privacy.test.js
// База — in-memory MongoDB, внешний mongod не нужен.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'rating-privacy-access';
process.env.JWT_REFRESH_SECRET = 'rating-privacy-refresh';
process.env.TMDB_API_KEY = 'rating-privacy-tmdb';
process.env.ADMIN_SECRET_KEY = 'rating-privacy-admin';
process.env.CORS_ORIGIN = 'https://film.ru';
process.env.COOKIE_DOMAIN = 'localhost';
process.env.COOKIE_SECURE = 'false';

const { after, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let server;
let baseUrl;
let app;
let dbPath;
let User;
let Film;
let Rating;
let Review;
let Event;
let Action;

// Маркер, которого не должно быть ни в одном ответе: и как ключ, и как значение.
const IP_MARKER = '10.0.0.99';
// __v глобально проверять нельзя: агрегат фильма отдаёт raw-документ и тащит
// versionKey сам по себе — это не Rating. Для проекций Rating/Review проверяем
// отдельно, точечно.
const FORBIDDEN_KEYS = ['ip', 'weight', 'vibeCreatedAt'];

function signAccessToken(userId) {
  return jwt.sign(
    { userId: String(userId), type: 'access' },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '15m', algorithm: 'HS256' }
  );
}

function scores(value = 8) {
  return {
    scenario: { plot: value, ideas: value, dialogue: value },
    characters: { depth: value, chemistry: value, functionality: value },
    visual: { composition: value, cinematography: value, pacing: value, tone: value },
    sound: { music: value, design: value, narrative: value },
    style: { originality: value, boldness: value }
  };
}

let userSeq = 0;
async function createUser(overrides = {}) {
  userSeq += 1;
  return User.create({
    email: `privacy${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `privacy${userSeq}`,
    ...overrides
  });
}

let filmSeq = 0;
async function createFilm(title = 'Фильм') {
  filmSeq += 1;
  return Film.create({ tmdbId: 800000 + filmSeq, title });
}

let ipSeq = 1;
async function call(endpoint, { method = 'GET', body, token, headers = {} } = {}) {
  const requestHeaders = {
    'x-forwarded-for': `198.51.100.${(ipSeq++ % 250) + 1}`,
    ...headers
  };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (token) requestHeaders.authorization = `Bearer ${token}`;

  const response = await fetch(baseUrl + endpoint, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json, text, headers: response.headers };
}

// Рекурсивно собираем все ключи JSON — утечка бывает не на верхнем уровне,
// а, например, внутри Review.ratingId.
function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

function assertClean(response, label, expectedStatus = 200) {
  assert.equal(response.status, expectedStatus, `${label}: ${response.status} ${response.text}`);
  const keys = collectKeys(response.json);
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(keys.has(forbidden), false, `${label}: ключ «${forbidden}» утёк наружу`);
  }
  // Даже если поле переименуют, значение IP не должно встречаться в теле.
  assert.equal(response.text.includes(IP_MARKER), false, `${label}: значение IP утекло наружу`);
}

before(async () => {
  dbPath = path.join(process.cwd(), '.mongo-test', `rating-privacy-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });

  mongod = await MongoMemoryServer.create({
    instance: { dbPath, launchTimeout: 180000 }
  });
  process.env.MONGODB_URI = mongod.getUri('cinephilium-test-rating-privacy');

  await mongoose.connect(process.env.MONGODB_URI);
  app = require('../src/app');

  ({ User, Film, Rating, Review, Event, Action } = {
    User: require('../src/models/User'),
    Film: require('../src/models/Film'),
    Rating: require('../src/models/Rating'),
    Review: require('../src/models/Review'),
    Event: require('../src/models/Event'),
    Action: require('../src/models/Action')
  });

  await Promise.all([
    User.init(), Film.init(), Rating.init(), Review.init(), Event.init(), Action.init()
  ]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all(
    [User, Film, Rating, Review, Event, Action].map(Model => Model.deleteMany({}))
  );
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) {
    try { await mongod.stop(); } catch { /* mongod на Windows иногда шумит при остановке */ }
  }
  try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * Готовит «худший случай»: полная оценка с реальным ip в БД и одобренная
 * рецензия, которая на неё ссылается. Возвращает всё, что нужно роутам.
 */
async function seed() {
  const author = await createUser();
  const film = await createFilm('Утечка IP');

  const rating = await Rating.create({
    userId: author._id,
    filmId: film._id,
    completeness: 'full',
    genrePreset: 'drama',
    blockWeights: { scenario: 0.3, characters: 0.2, visual: 0.2, sound: 0.15, style: 0.15 },
    scores: scores(8),
    vibe: 9,
    technicalScore: 80,
    combinedScore: 77,
    textReview: 'Текст оценки',
    weight: 1,
    ip: IP_MARKER
  });

  const review = await Review.create({
    userId: author._id,
    filmId: film._id,
    ratingId: rating._id,
    title: 'Рецензия',
    text: 'Достаточно длинный текст рецензии. '.repeat(15),
    status: 'approved'
  });

  return { author, film, rating, review, token: signAccessToken(author._id) };
}

test('C-1: ip/weight/vibeCreatedAt не утекают ни на одном публичном роуте', async () => {
  const { author, film, rating, review, token } = await seed();

  const responses = [
    ['GET /api/films/:id (аноним)', await call(`/api/films/${film._id}`)],
    ['GET /api/films/:id (userRating)', await call(`/api/films/${film._id}`, { token })],
    ['GET /api/ratings/:id/details (аноним)', await call(`/api/ratings/${rating._id}/details`)],
    ['GET /api/ratings/user (своя)', await call('/api/ratings/user', { token })],
    ['GET /api/films/:id/ratings', await call(`/api/films/${film._id}/ratings`)],
    ['GET /api/films/:id/users', await call(`/api/films/${film._id}/users`)],
    ['GET /api/reviews/:filmId', await call(`/api/reviews/${film._id}`)],
    ['GET /api/reviews/details/:id', await call(`/api/reviews/details/${review._id}`)],
    ['GET /api/reviews/user', await call('/api/reviews/user', { token })],
    ['GET /api/users/:id/reviews', await call(`/api/users/${author._id}/reviews`)],
    ['GET /api/users/:id/ratings', await call(`/api/users/${author._id}/ratings`)]
  ];

  for (const [label, response] of responses) assertClean(response, label);
});

test('C-1: публичные DTO сохраняют контракт фронта (детали, рецензии, userRating)', async () => {
  const { author, film, rating, review, token } = await seed();

  const details = await call(`/api/ratings/${rating._id}/details`);
  assert.equal(details.status, 200, details.text);
  // RatingDetailsModal читает именно эти поля.
  assert.equal(details.json._id, String(rating._id));
  assert.equal(details.json.userId.nickname, author.nickname);
  assert.equal(details.json.scores.scenario.plot, 8);
  assert.equal(details.json.blockWeights.scenario, 0.3);
  assert.equal(details.json.technicalScore, 80);
  assert.equal(details.json.combinedScore, 77);
  assert.equal(details.json.vibe, 9);
  assert.equal(details.json.completeness, 'full');
  assert.equal(details.json.filmId.title, film.title);
  assert.equal('__v' in details.json, false, 'деталям оценки не нужен versionKey');

  const filmDetail = await call(`/api/films/${film._id}`, { token });
  assert.equal(filmDetail.status, 200, filmDetail.text);
  assert.equal(String(filmDetail.json.userRating._id), String(rating._id));
  assert.equal(filmDetail.json.userRating.scores.visual.pacing, 8);
  assert.equal(filmDetail.json.userRating.completeness, 'full');

  const reviews = await call(`/api/reviews/${film._id}`);
  assert.equal(reviews.status, 200, reviews.text);
  assert.equal(reviews.json.length, 1);
  const embedded = reviews.json[0].ratingId;
  // Баллы нужны карточке рецензии, а служебные поля — нет.
  assert.equal(String(embedded._id), String(rating._id));
  assert.equal(embedded.combinedScore, 77);
  assert.equal(embedded.scores.style.boldness, 8);
  assert.equal('userId' in embedded, false, 'userId внутри ratingId не нужен');
  assert.equal('likes' in embedded, false, 'likes внутри ratingId не нужны');
  assert.equal('__v' in embedded, false, 'versionKey внутри ratingId не нужен');

  const tab = await call(`/api/users/${author._id}/reviews`);
  assert.equal(tab.status, 200, tab.text);
  assert.equal(String(tab.json.items[0].ratingId._id), String(review.ratingId));
  assert.equal('userId' in tab.json.items[0].ratingId, false);
});

test('C-1: ip пишется в БД, но скрыт проекцией (select: false)', async () => {
  const { rating } = await seed();

  const plain = await Rating.findById(rating._id).lean();
  assert.equal(plain.ip, undefined, 'ip не должен приходить без явного select');

  const audited = await Rating.findById(rating._id).select('+ip').lean();
  assert.equal(audited.ip, IP_MARKER, 'ip должен остаться в БД для антифрода');
});

test('C-1: ответы POST /api/ratings (vibe, повторный vibe, full) без служебных полей', async () => {
  const user = await createUser();
  const film = await createFilm('POST-оценки');
  const token = signAccessToken(user._id);

  const light = await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(film._id), vibe: 6 }
  });
  assertClean(light, 'POST /api/ratings (vibe)', 201);
  assert.equal(light.json.rating.vibe, 6);
  assert.equal(light.json.rating.scores, null);
  assert.equal(light.json.rating.blockWeights, null);
  assert.equal(light.json.rating.genrePreset, null);

  const repeat = await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(film._id), vibe: 7 }
  });
  assertClean(repeat, 'POST /api/ratings (повторный vibe)', 201);
  assert.equal(repeat.json.rating.vibe, 7);

  const full = await call('/api/ratings', {
    method: 'POST',
    token,
    body: { filmId: String(film._id), scores: scores(9), vibe: 9, genrePreset: 'drama' }
  });
  assertClean(full, 'POST /api/ratings (full)', 201);
  assert.equal(full.json.rating.completeness, 'full');
  assert.equal(full.json.rating.scores.scenario.plot, 9);
});

test('C-1: POST /api/reviews отдаёт урезанный ratingId без ip и weight', async () => {
  // Отдельный автор: у оценщика из seed() уже есть рецензия на этот фильм.
  const user = await createUser();
  const film = await createFilm('Публикация рецензии');
  const token = signAccessToken(user._id);

  const rated = await call('/api/ratings', {
    method: 'POST',
    token,
    body: { filmId: String(film._id), scores: scores(8), vibe: 8 }
  });
  assert.equal(rated.status, 201, rated.text);

  const created = await call('/api/reviews', {
    method: 'POST',
    token,
    body: {
      filmId: String(film._id),
      title: 'Новая рецензия',
      text: 'Ещё один достаточно длинный текст рецензии. '.repeat(15)
    }
  });
  assert.equal(created.status, 200, created.text);

  const keys = collectKeys(created.json);
  assert.equal(keys.has('ip'), false, 'POST /api/reviews: ip утёк');
  assert.equal(keys.has('weight'), false, 'POST /api/reviews: weight утёк');
  assert.equal(keys.has('__v'), false, 'POST /api/reviews: versionKey утёк');
  assert.equal(created.json.ratingId.combinedScore, rated.json.rating.combinedScore);
});
