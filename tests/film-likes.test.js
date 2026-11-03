// Тесты B7: сердечко фильма (FilmLike).
// Запуск: node --test tests/film-likes.test.js
// База — in-memory MongoDB, внешний mongod не нужен.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'likes-test-access';
process.env.JWT_REFRESH_SECRET = 'likes-test-refresh';
process.env.TMDB_API_KEY = 'likes-test-tmdb';
process.env.ADMIN_SECRET_KEY = 'likes-test-admin';
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
let FilmLike;
let Event;
let flagSybilAccounts;
let unflagAll;
let migrateLikesFields;
let reconcileLikes;

function signAccessToken(userId) {
  return jwt.sign(
    { userId: String(userId), type: 'access' },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '15m', algorithm: 'HS256' }
  );
}

let userSeq = 0;
async function createUser(overrides = {}) {
  userSeq += 1;
  return User.create({
    email: `like${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `like${userSeq}`,
    ...overrides
  });
}

let filmSeq = 0;
async function createFilm(title = 'Фильм') {
  filmSeq += 1;
  return Film.create({ tmdbId: 200000 + filmSeq, title });
}

async function hide(user, fields = {}) {
  await User.updateOne({ _id: user._id }, {
    $set: { privacy: { hideProfile: false, hideFromFeed: false, ...fields } }
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
  dbPath = path.join(process.cwd(), '.mongo-test', `likes-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });

  mongod = await MongoMemoryServer.create({
    instance: { dbPath, launchTimeout: 180000 }
  });
  process.env.MONGODB_URI = mongod.getUri('cinephilium-test-likes');

  await mongoose.connect(process.env.MONGODB_URI);
  const app = require('../src/app');

  User = require('../src/models/User');
  Film = require('../src/models/Film');
  FilmLike = require('../src/models/FilmLike');
  Event = require('../src/models/Event');

  ({ flagSybilAccounts, unflagAll } = require('../scripts/flag-sybil-accounts'));
  migrateLikesFields = require('../scripts/add-film-likes-fields').migrate;
  reconcileLikes = require('../scripts/reconcile-film-likes').reconcile;

  await Promise.all([User.init(), Film.init(), FilmLike.init(), Event.init()]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User, Film, FilmLike, Event].map(Model => Model.deleteMany({})));
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) {
    try { await mongod.stop(); } catch { /* mongod на Windows иногда шумит при остановке */ }
  }
  try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────── TOGGLE И ДВА СЧЁТЧИКА ───────────────────────────

test('лайк: liked, likesCount у фильма и filmLikes у пользователя растут', async () => {
  const user = await createUser();
  const film = await createFilm('Сердечко');

  const { status, json } = await call(`/api/films/${film._id}/like`, {
    method: 'POST', token: signAccessToken(user._id)
  });

  assert.equal(status, 200);
  assert.equal(json.liked, true);
  assert.equal(json.likesCount, 1);

  const freshFilm = await Film.findById(film._id).select('likesCount');
  assert.equal(freshFilm.likesCount, 1);

  const freshUser = await User.findById(user._id).select('counters');
  assert.equal(freshUser.counters.filmLikes, 1);
});

test('повторный POST идемпотентен, DELETE снимает лайк', async () => {
  const user = await createUser();
  const film = await createFilm('Тоггл');
  const token = signAccessToken(user._id);
  const endpoint = `/api/films/${film._id}/like`;

  const first = await call(endpoint, { method: 'POST', token });
  const second = await call(endpoint, { method: 'POST', token });

  assert.equal(first.json.liked, true);
  assert.equal(second.json.liked, true, 'повторный POST снял лайк — это toggle-поведение');
  assert.equal(second.json.likesCount, 1);
  assert.equal(await FilmLike.countDocuments({}), 1);

  const removed = await call(endpoint, { method: 'DELETE', token });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.liked, false);
  assert.equal(removed.json.likesCount, 0);

  const freshFilm = await Film.findById(film._id).select('likesCount');
  assert.equal(freshFilm.likesCount, 0);
  const freshUser = await User.findById(user._id).select('counters');
  assert.equal(freshUser.counters.filmLikes, 0);

  // Повторный DELETE — тоже идемпотентен, счётчики не уходят в минус.
  const again = await call(endpoint, { method: 'DELETE', token });
  assert.equal(again.status, 200);
  assert.equal(again.json.liked, false);
  const afterAgain = await User.findById(user._id).select('counters');
  assert.equal(afterAgain.counters.filmLikes, 0);
});

