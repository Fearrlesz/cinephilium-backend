// Тесты B4: гейтинг рецензий (нужна full-оценка), серверный ratingId, isSpoiler.
// Запуск: node --test tests/review-gating.test.js
// База — in-memory MongoDB, внешний mongod не нужен.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'reviews-test-access';
process.env.JWT_REFRESH_SECRET = 'reviews-test-refresh';
process.env.TMDB_API_KEY = 'reviews-test-tmdb';
process.env.ADMIN_SECRET_KEY = 'reviews-test-admin';
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
let dbPath;
let User;
let Film;
let Rating;
let Review;

function signAccessToken(userId) {
  return jwt.sign(
    { userId: String(userId), type: 'access' },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '15m', algorithm: 'HS256' }
  );
}

function fullScores(value = 8) {
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
    email: `rev${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `rev${userSeq}`,
    ...overrides
  });
}

let filmSeq = 0;
async function createFilm(title = 'Фильм') {
  filmSeq += 1;
  return Film.create({ tmdbId: 600000 + filmSeq, title });
}

async function createRating({
  userId,
  filmId,
  completeness = 'full',
  vibe = 7,
  technicalScore = 60,
  combinedScore = 60,
  weight = 1
}) {
  const isFull = completeness === 'full';
  return Rating.create({
    userId,
    filmId,
    completeness,
    vibe,
    technicalScore: isFull ? technicalScore : 0,
    combinedScore: isFull ? combinedScore : 0,
    weight,
    ...(isFull ? { scores: fullScores(8) } : {})
  });
}

function reviewBody(filmId, overrides = {}) {
  return {
    filmId: String(filmId),
    title: 'Заголовок',
    text: 'x'.repeat(350),
    ...overrides
  };
}

let ipSeq = 1;
async function call(endpoint, { method = 'GET', body, token, headers = {} } = {}) {
  const requestHeaders = {
    'x-forwarded-for': `203.0.113.${(ipSeq++ % 250) + 1}`,
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
  return { status: response.status, json, text };
}

before(async () => {
  dbPath = path.join(process.cwd(), '.mongo-test', `reviews-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });

  mongod = await MongoMemoryServer.create({
    instance: { dbPath, launchTimeout: 180000 }
  });
  process.env.MONGODB_URI = mongod.getUri('cinephilium-test-reviews');

  await mongoose.connect(process.env.MONGODB_URI);
  const app = require('../src/app');

  User = require('../src/models/User');
  Film = require('../src/models/Film');
  Rating = require('../src/models/Rating');
  Review = require('../src/models/Review');

  await Promise.all([User.init(), Film.init(), Rating.init(), Review.init()]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User, Film, Rating, Review].map(Model => Model.deleteMany({})));
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) {
    try { await mongod.stop(); } catch { /* mongod на Windows иногда шумит при остановке */ }
  }
  try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────── ГЕЙТИНГ ───────────────────────────

test('без оценки рецензия отклоняется и ничего не создаётся', async () => {
  const user = await createUser();
  const film = await createFilm('Без оценки');

  const { status, json } = await call('/api/reviews', {
    method: 'POST', token: signAccessToken(user._id), body: reviewBody(film._id)
  });

  assert.equal(status, 403);
  assert.equal(json.error.code, 'FULL_RATING_REQUIRED_FOR_REVIEW');
  assert.match(json.error.message, /полной оценк/i);
  assert.equal(await Review.countDocuments({}), 0);
});

test('только vibe-оценка рецензию не открывает', async () => {
  const user = await createUser();
  const film = await createFilm('Только вайб');
  await createRating({ userId: user._id, filmId: film._id, completeness: 'vibe' });

  const { status, json } = await call('/api/reviews', {
    method: 'POST', token: signAccessToken(user._id), body: reviewBody(film._id)
  });

  assert.equal(status, 403);
  assert.equal(json.error.code, 'FULL_RATING_REQUIRED_FOR_REVIEW');
  assert.equal(await Review.countDocuments({}), 0);
});

test('полная оценка открывает рецензию: pending, ratingId подставлен сервером', async () => {
  const user = await createUser();
  const film = await createFilm('Полная');
  const rating = await createRating({ userId: user._id, filmId: film._id });

  const { status, json } = await call('/api/reviews', {
    method: 'POST', token: signAccessToken(user._id), body: reviewBody(film._id)
  });

  assert.equal(status, 200);
  assert.equal(json.status, 'pending');
  assert.equal(String(json.ratingId?._id || json.ratingId), String(rating._id));

  const stored = await Review.findOne({ userId: user._id });
  assert.equal(String(stored.ratingId), String(rating._id));
  const fresh = await User.findById(user._id).select('counters');
  assert.equal(fresh.counters.reviews, 1);
});

