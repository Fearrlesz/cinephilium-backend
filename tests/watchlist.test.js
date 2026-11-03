// Тесты B6: watchlist — «хочу посмотреть».
// Запуск: node --test tests/watchlist.test.js
// База — in-memory MongoDB, внешний mongod не нужен.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'watchlist-test-access';
process.env.JWT_REFRESH_SECRET = 'watchlist-test-refresh';
process.env.TMDB_API_KEY = 'watchlist-test-tmdb';
process.env.ADMIN_SECRET_KEY = 'watchlist-test-admin';
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
let Watch;
let WatchlistItem;
let Event;
let migrateWatchlistCounters;

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
    email: `wl${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `wl${userSeq}`,
    ...overrides
  });
}

let filmSeq = 0;
async function createFilm(title = 'Фильм') {
  filmSeq += 1;
  return Film.create({ tmdbId: 300000 + filmSeq, title });
}

async function hide(user, fields = {}) {
  await User.updateOne({ _id: user._id }, {
    $set: { privacy: { hideProfile: false, hideFromFeed: false, ...fields } }
  });
}

function countersOf(userId) {
  return User.findById(userId).select('counters');
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
  return { status: response.status, json, text };
}

before(async () => {
  dbPath = path.join(process.cwd(), '.mongo-test', `watchlist-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });

  mongod = await MongoMemoryServer.create({
    instance: { dbPath, launchTimeout: 180000 }
  });
  process.env.MONGODB_URI = mongod.getUri('cinephilium-test-watchlist');

  await mongoose.connect(process.env.MONGODB_URI);
  const app = require('../src/app');

  User = require('../src/models/User');
  Film = require('../src/models/Film');
  Watch = require('../src/models/Watch');
  WatchlistItem = require('../src/models/WatchlistItem');
  Event = require('../src/models/Event');
  migrateWatchlistCounters = require('../scripts/add-watchlist-counters').migrate;

  await Promise.all([User.init(), Film.init(), Watch.init(), WatchlistItem.init(), Event.init()]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User, Film, Watch, WatchlistItem, Event].map(Model => Model.deleteMany({})));
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) {
    try { await mongod.stop(); } catch { /* mongod на Windows иногда шумит при остановке */ }
  }
  try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────── ДОБАВЛЕНИЕ / УДАЛЕНИЕ ───────────────────────────

test('первое добавление: 201, счётчик растёт, запись одна', async () => {
  const user = await createUser();
  const film = await createFilm('Хочу');

  const { status, json } = await call('/api/watchlist', {
    method: 'POST', token: signAccessToken(user._id), body: { filmId: String(film._id) }
  });

  assert.equal(status, 201);
  assert.equal(json.inWatchlist, true);
  assert.equal(String(json.filmId), String(film._id));

  assert.equal(await WatchlistItem.countDocuments({ userId: user._id }), 1);
  const fresh = await countersOf(user._id);
  assert.equal(fresh.counters.watchlist, 1);
});

test('повторное добавление: 200, счётчик не растёт, дубликата нет', async () => {
  const user = await createUser();
  const film = await createFilm('Дважды');
  const token = signAccessToken(user._id);
  const body = { filmId: String(film._id) };

  const first = await call('/api/watchlist', { method: 'POST', token, body });
  const second = await call('/api/watchlist', { method: 'POST', token, body });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.inWatchlist, true);

  assert.equal(await WatchlistItem.countDocuments({ userId: user._id }), 1);
  const fresh = await countersOf(user._id);
  assert.equal(fresh.counters.watchlist, 1);
});

test('удаление: 200, декремент, запись исчезла', async () => {
  const user = await createUser();
  const film = await createFilm('Удалить');
  const token = signAccessToken(user._id);

  const created = await call('/api/watchlist', {
    method: 'POST', token, body: { filmId: String(film._id) }
  });
  const item = await WatchlistItem.findOne({ userId: user._id });

  const removed = await call(`/api/watchlist/${item._id}`, { method: 'DELETE', token });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.inWatchlist, false);
  assert.equal(removed.json.deleted, undefined, 'формат { deleted } запрещён решением 1A');

  assert.equal(await WatchlistItem.countDocuments({}), 0);
  const fresh = await countersOf(user._id);
  assert.equal(fresh.counters.watchlist, 0);
});

test('удаление несуществующего: 200 идемпотентно, счётчик не уходит в минус', async () => {
  const user = await createUser();
  const ghost = new mongoose.Types.ObjectId();

  const first = await call(`/api/watchlist/${ghost}`, {
    method: 'DELETE', token: signAccessToken(user._id)
  });
  const second = await call(`/api/watchlist/${ghost}`, {
    method: 'DELETE', token: signAccessToken(user._id)
  });

  assert.equal(first.status, 200);
  assert.equal(first.json.inWatchlist, false);
  assert.equal(second.status, 200);

  const fresh = await countersOf(user._id);
  assert.equal(fresh.counters.watchlist, 0, 'счётчик ушёл в минус');
});

