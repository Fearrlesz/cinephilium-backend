// Тесты B5: дневник просмотров (Watch).
// Запуск: node --test tests/watch-diary.test.js
// База — in-memory MongoDB, внешний mongod не нужен.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'watch-test-access';
process.env.JWT_REFRESH_SECRET = 'watch-test-refresh';
process.env.TMDB_API_KEY = 'watch-test-tmdb';
process.env.ADMIN_SECRET_KEY = 'watch-test-admin';
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
let Watch;
let Event;
let migrateB5;

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
    email: `watch${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `watch${userSeq}`,
    ...overrides
  });
}

let filmSeq = 0;
async function createFilm(title = 'Фильм') {
  filmSeq += 1;
  return Film.create({ tmdbId: 500000 + filmSeq, title });
}

async function createRating({ userId, filmId, completeness = 'full', vibe = 7 }) {
  const isFull = completeness === 'full';
  return Rating.create({
    userId, filmId, completeness, vibe,
    technicalScore: isFull ? 60 : 0,
    combinedScore: isFull ? 60 : 0,
    ...(isFull ? { scores: fullScores(8) } : {})
  });
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

let ipSeq = 1;
async function call(endpoint, { method = 'GET', body, token, headers = {} } = {}) {
  const requestHeaders = {
    'x-forwarded-for': `198.18.0.${(ipSeq++ % 250) + 1}`,
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
  dbPath = path.join(process.cwd(), '.mongo-test', `watch-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });

  mongod = await MongoMemoryServer.create({
    instance: { dbPath, launchTimeout: 180000 }
  });
  process.env.MONGODB_URI = mongod.getUri('cinephilium-test-watch');

  await mongoose.connect(process.env.MONGODB_URI);
  const app = require('../src/app');

  User = require('../src/models/User');
  Film = require('../src/models/Film');
  Rating = require('../src/models/Rating');
  Review = require('../src/models/Review');
  Watch = require('../src/models/Watch');
  Event = require('../src/models/Event');
  migrateB5 = require('../scripts/migrate-b5-watches').migrate;

  await Promise.all([User.init(), Film.init(), Rating.init(), Review.init(), Watch.init(), Event.init()]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User, Film, Rating, Review, Watch, Event].map(Model => Model.deleteMany({})));
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) {
    try { await mongod.stop(); } catch { /* mongod на Windows иногда шумит при остановке */ }
  }
  try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────── СОЗДАНИЕ И СЧЁТЧИК ───────────────────────────

test('запись создаётся без оценки и без гейтинга', async () => {
  const user = await createUser();
  const film = await createFilm('Без оценки');

  const { status, json } = await call('/api/watches', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id) }
  });

  assert.equal(status, 201);
  assert.equal(String(json.filmId), String(film._id));
  assert.equal(json.isRewatch, false);
  assert.deepEqual(json.tags, []);

  const fresh = await User.findById(user._id).select('counters');
  assert.equal(fresh.counters.watches, 1);
});

test('несколько записей одного фильма — это пересмотры, а не дубликаты', async () => {
  const user = await createUser();
  const film = await createFilm('Пересмотр');
  const token = signAccessToken(user._id);

  await call('/api/watches', { method: 'POST', token, body: { filmId: String(film._id) } });
  await call('/api/watches', {
    method: 'POST', token,
    body: { filmId: String(film._id), isRewatch: true, watchedAt: daysAgo(10) }
  });

  assert.equal(await Watch.countDocuments({ filmId: film._id }), 2);
  const fresh = await User.findById(user._id).select('counters');
  assert.equal(fresh.counters.watches, 2);
});

test('дата в прошлом — норма, сохраняется как есть', async () => {
  const user = await createUser();
  const film = await createFilm('Прошлое');
  const watchedAt = daysAgo(30);

  const { status, json } = await call('/api/watches', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id), watchedAt: watchedAt.toISOString() }
  });

  assert.equal(status, 201);
  assert.equal(new Date(json.watchedAt).toISOString(), watchedAt.toISOString());
});