test('два пользователя: у фильма 2, у каждого в профиле 1', async () => {
  // Главная проверка B7: Film.likesCount и counters.filmLikes — разные числа.
  const first = await createUser();
  const second = await createUser();
  const film = await createFilm('Двое');

  await call(`/api/films/${film._id}/like`, { method: 'POST', token: signAccessToken(first._id) });
  await call(`/api/films/${film._id}/like`, { method: 'POST', token: signAccessToken(second._id) });

  const freshFilm = await Film.findById(film._id).select('likesCount');
  assert.equal(freshFilm.likesCount, 2);

  const firstCounters = await User.findById(first._id).select('counters');
  const secondCounters = await User.findById(second._id).select('counters');
  assert.equal(firstCounters.counters.filmLikes, 1);
  assert.equal(secondCounters.counters.filmLikes, 1, 'личный счётчик посчитал чужой лайк');
});

test('GET фильма: liked для авторизованного, false для анонима', async () => {
  const user = await createUser();
  const film = await createFilm('Проверка');

  const anonymous = await call(`/api/films/${film._id}`);
  assert.equal(anonymous.json.liked, false);
  assert.equal(anonymous.json.likesCount, 0);

  await call(`/api/films/${film._id}/like`, { method: 'POST', token: signAccessToken(user._id) });

  const anonymousAfter = await call(`/api/films/${film._id}`);
  assert.equal(anonymousAfter.json.liked, false);
  assert.equal(anonymousAfter.json.likesCount, 1);

  const authed = await call(`/api/films/${film._id}`, { token: signAccessToken(user._id) });
  assert.equal(authed.json.liked, true);
});

// ─────────────────────────── СПИСКИ И ПРИВАТНОСТЬ ───────────────────────────

test('публичный список «Понравившиеся»: пагинация и posterUrl', async () => {
  const user = await createUser();
  const first = await createFilm('Первый');
  const second = await createFilm('Второй');
  await FilmLike.create({ userId: user._id, filmId: first._id, addedAt: new Date(Date.now() - 1000) });
  await FilmLike.create({ userId: user._id, filmId: second._id, addedAt: new Date() });

  const { status, json } = await call(`/api/users/${user._id}/likes?page=1&limit=1`);

  assert.equal(status, 200);
  assert.equal(json.items.length, 1);
  assert.equal(json.pagination.total, 2);
  assert.equal(json.pagination.pages, 2);
  assert.equal(String(json.items[0].filmId._id), String(second._id), 'сортировка не по дате лайка');
  assert.ok(json.items[0].filmId.posterUrl !== undefined);
  assert.equal(json.items[0].weight, undefined, 'вес лайка утёк наружу');
});

test('скрытый профиль: 404 постороннему и анониму', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const film = await createFilm('Скрытый');
  await FilmLike.create({ userId: owner._id, filmId: film._id });
  await hide(owner, { hideProfile: true });

  const foreign = await call(`/api/users/${owner._id}/likes`, { token: signAccessToken(stranger._id) });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error.code, 'PROFILE_HIDDEN');

  const anonymous = await call(`/api/users/${owner._id}/likes`);
  assert.equal(anonymous.status, 404);
});

test('скрытый профиль: владелец и админ видят список', async () => {
  const owner = await createUser();
  const admin = await createUser({ isAdmin: true });
  const film = await createFilm('Свой');
  await FilmLike.create({ userId: owner._id, filmId: film._id });
  await hide(owner, { hideProfile: true });

  const own = await call(`/api/users/${owner._id}/likes`, { token: signAccessToken(owner._id) });
  assert.equal(own.status, 200);
  assert.equal(own.json.items.length, 1);

  const asAdmin = await call(`/api/users/${owner._id}/likes`, { token: signAccessToken(admin._id) });
  assert.equal(asAdmin.status, 200);
  assert.equal(asAdmin.json.items.length, 1);
});

test('свой список /me/likes доступен при скрытом профиле', async () => {
  const user = await createUser();
  const film = await createFilm('Свой список');
  await hide(user, { hideProfile: true });
  const token = signAccessToken(user._id);

  await call(`/api/films/${film._id}/like`, { method: 'POST', token });

  const mine = await call('/api/users/me/likes', { token });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.items.length, 1);
});