test('удаление чужой записи: 404, запись и счётчик владельца целы', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const film = await createFilm('Чужая');
  const item = await WatchlistItem.create({ userId: owner._id, filmId: film._id });
  await User.updateOne({ _id: owner._id }, { $set: { 'counters.watchlist': 1 } });

  const removed = await call(`/api/watchlist/${item._id}`, {
    method: 'DELETE', token: signAccessToken(stranger._id)
  });

  assert.equal(removed.status, 404);
  assert.equal(await WatchlistItem.countDocuments({}), 1);
  const ownerAfter = await countersOf(owner._id);
  assert.equal(ownerAfter.counters.watchlist, 1);
});

test('check отдаёт актуальное состояние', async () => {
  const user = await createUser();
  const film = await createFilm('Кнопка');
  const token = signAccessToken(user._id);

  const before = await call(`/api/watchlist/check/${film._id}`, { token });
  assert.equal(before.status, 200);
  assert.equal(before.json.inWatchlist, false);

  await call('/api/watchlist', { method: 'POST', token, body: { filmId: String(film._id) } });

  const after = await call(`/api/watchlist/check/${film._id}`, { token });
  assert.equal(after.json.inWatchlist, true);
});

test('свой список: пагинация, populate и posterUrl', async () => {
  const user = await createUser();
  const first = await createFilm('Первый');
  const second = await createFilm('Второй');
  await WatchlistItem.create({ userId: user._id, filmId: first._id, addedAt: new Date(Date.now() - 1000) });
  await WatchlistItem.create({ userId: user._id, filmId: second._id, addedAt: new Date() });

  const { status, json } = await call('/api/watchlist/user?page=1&limit=1', {
    token: signAccessToken(user._id)
  });

  assert.equal(status, 200);
  assert.equal(json.items.length, 1);
  assert.equal(json.pagination.total, 2);
  assert.equal(json.pagination.pages, 2);
  assert.equal(String(json.items[0].filmId._id), String(second._id), 'сортировка не по дате добавления');
  assert.ok(json.items[0].filmId.posterUrl !== undefined, 'posterUrl не проброшен');
});

// ─────────────────────────── ПРИВАТНОСТЬ ───────────────────────────

test('публичный watchlist открытого профиля доступен анониму', async () => {
  const user = await createUser();
  const film = await createFilm('Открытый');
  await WatchlistItem.create({ userId: user._id, filmId: film._id });

  const { status, json } = await call(`/api/users/${user._id}/watchlist`);
  assert.equal(status, 200);
  assert.equal(json.items.length, 1);
});

test('скрытый профиль: 404 постороннему и анониму', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const film = await createFilm('Скрытый');
  await WatchlistItem.create({ userId: owner._id, filmId: film._id });
  await hide(owner, { hideProfile: true });

  const foreign = await call(`/api/users/${owner._id}/watchlist`, {
    token: signAccessToken(stranger._id)
  });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error.code, 'PROFILE_HIDDEN');

  const anonymous = await call(`/api/users/${owner._id}/watchlist`);
  assert.equal(anonymous.status, 404);
});

test('скрытый профиль: владелец и админ видят полный список', async () => {
  const owner = await createUser();
  const admin = await createUser({ isAdmin: true });
  const film = await createFilm('Свой');
  await WatchlistItem.create({ userId: owner._id, filmId: film._id });
  await hide(owner, { hideProfile: true });

  const own = await call(`/api/users/${owner._id}/watchlist`, {
    token: signAccessToken(owner._id)
  });
  assert.equal(own.status, 200);
  assert.equal(own.json.items.length, 1);

  const asAdmin = await call(`/api/users/${owner._id}/watchlist`, {
    token: signAccessToken(admin._id)
  });
  assert.equal(asAdmin.status, 200);
  assert.equal(asAdmin.json.items.length, 1);
});

test('при hideProfile добавление и свой список работают', async () => {
  const user = await createUser();
  const film = await createFilm('Свой скрытый');
  await hide(user, { hideProfile: true });
  const token = signAccessToken(user._id);

  const added = await call('/api/watchlist', {
    method: 'POST', token, body: { filmId: String(film._id) }
  });
  assert.equal(added.status, 201);

  const mine = await call('/api/watchlist/user', { token });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.items.length, 1);
});

