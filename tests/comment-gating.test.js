// Тесты B3: гейтинг комментариев — писать может только тот, кто оценил фильм.
// Запуск: node --test tests/comment-gating.test.js
// База — in-memory MongoDB, внешний mongod не нужен.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'gating-test-access';
process.env.JWT_REFRESH_SECRET = 'gating-test-refresh';
process.env.TMDB_API_KEY = 'gating-test-tmdb';
process.env.ADMIN_SECRET_KEY = 'gating-test-admin';
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
let Comment;

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
    email: `gate${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `gate${userSeq}`,
    ...overrides
  });
}

let filmSeq = 0;
async function createFilm(title = 'Фильм') {
  filmSeq += 1;
  return Film.create({ tmdbId: 700000 + filmSeq, title });
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

let ipSeq = 1;
async function call(endpoint, { method = 'GET', body, token, headers = {} } = {}) {
  const requestHeaders = {
    'x-forwarded-for': `192.0.2.${(ipSeq++ % 250) + 1}`,
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
  dbPath = path.join(process.cwd(), '.mongo-test', `gating-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });

  mongod = await MongoMemoryServer.create({
    instance: { dbPath, launchTimeout: 180000 }
  });
  process.env.MONGODB_URI = mongod.getUri('cinephilium-test-gating');

  await mongoose.connect(process.env.MONGODB_URI);
  const app = require('../src/app');

  User = require('../src/models/User');
  Film = require('../src/models/Film');
  Rating = require('../src/models/Rating');
  Comment = require('../src/models/Comment');

  await Promise.all([User.init(), Film.init(), Rating.init(), Comment.init()]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User, Film, Rating, Comment].map(Model => Model.deleteMany({})));
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) {
    try { await mongod.stop(); } catch { /* mongod на Windows иногда шумит при остановке */ }
  }
  try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────── БЕЗ ОЦЕНКИ — НЕЛЬЗЯ ───────────────────────────

test('без оценки фильма комментарий отклоняется и ничего не создаётся', async () => {
  const user = await createUser();
  const film = await createFilm('Без оценки');
  const token = signAccessToken(user._id);

  const { status, json } = await call('/api/comments', {
    method: 'POST', token,
    body: { filmId: String(film._id), text: 'Мнение без оценки' }
  });

  assert.equal(status, 403);
  assert.equal(json.error.code, 'RATING_REQUIRED_FOR_COMMENT');
  assert.match(json.error.message, /оцени/i);

  assert.equal(await Comment.countDocuments({}), 0, 'комментарий создан вопреки гейту');
  const fresh = await User.findById(user._id).select('counters');
  assert.equal(fresh.counters.comments || 0, 0, 'счётчик вырос без комментария');
});

test('ответ на чужой комментарий без своей оценки отклоняется', async () => {
  const author = await createUser();
  const responder = await createUser();
  const film = await createFilm('Чужой тред');
  const parent = await Comment.create({
    userId: author._id, filmId: film._id, text: 'Родитель', status: 'approved'
  });

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(responder._id),
    body: { filmId: String(film._id), text: 'Ответ', parentId: String(parent._id) }
  });

  assert.equal(status, 403);
  assert.equal(json.error.code, 'RATING_REQUIRED_FOR_COMMENT');
  assert.equal(await Comment.countDocuments({ parentId: parent._id }), 0);
});

test('ответ на свой комментарий без оценки тоже отклоняется — правило единое', async () => {
  const user = await createUser();
  const film = await createFilm('Свой тред');
  // Комментарий создан напрямую, как «legacy»: оценка не появлялась.
  const own = await Comment.create({
    userId: user._id, filmId: film._id, text: 'Мой', status: 'approved'
  });

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id), text: 'Ответ себе', parentId: String(own._id) }
  });

  assert.equal(status, 403, 'свой комментарий дал исключение');
  assert.equal(json.error.code, 'RATING_REQUIRED_FOR_COMMENT');
});

test('админ без оценки получает тот же 403 — исключения по роли нет', async () => {
  const admin = await createUser({ isAdmin: true });
  const film = await createFilm('Админ без оценки');

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(admin._id),
    body: { filmId: String(film._id), text: 'Служебный ответ' }
  });

  assert.equal(status, 403);
  assert.equal(json.error.code, 'RATING_REQUIRED_FOR_COMMENT');
});

// ─────────────────────────── С ОЦЕНКОЙ — МОЖНО ───────────────────────────

test('vibe-оценка открывает комментарии: создаётся pending, счётчик растёт', async () => {
  const user = await createUser();
  const film = await createFilm('Вайб');
  await createRating({ userId: user._id, filmId: film._id, completeness: 'vibe' });

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id), text: 'Одна цифра тоже мнение' }
  });

  assert.equal(status, 200);
  assert.equal(json.status, 'pending');
  assert.equal(String(json.filmId), String(film._id));

  const fresh = await User.findById(user._id).select('counters');
  assert.equal(fresh.counters.comments, 1);
});

test('полная оценка открывает комментарии', async () => {
  const user = await createUser();
  const film = await createFilm('Полная');
  await createRating({ userId: user._id, filmId: film._id });

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id), text: 'Разобрал и говорю' }
  });

  assert.equal(status, 200);
  assert.equal(json.status, 'pending');
});

test('оценка с weight: 0 всё равно считается входом в обсуждение', async () => {
  // DECISION B3/2A: гейтинг про «смотрел ли», а не про доверие к голосу.
  const user = await createUser();
  const film = await createFilm('Помеченный');
  await createRating({ userId: user._id, filmId: film._id, weight: 0 });

  const { status } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id), text: 'Оценка есть' }
  });

  assert.equal(status, 200);
});