test('дата в будущем отклоняется', async () => {
  const user = await createUser();
  const film = await createFilm('Будущее');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const { status, json } = await call('/api/watches', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id), watchedAt: tomorrow.toISOString() }
  });

  assert.equal(status, 400);
  assert.equal(json.error.code, 'VALIDATION_ERROR');
  assert.equal(await Watch.countDocuments({}), 0);
});

test('некорректная дата отклоняется', async () => {
  const user = await createUser();
  const film = await createFilm('Мусор');

  const { status } = await call('/api/watches', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id), watchedAt: 'не дата' }
  });

  assert.equal(status, 400);
});

test('событие в ленту не создаётся', async () => {
  // DECISION B5/5: дневник — память, а не сигнал.
  const user = await createUser();
  const film = await createFilm('Тишина');

  await call('/api/watches', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id) }
  });

  assert.equal(await Event.countDocuments({}), 0);
});

// ─────────────────────────── ТЕГИ И ПЕРЕСМОТР ───────────────────────────

test('теги нормализуются: trim, дубли без учёта регистра, пустые выброшены', async () => {
  const user = await createUser();
  const film = await createFilm('Теги');

  const { status, json } = await call('/api/watches', {
    method: 'POST', token: signAccessToken(user._id),
    body: {
      filmId: String(film._id),
      tags: ['  в кино ', 'В КИНО', '', '   ', 'с друзьями']
    }
  });

  assert.equal(status, 201);
  assert.deepEqual(json.tags, ['в кино', 'с друзьями']);
});

test('лимиты тегов: длинный тег и больше 10 уникальных — 400', async () => {
  const user = await createUser();
  const film = await createFilm('Лимиты');
  const token = signAccessToken(user._id);

  const long = await call('/api/watches', {
    method: 'POST', token,
    body: { filmId: String(film._id), tags: ['x'.repeat(31)] }
  });
  assert.equal(long.status, 400);

  const many = await call('/api/watches', {
    method: 'POST', token,
    body: { filmId: String(film._id), tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) }
  });
  assert.equal(many.status, 400);

  const notArray = await call('/api/watches', {
    method: 'POST', token,
    body: { filmId: String(film._id), tags: 'в кино' }
  });
  assert.equal(notArray.status, 400);

  assert.equal(await Watch.countDocuments({}), 0);
});

test('isRewatch остаётся ручным: новая запись не переключает флаг предыдущей', async () => {
  const user = await createUser();
  const film = await createFilm('Флаг');
  const token = signAccessToken(user._id);

  await call('/api/watches', { method: 'POST', token, body: { filmId: String(film._id) } });
  await call('/api/watches', {
    method: 'POST', token,
    body: { filmId: String(film._id), isRewatch: true, watchedAt: daysAgo(5) }
  });

  const all = await Watch.find({ userId: user._id }).sort({ watchedAt: 1 });
  assert.equal(all[0].isRewatch, true, 'первая запись не должна была измениться');
  assert.equal(all[1].isRewatch, false);
});

// ─────────────────────────── УДАЛЕНИЕ ───────────────────────────