test('счётчик watchlist пропадает из заглушки скрытого профиля', async () => {
  const owner = await createUser();
  const film = await createFilm('Счётчик');
  await WatchlistItem.create({ userId: owner._id, filmId: film._id });
  await User.updateOne({ _id: owner._id }, { $set: { 'counters.watchlist': 1 } });
  await hide(owner, { hideProfile: true });

  const anonymous = await call(`/api/users/${owner._id}`);
  assert.equal(anonymous.json.user.isHidden, true);
  assert.equal(anonymous.json.user.counters, undefined, 'счётчики утекли в заглушку');

  const own = await call(`/api/users/${owner._id}`, { token: signAccessToken(owner._id) });
  assert.equal(own.json.user.counters.watchlist, 1);
});

// ─────────────────────────── ГЕЙМИФИКАЦИЯ И СОБЫТИЯ ───────────────────────────

test('watchlist не влияет на достижения и баллы', async () => {
  // DECISION B6/2A: намерение не кормит геймификацию.
  const user = await createUser();
  const film = await createFilm('Ачивки');
  const before = await User.findById(user._id).select('achievements totalPoints');

  await call('/api/watchlist', {
    method: 'POST', token: signAccessToken(user._id), body: { filmId: String(film._id) }
  });

  const after = await User.findById(user._id).select('achievements totalPoints');
  assert.deepEqual(after.achievements, before.achievements);
  assert.equal(after.totalPoints, before.totalPoints);
});

test('добавление в watchlist не создаёт событие в ленте', async () => {
  const user = await createUser();
  const film = await createFilm('Тишина');

  await call('/api/watchlist', {
    method: 'POST', token: signAccessToken(user._id), body: { filmId: String(film._id) }
  });

  assert.equal(await Event.countDocuments({}), 0);
});

test('создание Watch не удаляет фильм из watchlist', async () => {
  // DECISION B6/3B: автоудаления нет.
  const user = await createUser();
  const film = await createFilm('Посмотрел');
  const token = signAccessToken(user._id);

  await call('/api/watchlist', { method: 'POST', token, body: { filmId: String(film._id) } });
  await call('/api/watches', { method: 'POST', token, body: { filmId: String(film._id) } });

  assert.equal(await WatchlistItem.countDocuments({ userId: user._id }), 1, 'бэк удалил запись из watchlist');
  const fresh = await countersOf(user._id);
  assert.equal(fresh.counters.watchlist, 1);
});

// ─────────────────────────── ЛИМИТ ───────────────────────────

test('лимит: 201-е добавление за час → 429, и он считается на аккаунт, а не на IP', async () => {
  // DECISION B6/6B: ключ лимитера — userId. Каждый запрос идёт с нового IP,
  // поэтому IP-лимитер (writeLimiter 30/мин) не мешает, а лимитер по аккаунту
  // обязан сработать на 201-м.
  const user = await createUser();
  const film = await createFilm('Лимит');
  const token = signAccessToken(user._id);
  const body = { filmId: String(film._id) };

  let allowed = 0;
  let limited = 0;
  for (let i = 0; i < 201; i += 1) {
    const response = await call('/api/watchlist', {
      method: 'POST', token, body,
      headers: { 'x-forwarded-for': `10.${Math.floor(i / 250)}.${i % 250}.7` }
    });
    if (response.status === 429) limited += 1;
    else allowed += 1;
  }

  assert.equal(allowed, 200, 'до лимита должно пройти ровно 200 запросов');
  assert.equal(limited, 1, '201-й запрос не был ограничен');
});

// ─────────────────────────── МИГРАЦИЯ ───────────────────────────

test('миграция счётчика идемпотентна и считает по коллекции', async () => {
  const withItems = await createUser();
  const withoutItems = await createUser();
  const filmA = await createFilm('Миграция A');
  const filmB = await createFilm('Миграция B');
  // Уникальность пары user+film: две записи — это два разных фильма.
  await WatchlistItem.create({ userId: withItems._id, filmId: filmA._id });
  await WatchlistItem.create({ userId: withItems._id, filmId: filmB._id });
  await User.collection.updateMany({}, { $unset: { 'counters.watchlist': '' } });

  const dry = await migrateWatchlistCounters({ dryRun: true });
  assert.equal(dry.withoutCounter, 2);
  assert.equal(dry.usersWithItems, 1);

  // Читаем сырой документ: Mongoose при гидрации подставил бы default 0,
  // и проверка «dry-run ничего не записал» стала бы бессмысленной.
  const rawAfterDryRun = await User.collection.findOne({ _id: withItems._id });
  assert.equal(rawAfterDryRun.counters?.watchlist, undefined, 'dry-run изменил данные');

  const applied = await migrateWatchlistCounters();
  assert.equal(applied.usersWithItems, 1);

  const withTwo = await User.findById(withItems._id).select('counters');
  assert.equal(withTwo.counters.watchlist, 2);

  const withZero = await User.findById(withoutItems._id).select('counters');
  assert.equal(withZero.counters.watchlist, 0);

  const again = await migrateWatchlistCounters();
  assert.equal(again.updated, 0, 'повторный прогон что-то изменил');
});