test('ответ на чужой комментарий по оценённому фильму проходит', async () => {
  const author = await createUser();
  const responder = await createUser();
  const film = await createFilm('Ответ');
  await createRating({ userId: responder._id, filmId: film._id, completeness: 'vibe' });
  const parent = await Comment.create({
    userId: author._id, filmId: film._id, text: 'Родитель', status: 'approved'
  });

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(responder._id),
    body: { filmId: String(film._id), text: 'Ответ', parentId: String(parent._id) }
  });

  assert.equal(status, 200);
  assert.equal(json.status, 'pending');
});

// ─────────────────────────── ЧТО НЕ ГЕЙТИТСЯ ───────────────────────────

test('лайк комментария не гейтится: можно без оценки', async () => {
  const author = await createUser();
  const liker = await createUser();
  const film = await createFilm('Лайки');
  const comment = await Comment.create({
    userId: author._id, filmId: film._id, text: 'Хороший текст', status: 'approved'
  });

  const { status, json } = await call(`/api/comments/${comment._id}/like`, {
    method: 'POST', token: signAccessToken(liker._id)
  });

  assert.equal(status, 200);
  assert.equal(json.liked, true);
  assert.equal(json.likes, 1);
});

test('legacy-комментарий без оценки остаётся видимым', async () => {
  // DECISION B3/1A: написанное до гейтинга не скрываем и не помечаем.
  const legacyAuthor = await createUser();
  const film = await createFilm('История');
  const legacy = await Comment.create({
    userId: legacyAuthor._id, filmId: film._id, text: 'Написано до B3', status: 'approved'
  });

  const { status, json } = await call(`/api/comments/${film._id}`);

  assert.equal(status, 200);
  assert.equal(json.length, 1);
  assert.equal(String(json[0]._id), String(legacy._id));
  assert.equal(json[0].status, 'approved');
});

// ─────────────────────────── ПОРЯДОК ПРОВЕРОК ───────────────────────────

test('403 побеждает 400: без оценки длинный текст не валидируется', async () => {
  const user = await createUser();
  const film = await createFilm('Длинный');
  const token = signAccessToken(user._id);

  const rejected = await call('/api/comments', {
    method: 'POST', token,
    body: { filmId: String(film._id), text: 'x'.repeat(1001) }
  });
  assert.equal(rejected.status, 403, 'валидация ответила раньше гейта');
  assert.equal(rejected.json.error.code, 'RATING_REQUIRED_FOR_COMMENT');

  await createRating({ userId: user._id, filmId: film._id });
  const withRating = await call('/api/comments', {
    method: 'POST', token,
    body: { filmId: String(film._id), text: 'x'.repeat(1001) }
  });
  assert.equal(withRating.status, 400);
  assert.equal(withRating.json.error.code, 'VALIDATION_ERROR');
});

test('кривой filmId не подменяется гейтом: это 400, а не 403', async () => {
  const user = await createUser();
  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: 'not-an-object-id', text: 'Текст' }
  });

  assert.equal(status, 400);
  assert.equal(json.error.code, 'VALIDATION_ERROR');
});

test('валидный, но несуществующий фильм: без оценки 403, с оценкой 404', async () => {
  const user = await createUser();
  const filmId = new mongoose.Types.ObjectId();
  const token = signAccessToken(user._id);

  const withoutRating = await call('/api/comments', {
    method: 'POST', token, body: { filmId: String(filmId), text: 'Текст' }
  });
  assert.equal(withoutRating.status, 403);

  // Оценка существует (фильм могли удалить позже) — тогда честный 404.
  await Rating.create({
    userId: user._id, filmId, completeness: 'vibe', vibe: 5,
    technicalScore: 0, combinedScore: 0
  });
  const withRating = await call('/api/comments', {
    method: 'POST', token, body: { filmId: String(filmId), text: 'Текст' }
  });
  assert.equal(withRating.status, 404);
});

// ─────────────────────────── ФРОНТ И ГОНКА ───────────────────────────

test('userRating в ответе фильма согласован с гейтом', async () => {
  // DECISION B3/4A: отдельного can-post нет, фронт смотрит на userRating.
  const user = await createUser();
  const film = await createFilm('Согласованность');
  const token = signAccessToken(user._id);

  const before = await call(`/api/films/${film._id}`, { token });
  assert.equal(before.json.userRating, null);

  const blocked = await call('/api/comments', {
    method: 'POST', token, body: { filmId: String(film._id), text: 'Текст' }
  });
  assert.equal(blocked.status, 403);

  await createRating({ userId: user._id, filmId: film._id, completeness: 'vibe' });

  const after = await call(`/api/films/${film._id}`, { token });
  assert.ok(after.json.userRating, 'userRating не появился после оценки');
  assert.equal(String(after.json.userRating.filmId), String(film._id));

  const allowed = await call('/api/comments', {
    method: 'POST', token, body: { filmId: String(film._id), text: 'Текст' }
  });
  assert.equal(allowed.status, 200);
});

test('гонка «vibe и комментарий одновременно»: бэк не ждёт, вторая попытка проходит', async () => {
  // DECISION B3/5A: последовательность запросов — задача фронта. Бэк отвечает
  // на момент запроса; после появления оценки тот же запрос проходит.
  const user = await createUser();
  const film = await createFilm('Гонка');
  const token = signAccessToken(user._id);
  const body = { filmId: String(film._id), text: 'Пришло раньше оценки' };

  const first = await call('/api/comments', { method: 'POST', token, body });
  assert.equal(first.status, 403);

  await createRating({ userId: user._id, filmId: film._id, completeness: 'vibe' });

  const second = await call('/api/comments', { method: 'POST', token, body });
  assert.equal(second.status, 200, 'повтор после оценки должен проходить без ожиданий');
  assert.equal(await Comment.countDocuments({ userId: user._id }), 1);
});