test('лайк скрытого пользователя учитывается в счётчике фильма', async () => {
  // F1: публичный агрегат не зависит от приватности профиля.
  const hidden = await createUser();
  const normal = await createUser();
  const film = await createFilm('Агрегат');
  await FilmLike.create({ userId: hidden._id, filmId: film._id, weight: 1 });
  await FilmLike.create({ userId: normal._id, filmId: film._id, weight: 1 });
  await Film.updateOne({ _id: film._id }, { $set: { likesCount: 2 } });
  await hide(hidden, { hideProfile: true });

  const { json } = await call(`/api/films/${film._id}`);
  assert.equal(json.likesCount, 2);
});

// ─────────────────────────── WEIGHT: 0 ───────────────────────────

test('лайк с weight: 0 создаётся, но не красит публичный счётчик', async () => {
  const flagged = await createUser({ trustWeight: 0 });
  const film = await createFilm('Помеченный');

  const { json } = await call(`/api/films/${film._id}/like`, {
    method: 'POST', token: signAccessToken(flagged._id)
  });

  assert.equal(json.liked, true);
  assert.equal(json.likesCount, 0, 'лайк weight: 0 попал в публичный счётчик');

  assert.equal(await FilmLike.countDocuments({ userId: flagged._id }), 1, 'личный лайк не сохранился');
  const counters = await User.findById(flagged._id).select('counters');
  assert.equal(counters.counters.filmLikes, 1, 'личный счётчик не учёл лайк');
});

test('пометка фермы обнуляет вес лайков и уменьшает счётчик фильма', async () => {
  const film = await createFilm('Ферма');
  const farmIp = '203.0.113.77';

  for (let i = 0; i < 5; i += 1) {
    const user = await createUser({ registeredIp: farmIp, nickname: `sybil${i}` });
    await call(`/api/films/${film._id}/like`, {
      method: 'POST', token: signAccessToken(user._id),
      headers: { 'x-forwarded-for': `10.9.${i}.1` }
    });
  }

  assert.equal((await Film.findById(film._id).select('likesCount')).likesCount, 5);

  const result = await flagSybilAccounts({ minAccounts: 5, windowHours: 24 });
  assert.equal(result.flaggedUsers, 5);
  assert.equal(result.likesUpdated, 5);

  const after = await Film.findById(film._id).select('likesCount');
  assert.equal(after.likesCount, 0, 'лайки фермы остались в публичном счётчике');
  assert.equal(await FilmLike.countDocuments({ filmId: film._id, weight: { $gt: 0 } }), 0);
});

test('снятие пометки возвращает лайки в счётчик', async () => {
  const film = await createFilm('Разжалованные');
  const farmIp = '203.0.113.78';

  for (let i = 0; i < 5; i += 1) {
    const user = await createUser({ registeredIp: farmIp, nickname: `unflag${i}` });
    await call(`/api/films/${film._id}/like`, {
      method: 'POST', token: signAccessToken(user._id),
      headers: { 'x-forwarded-for': `10.8.${i}.1` }
    });
  }

  await flagSybilAccounts({ minAccounts: 5, windowHours: 24 });
  assert.equal((await Film.findById(film._id).select('likesCount')).likesCount, 0);

  const result = await unflagAll();
  assert.equal(result.likesRestored, 5);

  const restored = await Film.findById(film._id).select('likesCount');
  assert.equal(restored.likesCount, 5, 'счётчик не восстановился симметрично');
});

// ─────────────────────────── ГОНКА, СОБЫТИЯ, ДОСТИЖЕНИЯ ───────────────────────────

test('два одновременных POST: оба 200, лайк один, счётчик не удвоился', async () => {
  // DECISION B7/1A: POST — «поставить», а не toggle. Поэтому гонка детерминирована:
  // оба запроса описывают одно намерение и получают одно состояние.
  const user = await createUser();
  const film = await createFilm('Гонка');
  const token = signAccessToken(user._id);
  const endpoint = `/api/films/${film._id}/like`;

  const [a, b] = await Promise.all([
    call(endpoint, { method: 'POST', token }),
    call(endpoint, { method: 'POST', token })
  ]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.json.liked, true);
  assert.equal(b.json.liked, true);
  assert.equal(await FilmLike.countDocuments({ userId: user._id }), 1);

  const freshFilm = await Film.findById(film._id).select('likesCount');
  assert.equal(freshFilm.likesCount, 1, 'счётчик удвоился');
  const freshUser = await User.findById(user._id).select('counters');
  assert.equal(freshUser.counters.filmLikes, 1);
});