test('админ без полной оценки получает тот же 403', async () => {
  const admin = await createUser({ isAdmin: true });
  const film = await createFilm('Админ');

  const { status, json } = await call('/api/reviews', {
    method: 'POST', token: signAccessToken(admin._id), body: reviewBody(film._id)
  });

  assert.equal(status, 403);
  assert.equal(json.error.code, 'FULL_RATING_REQUIRED_FOR_REVIEW');
});

test('оценка с weight: 0 тоже открывает рецензию', async () => {
  // Наследует B3/2A: гейтинг про «разбирал ли», weight — про агрегаты.
  const user = await createUser();
  const film = await createFilm('Помеченный');
  await createRating({ userId: user._id, filmId: film._id, weight: 0 });

  const { status } = await call('/api/reviews', {
    method: 'POST', token: signAccessToken(user._id), body: reviewBody(film._id)
  });

  assert.equal(status, 200);
});

test('403 побеждает 400: без full-оценки короткий текст не валидируется', async () => {
  const user = await createUser();
  const film = await createFilm('Короткий');
  await createRating({ userId: user._id, filmId: film._id, completeness: 'vibe' });
  const token = signAccessToken(user._id);

  const rejected = await call('/api/reviews', {
    method: 'POST', token, body: reviewBody(film._id, { text: 'коротко' })
  });
  assert.equal(rejected.status, 403, 'валидация ответила раньше гейта');

  await Rating.updateOne(
    { userId: user._id, filmId: film._id },
    { $set: { completeness: 'full', technicalScore: 60, combinedScore: 60, scores: fullScores(8) } }
  );
  const validated = await call('/api/reviews', {
    method: 'POST', token, body: reviewBody(film._id, { text: 'коротко' })
  });
  assert.equal(validated.status, 400);
  assert.equal(validated.json.error.code, 'VALIDATION_ERROR');
});

test('апгрейд vibe → full открывает рецензию без перелогина', async () => {
  const user = await createUser();
  const film = await createFilm('Апгрейд');
  const token = signAccessToken(user._id);

  await createRating({ userId: user._id, filmId: film._id, completeness: 'vibe' });
  const before = await call('/api/reviews', { method: 'POST', token, body: reviewBody(film._id) });
  assert.equal(before.status, 403);

  await Rating.updateOne(
    { userId: user._id, filmId: film._id },
    { $set: { completeness: 'full', technicalScore: 70, combinedScore: 70, scores: fullScores(8) } }
  );
  const after = await call('/api/reviews', { method: 'POST', token, body: reviewBody(film._id) });
  assert.equal(after.status, 200, 'full-оценка должна открывать рецензию');
});

// ─────────────────────────── ratingId ───────────────────────────

test('ratingId из тела игнорируется: сервер берёт свою оценку', async () => {
  // DECISION B4/1A: старый фронт присылает ratingId, но он ни на что не влияет.
  const user = await createUser();
  const other = await createUser();
  const film = await createFilm('Игнор');
  const own = await createRating({ userId: user._id, filmId: film._id });
  const foreign = await createRating({ userId: other._id, filmId: film._id });

  const { status } = await call('/api/reviews', {
    method: 'POST', token: signAccessToken(user._id),
    body: reviewBody(film._id, { ratingId: String(foreign._id) })
  });

  assert.equal(status, 200, 'чужой ratingId в теле не должен ломать запрос');
  const stored = await Review.findOne({ userId: user._id });
  assert.equal(String(stored.ratingId), String(own._id), 'привязалось не к своей оценке');
});

test('без ratingId в теле рецензия создаётся', async () => {
  const user = await createUser();
  const film = await createFilm('Без id');
  await createRating({ userId: user._id, filmId: film._id });

  const { status } = await call('/api/reviews', {
    method: 'POST', token: signAccessToken(user._id), body: reviewBody(film._id)
  });

  assert.equal(status, 200);
});

// ─────────────────────────── ДЛИНА ───────────────────────────