test('удаление своей записи уменьшает счётчик', async () => {
  const user = await createUser();
  const film = await createFilm('Удаление');
  const token = signAccessToken(user._id);

  const created = await call('/api/watches', {
    method: 'POST', token, body: { filmId: String(film._id) }
  });
  const before = await User.findById(user._id).select('counters');
  assert.equal(before.counters.watches, 1);

  const removed = await call(`/api/watches/${created.json._id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);

  const afterDelete = await User.findById(user._id).select('counters');
  assert.equal(afterDelete.counters.watches, 0);
  assert.equal(await Watch.countDocuments({}), 0);
});

test('чужую запись удалить нельзя: 404 и счётчик владельца цел', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const film = await createFilm('Чужая');
  const watch = await Watch.create({ userId: owner._id, filmId: film._id, watchedAt: new Date() });
  await User.updateOne({ _id: owner._id }, { $set: { 'counters.watches': 1 } });

  const removed = await call(`/api/watches/${watch._id}`, {
    method: 'DELETE', token: signAccessToken(stranger._id)
  });

  assert.equal(removed.status, 404);
  assert.equal(await Watch.countDocuments({}), 1);
  const ownerAfter = await User.findById(owner._id).select('counters');
  assert.equal(ownerAfter.counters.watches, 1);
});

test('удаление записи не трогает связанную оценку', async () => {
  const user = await createUser();
  const film = await createFilm('Связь');
  const token = signAccessToken(user._id);

  const watch = await call('/api/watches', {
    method: 'POST', token, body: { filmId: String(film._id) }
  });
  await call('/api/ratings', {
    method: 'POST', token,
    body: { filmId: String(film._id), vibe: 8, watchId: watch.json._id }
  });
  assert.equal(await Rating.countDocuments({ userId: user._id }), 1);

  await call(`/api/watches/${watch.json._id}`, { method: 'DELETE', token });
  assert.equal(await Rating.countDocuments({ userId: user._id }), 1, 'оценка удалилась вместе с записью');
});

// ─────────────────────────── ЧТЕНИЕ ───────────────────────────

test('свой дневник отдаётся с пагинацией и сортировкой по дате', async () => {
  const user = await createUser();
  const filmA = await createFilm('A');
  const filmB = await createFilm('B');
  await Watch.create({ userId: user._id, filmId: filmA._id, watchedAt: daysAgo(10) });
  await Watch.create({ userId: user._id, filmId: filmB._id, watchedAt: daysAgo(1) });

  const { status, json } = await call('/api/watches/me?page=1&limit=1', {
    token: signAccessToken(user._id)
  });

  assert.equal(status, 200);
  assert.equal(json.items.length, 1);
  assert.equal(json.pagination.total, 2);
  assert.equal(json.pagination.pages, 2);
  assert.equal(String(json.items[0].filmId._id), String(filmB._id), 'сортировка не по дате просмотра');
  assert.ok(json.items[0].filmId.posterUrl !== undefined);
});

test('публичный дневник виден анониму', async () => {
  const user = await createUser();
  const film = await createFilm('Публичный');
  await Watch.create({ userId: user._id, filmId: film._id, watchedAt: new Date(), tags: ['в кино'] });

  const { status, json } = await call(`/api/watches/user/${user._id}`);

  assert.equal(status, 200);
  assert.equal(json.items.length, 1);
  assert.deepEqual(json.items[0].tags, ['в кино']);
  assert.equal(json.private, false);
});

test('закрытый дневник: 403 для чужих, но виден владельцу и админу', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const admin = await createUser({ isAdmin: true });
  const film = await createFilm('Закрытый');
  await Watch.create({ userId: owner._id, filmId: film._id, watchedAt: new Date() });
  await User.updateOne({ _id: owner._id }, { $set: { diaryPrivate: true } });

  const foreign = await call(`/api/watches/user/${owner._id}`, {
    token: signAccessToken(stranger._id)
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.json.error.code, 'DIARY_PRIVATE');

  const anonymous = await call(`/api/watches/user/${owner._id}`);
  assert.equal(anonymous.status, 403);

  const own = await call(`/api/watches/user/${owner._id}`, {
    token: signAccessToken(owner._id)
  });
  assert.equal(own.status, 200);

  const asAdmin = await call(`/api/watches/user/${owner._id}`, {
    token: signAccessToken(admin._id)
  });
  assert.equal(asAdmin.status, 200);
});

test('настройка приватности переключается и видна в профиле', async () => {
  const user = await createUser();
  const token = signAccessToken(user._id);

  const closed = await call('/api/watches/settings', {
    method: 'PATCH', token, body: { private: true }
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.private, true);

  const profile = await call(`/api/users/${user._id}`, { token });
  assert.equal(profile.json.user.diaryPrivate, true);

  const opened = await call('/api/watches/settings', {
    method: 'PATCH', token, body: { private: false }
  });
  assert.equal(opened.json.private, false);
});

// ─────────────────────────── СВЯЗЬ С ОЦЕНКОЙ И РЕЦЕНЗИЕЙ ───────────────────────────

test('watchId при создании оценки связывает запись, но не создаёт её', async () => {
  const user = await createUser();
  const film = await createFilm('Привязка');
  const token = signAccessToken(user._id);

  const watch = await call('/api/watches', {
    method: 'POST', token, body: { filmId: String(film._id) }
  });

  const rated = await call('/api/ratings', {
    method: 'POST', token,
    body: { filmId: String(film._id), vibe: 8, watchId: watch.json._id }
  });
  assert.equal(rated.status, 201);

  const stored = await Watch.findById(watch.json._id);
  assert.equal(String(stored.ratingId), String(rated.json.rating._id));
  assert.equal(await Watch.countDocuments({ filmId: film._id }), 1, 'оценка создала вторую запись');
});

test('оценка без watchId не создаёт запись дневника', async () => {
  // DECISION B5/8: автопривязки и автосоздания нет.
  const user = await createUser();
  const film = await createFilm('Без авто');

  await call('/api/ratings', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id), vibe: 8 }
  });

  assert.equal(await Watch.countDocuments({}), 0);
});

test('чужой watchId при создании оценки отклоняется', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const film = await createFilm('Чужой id');
  const watch = await Watch.create({ userId: owner._id, filmId: film._id, watchedAt: new Date() });

  const { status, json } = await call('/api/ratings', {
    method: 'POST', token: signAccessToken(stranger._id),
    body: { filmId: String(film._id), vibe: 8, watchId: String(watch._id) }
  });

  assert.equal(status, 400);
  assert.equal(json.error.code, 'VALIDATION_ERROR');
  assert.equal(await Rating.countDocuments({}), 0, 'оценка создалась вопреки ошибке');
  const stored = await Watch.findById(watch._id);
  assert.equal(stored.ratingId, null);
});

test('watchId при создании рецензии связывает её', async () => {
  const user = await createUser();
  const film = await createFilm('Рецензия');
  const token = signAccessToken(user._id);
  await createRating({ userId: user._id, filmId: film._id });
  const watch = await Watch.create({ userId: user._id, filmId: film._id, watchedAt: new Date() });

  const review = await call('/api/reviews', {
    method: 'POST', token,
    body: {
      filmId: String(film._id),
      title: 'Заголовок',
      text: 'x'.repeat(350),
      watchId: String(watch._id)
    }
  });

  assert.equal(review.status, 200);
  const stored = await Watch.findById(watch._id);
  assert.equal(String(stored.reviewId), String(review.json._id));
});

// ─────────────────────────── СЧЁТЧИК ФИЛЬМА ───────────────────────────

test('на фильме отдаётся watchesCount, включая записи пользователей с trustWeight 0', async () => {
  // DECISION B5/6: дневник не взвешивается — считаем все записи.
  const user = await createUser({ trustWeight: 0, flagged: true });
  const film = await createFilm('Счётчик');
  await Watch.create({ userId: user._id, filmId: film._id, watchedAt: new Date() });

  const { status, json } = await call(`/api/films/${film._id}`);

  assert.equal(status, 200);
  assert.equal(json.watchesCount, 1);
  assert.equal(json.votesCount, 0, 'оценок нет — votesCount должен остаться нулём');
});

test('пустой фильм отдаёт watchesCount 0', async () => {
  const film = await createFilm('Пустой');
  const { json } = await call(`/api/films/${film._id}`);
  assert.equal(json.watchesCount, 0);
});

// ─────────────────────────── МИГРАЦИЯ ───────────────────────────

test('миграция выставляет counters.watches по факту и идемпотентна', async () => {
  const withWatches = await createUser();
  const withoutWatches = await createUser();
  const film = await createFilm('Миграция');
  await Watch.create({ userId: withWatches._id, filmId: film._id, watchedAt: daysAgo(3) });
  await Watch.create({ userId: withWatches._id, filmId: film._id, watchedAt: daysAgo(1) });

  const dry = await migrateB5({ dryRun: true });
  assert.equal(dry.usersWithWatches, 1);
  assert.equal(dry.usersUpdated, 0, 'dry-run не должен ничего писать');

  await migrateB5();

  const first = await User.findById(withWatches._id).select('counters diaryPrivate');
  assert.equal(first.counters.watches, 2);
  assert.equal(first.diaryPrivate, false);

  const second = await User.findById(withoutWatches._id).select('counters');
  assert.equal(second.counters.watches, 0);

  const again = await migrateB5();
  assert.equal(again.usersUpdated, 0, 'повторный прогон не должен ничего менять');
  assert.equal(again.countersSet, 0);
});