test('два одновременных DELETE: оба 200, счётчики не уходят в минус', async () => {
  const user = await createUser();
  const film = await createFilm('Двойное снятие');
  const token = signAccessToken(user._id);
  const endpoint = `/api/films/${film._id}/like`;

  await call(endpoint, { method: 'POST', token });

  const [a, b] = await Promise.all([
    call(endpoint, { method: 'DELETE', token }),
    call(endpoint, { method: 'DELETE', token })
  ]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(await FilmLike.countDocuments({ userId: user._id }), 0);

  const freshFilm = await Film.findById(film._id).select('likesCount');
  assert.equal(freshFilm.likesCount, 0, 'счётчик ушёл в минус');
  const freshUser = await User.findById(user._id).select('counters');
  assert.equal(freshUser.counters.filmLikes, 0);
});

test('лайк не создаёт событие в ленте', async () => {
  const user = await createUser();
  const film = await createFilm('Тишина');

  await call(`/api/films/${film._id}/like`, { method: 'POST', token: signAccessToken(user._id) });

  assert.equal(await Event.countDocuments({}), 0);
});

test('лайк не влияет на достижения и баллы', async () => {
  const user = await createUser();
  const film = await createFilm('Ачивки');
  const before = await User.findById(user._id).select('achievements totalPoints');

  await call(`/api/films/${film._id}/like`, { method: 'POST', token: signAccessToken(user._id) });

  const after = await User.findById(user._id).select('achievements totalPoints');
  assert.deepEqual(after.achievements, before.achievements);
  assert.equal(after.totalPoints, before.totalPoints);
});

test('лимит: 201-й лайк за час с одного IP → 429', async () => {
  // DECISION B7/8B: likeLimiter — 200/час на IP, как ratingLimiter.
  const user = await createUser();
  const film = await createFilm('Лимит');
  const token = signAccessToken(user._id);
  const ip = '198.18.77.7';

  let allowed = 0;
  let limited = 0;
  for (let i = 0; i < 201; i += 1) {
    const response = await call(`/api/films/${film._id}/like`, {
      method: 'POST', token, headers: { 'x-forwarded-for': ip }
    });
    if (response.status === 429) limited += 1;
    else allowed += 1;
  }

  assert.equal(allowed, 200, 'до лимита должно пройти ровно 200 запросов');
  assert.equal(limited, 1, '201-й запрос не был ограничен');
});

// ─────────────────────────── МИГРАЦИИ И СВЕРКА ───────────────────────────

test('сверка исправляет расхождение Film.likesCount', async () => {
  const user = await createUser();
  const film = await createFilm('Сверка');
  await FilmLike.create({ userId: user._id, filmId: film._id, weight: 1 });
  await Film.updateOne({ _id: film._id }, { $set: { likesCount: 7 } });

  const dry = await reconcileLikes({ dryRun: true });
  assert.equal(dry.mismatched, 1);
  assert.equal((await Film.findById(film._id).select('likesCount')).likesCount, 7, 'dry-run изменил данные');

  const applied = await reconcileLikes();
  assert.equal(applied.fixed, 1);
  assert.equal((await Film.findById(film._id).select('likesCount')).likesCount, 1);

  const again = await reconcileLikes();
  assert.equal(again.mismatched, 0);
});

test('миграция полей идемпотентна', async () => {
  const user = await createUser();
  const film = await createFilm('Миграция');
  await Film.collection.updateOne({ _id: film._id }, { $unset: { likesCount: '' } });
  await User.collection.updateOne({ _id: user._id }, { $unset: { 'counters.filmLikes': '' } });

  const dry = await migrateLikesFields({ dryRun: true });
  assert.equal(dry.filmsWithoutCount, 1);
  assert.equal(dry.usersWithoutCounter, 1);

  const rawAfterDry = await Film.collection.findOne({ _id: film._id });
  assert.equal(rawAfterDry.likesCount, undefined, 'dry-run изменил данные');

  await migrateLikesFields();
  const freshFilm = await Film.findById(film._id).select('likesCount');
  const freshUser = await User.findById(user._id).select('counters');
  assert.equal(freshFilm.likesCount, 0);
  assert.equal(freshUser.counters.filmLikes, 0);

  const again = await migrateLikesFields();
  assert.equal(again.filmsUpdated, 0);
  assert.equal(again.usersUpdated, 0);
});