test('минимум остаётся 350 символов: 349 отклоняется, 350 принимается', async () => {
  const user = await createUser();
  const film = await createFilm('Длина');
  await createRating({ userId: user._id, filmId: film._id });
  const token = signAccessToken(user._id);

  const short = await call('/api/reviews', {
    method: 'POST', token, body: reviewBody(film._id, { text: 'x'.repeat(349) })
  });
  assert.equal(short.status, 400);
  assert.equal(short.json.error.code, 'VALIDATION_ERROR');
  assert.equal(await Review.countDocuments({}), 0);

  const exact = await call('/api/reviews', {
    method: 'POST', token, body: reviewBody(film._id, { text: 'x'.repeat(350) })
  });
  assert.equal(exact.status, 200);
});

test('максимум 15000: 15000 принимается, 15001 отклоняется', async () => {
  const user = await createUser();
  const film = await createFilm('Максимум');
  await createRating({ userId: user._id, filmId: film._id });
  const token = signAccessToken(user._id);

  const tooLong = await call('/api/reviews', {
    method: 'POST', token, body: reviewBody(film._id, { text: 'x'.repeat(15001) })
  });
  assert.equal(tooLong.status, 400);

  const exact = await call('/api/reviews', {
    method: 'POST', token, body: reviewBody(film._id, { text: 'x'.repeat(15000) })
  });
  assert.equal(exact.status, 200);
  const stored = await Review.findOne({ userId: user._id });
  assert.equal(stored.text.length, 15000);
});

// ─────────────────────────── СПОЙЛЕР ───────────────────────────

test('isSpoiler: true сохраняется и отдаётся во всех выдачах рецензии', async () => {
  const user = await createUser();
  const film = await createFilm('Спойлер');
  await createRating({ userId: user._id, filmId: film._id });
  const token = signAccessToken(user._id);

  const created = await call('/api/reviews', {
    method: 'POST', token, body: reviewBody(film._id, { isSpoiler: true })
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.isSpoiler, true);

  const reviewId = created.json._id;

  const byFilm = await call(`/api/reviews/${film._id}`, { token });
  assert.equal(byFilm.json[0].isSpoiler, true);

  const details = await call(`/api/reviews/details/${reviewId}`, { token });
  assert.equal(details.json.isSpoiler, true);

  const mine = await call('/api/reviews/user', { token });
  assert.equal(mine.json[0].isSpoiler, true);

  const profile = await call(`/api/users/${user._id}`, { token });
  assert.equal(profile.json.reviews[0].isSpoiler, true, 'профиль потерял флаг');

  const stored = await Review.findById(reviewId);
  assert.equal(stored.isSpoiler, true);
});

test('без isSpoiler сохраняется false', async () => {
  const user = await createUser();
  const film = await createFilm('Без флага');
  await createRating({ userId: user._id, filmId: film._id });

  const { json } = await call('/api/reviews', {
    method: 'POST', token: signAccessToken(user._id), body: reviewBody(film._id)
  });

  assert.equal(json.isSpoiler, false);
  const stored = await Review.findById(json._id);
  assert.equal(stored.isSpoiler, false);
});

test('старая рецензия без поля читается как false', async () => {
  // Миграция не нужна: схема дочитывает default при гидрации.
  const user = await createUser();
  const film = await createFilm('Старая');
  const rating = await createRating({ userId: user._id, filmId: film._id });
  const legacy = await Review.create({
    userId: user._id, filmId: film._id, ratingId: rating._id,
    title: 'Старая', text: 'x'.repeat(400), status: 'approved'
  });
  // Имитируем документ, созданный до B4: поля в базе нет.
  await Review.collection.updateOne({ _id: legacy._id }, { $unset: { isSpoiler: '' } });

  const { status, json } = await call(`/api/reviews/${film._id}`);
  assert.equal(status, 200);
  assert.equal(json[0].isSpoiler, false);
});

test('в админ-очереди спойлер отдаётся полным текстом', async () => {
  // DECISION B4/5: модератор обязан видеть текст целиком.
  const admin = await createUser({ isAdmin: true });
  const author = await createUser();
  const film = await createFilm('Очередь');
  const rating = await createRating({ userId: author._id, filmId: film._id });
  const text = `секрет: ${'x'.repeat(400)}`;
  const review = await Review.create({
    userId: author._id, filmId: film._id, ratingId: rating._id,
    title: 'Спойлер', text, isSpoiler: true, status: 'pending'
  });

  const { status, json } = await call('/api/admin/pending/reviews', {
    token: signAccessToken(admin._id)
  });

  assert.equal(status, 200);
  const pending = json.find(item => String(item._id) === String(review._id));
  assert.ok(pending, 'рецензия не попала в очередь');
  assert.equal(pending.isSpoiler, true);
  assert.equal(pending.text, text, 'модератору показали обрезанный текст');
});
