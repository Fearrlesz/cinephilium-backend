// Тесты B-PRIVACY: приватность профиля и ленты, Event.userId, retro-fit B5.
// Запуск: node --test tests/privacy.test.js
// База — in-memory MongoDB, внешний mongod не нужен.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'privacy-test-access';
process.env.JWT_REFRESH_SECRET = 'privacy-test-refresh';
process.env.TMDB_API_KEY = 'privacy-test-tmdb';
process.env.ADMIN_SECRET_KEY = 'privacy-test-admin';
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
let Comment;
let Watch;
let Event;
let PrivacyChangeLog;
let canViewProfile;
let privacyOf;
let migrateEventUserId;
let migratePrivacyFields;

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
    email: `priv${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `priv${userSeq}`,
    ...overrides
  });
}

let filmSeq = 0;
async function createFilm(title = 'Фильм') {
  filmSeq += 1;
  return Film.create({ tmdbId: 400000 + filmSeq, title });
}

async function createRating({ userId, filmId, technicalScore = 60, combinedScore = 60, completeness = 'full' }) {
  const isFull = completeness === 'full';
  return Rating.create({
    userId, filmId, completeness, vibe: 7,
    technicalScore: isFull ? technicalScore : 0,
    combinedScore: isFull ? combinedScore : 0,
    ...(isFull ? { scores: fullScores(8) } : {})
  });
}

async function hide(user, fields) {
  await User.updateOne({ _id: user._id }, { $set: {
    privacy: { hideProfile: false, hideFromFeed: false, ...fields }
  } });
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
  dbPath = path.join(process.cwd(), '.mongo-test', `privacy-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });

  mongod = await MongoMemoryServer.create({
    instance: { dbPath, launchTimeout: 180000 }
  });
  process.env.MONGODB_URI = mongod.getUri('cinephilium-test-privacy');

  await mongoose.connect(process.env.MONGODB_URI);
  const app = require('../src/app');

  User = require('../src/models/User');
  Film = require('../src/models/Film');
  Rating = require('../src/models/Rating');
  Review = require('../src/models/Review');
  Comment = require('../src/models/Comment');
  Watch = require('../src/models/Watch');
  Event = require('../src/models/Event');
  PrivacyChangeLog = require('../src/models/PrivacyChangeLog');

  ({ canViewProfile, privacyOf } = require('../src/utils/privacy'));
  migrateEventUserId = require('../scripts/add-event-userid').migrate;
  migratePrivacyFields = require('../scripts/add-privacy-fields').migrate;

  await Promise.all([
    User.init(), Film.init(), Rating.init(), Review.init(),
    Comment.init(), Watch.init(), Event.init(), PrivacyChangeLog.init()
  ]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([
    User, Film, Rating, Review, Comment, Watch, Event, PrivacyChangeLog
  ].map(Model => Model.deleteMany({})));
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) {
    try { await mongod.stop(); } catch { /* mongod на Windows иногда шумит при остановке */ }
  }
  try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────── ФЛАГИ И ЛОГ ───────────────────────────

test('PUT /me/privacy включает hideProfile и пишет лог', async () => {
  const user = await createUser();

  const { status, json } = await call('/api/users/me/privacy', {
    method: 'PUT', token: signAccessToken(user._id),
    body: { hideProfile: true }
  });

  assert.equal(status, 200);
  assert.deepEqual(json, { hideProfile: true, hideFromFeed: false });

  const fresh = await User.findById(user._id).select('privacy');
  assert.equal(fresh.privacy.hideProfile, true);

  const logs = await PrivacyChangeLog.find({ userId: user._id }).lean();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].field, 'hideProfile');
  assert.equal(logs[0].oldValue, false);
  assert.equal(logs[0].newValue, true);
});

test('флаги независимы: partial update не сбрасывает второй', async () => {
  const user = await createUser();
  const token = signAccessToken(user._id);

  await call('/api/users/me/privacy', { method: 'PUT', token, body: { hideProfile: true } });
  const second = await call('/api/users/me/privacy', { method: 'PUT', token, body: { hideFromFeed: true } });

  assert.deepEqual(second.json, { hideProfile: true, hideFromFeed: true });
});

test('повторный PUT с тем же значением не создаёт лог', async () => {
  const user = await createUser();
  const token = signAccessToken(user._id);

  await call('/api/users/me/privacy', { method: 'PUT', token, body: { hideProfile: true } });
  await call('/api/users/me/privacy', { method: 'PUT', token, body: { hideProfile: true } });

  assert.equal(await PrivacyChangeLog.countDocuments({ userId: user._id }), 1);
});

test('GET /me/privacy отдаёт текущее состояние', async () => {
  const user = await createUser();
  await hide(user, { hideFromFeed: true });

  const { status, json } = await call('/api/users/me/privacy', { token: signAccessToken(user._id) });

  assert.equal(status, 200);
  assert.deepEqual(json, { hideProfile: false, hideFromFeed: true });
});

test('невалидное значение флага — 400 и без изменений', async () => {
  const user = await createUser();
  const { status, json } = await call('/api/users/me/privacy', {
    method: 'PUT', token: signAccessToken(user._id),
    body: { hideProfile: 'yes' }
  });

  assert.equal(status, 400);
  assert.equal(json.error.code, 'VALIDATION_ERROR');
  const fresh = await User.findById(user._id).select('privacy');
  assert.equal(fresh.privacy.hideProfile, false);
});

test('TTL-индекс лога создан (180 дней)', async () => {
  const indexes = await PrivacyChangeLog.collection.indexes();
  const ttl = indexes.find(index => index.expireAfterSeconds !== undefined);
  assert.ok(ttl, 'TTL-индекс отсутствует');
  assert.equal(ttl.expireAfterSeconds, 180 * 24 * 60 * 60);
});

// ─────────────────────────── ПРОФИЛЬ ───────────────────────────

test('скрытый профиль: аноним видит заглушку без личных разделов', async () => {
  const user = await createUser();
  const film = await createFilm('Скрытый');
  await createRating({ userId: user._id, filmId: film._id });
  await hide(user, { hideProfile: true });

  const { status, json } = await call(`/api/users/${user._id}`);

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json), ['user'], 'в заглушке лишние разделы');
  assert.equal(json.user.isHidden, true);
  assert.equal(json.user.nickname, user.nickname);
  assert.equal(json.user.id, String(user._id));
  assert.equal(json.user.counters, undefined);
  assert.equal(json.user.achievements, undefined);
});

test('скрытый профиль: владелец и админ видят полностью, посторонний — нет', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const admin = await createUser({ isAdmin: true });
  await hide(owner, { hideProfile: true });

  const own = await call(`/api/users/${owner._id}`, { token: signAccessToken(owner._id) });
  assert.ok(own.json.user.counters !== undefined, 'владелец не увидел свой профиль');

  const asAdmin = await call(`/api/users/${owner._id}`, { token: signAccessToken(admin._id) });
  assert.ok(asAdmin.json.user.counters !== undefined, 'админ не увидел скрытый профиль');

  const asStranger = await call(`/api/users/${owner._id}`, { token: signAccessToken(stranger._id) });
  assert.equal(asStranger.json.user.isHidden, true);
});

test('скрытый профиль: достижения чужому — 404, владельцу — 200', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  await hide(owner, { hideProfile: true });

  const foreign = await call(`/api/users/${owner._id}/achievements`, {
    token: signAccessToken(stranger._id)
  });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error.code, 'PROFILE_HIDDEN');

  const own = await call(`/api/users/${owner._id}/achievements`, {
    token: signAccessToken(owner._id)
  });
  assert.equal(own.status, 200);
});

test('скрытый профиль: /nickname отдаёт только ник и аватар', async () => {
  const user = await createUser({ avatar: '/a.png' });
  await hide(user, { hideProfile: true });

  const { status, json } = await call(`/api/users/nickname/${user.nickname}`);

  assert.equal(status, 200);
  assert.deepEqual(json, { id: String(user._id), nickname: user.nickname, avatar: '/a.png', isHidden: true });
});

test('публичный контент скрытого остаётся видимым', async () => {
  // DECISION B-PRIVACY/C2: скрытие профиля не отзывает опубликованное.
  const author = await createUser();
  const film = await createFilm('Публичный');
  const rating = await createRating({ userId: author._id, filmId: film._id, technicalScore: 70, combinedScore: 70 });
  await Review.create({
    userId: author._id, filmId: film._id, ratingId: rating._id,
    title: 'Рецензия', text: 'x'.repeat(400), status: 'approved'
  });
  await Comment.create({ userId: author._id, filmId: film._id, text: 'Комментарий', status: 'approved' });
  await hide(author, { hideProfile: true });

  const reviews = await call(`/api/reviews/${film._id}`);
  assert.equal(reviews.json.length, 1, 'рецензия скрытого пропала');

  const comments = await call(`/api/comments/${film._id}`);
  assert.equal(comments.json.length, 1, 'комментарий скрытого пропал');

  const ratings = await call(`/api/films/${film._id}/ratings`);
  assert.equal(ratings.json.length, 1, 'оценка скрытого пропала');
});

test('оценки скрытого участвуют в агрегатах фильма', async () => {
  // DECISION B-PRIVACY/F1.
  const hidden = await createUser();
  const normal = await createUser();
  const film = await createFilm('Агрегат');
  await createRating({ userId: hidden._id, filmId: film._id, technicalScore: 60, combinedScore: 60 });
  await createRating({ userId: normal._id, filmId: film._id, technicalScore: 80, combinedScore: 80 });
  await hide(hidden, { hideProfile: true });

  const { json } = await call(`/api/films/${film._id}`);
  assert.equal(json.averageTechnical, 70, 'оценка скрытого выпала из среднего');
  assert.equal(json.votesCount, 2);
});

test('скрытый профиль не попадает в топ пользователей', async () => {
  const hidden = await createUser({ totalPoints: 1000 });
  const visible = await createUser({ totalPoints: 10 });
  await hide(hidden, { hideProfile: true });

  const { json } = await call('/api/top/users');
  const ids = json.items.map(item => String(item._id));

  assert.equal(ids.includes(String(hidden._id)), false);
  assert.equal(ids.includes(String(visible._id)), true);
});

test('canViewProfile: владелец, админ, посторонний и выключенный флаг', async () => {
  const owner = await createUser();
  const target = { _id: owner._id, privacy: { hideProfile: true } };

  assert.equal(canViewProfile({ userId: String(owner._id) }, target), true);
  assert.equal(canViewProfile({ userId: String(owner._id), isAdmin: false }, target), true);
  assert.equal(canViewProfile({ userId: 'someone-else', isAdmin: true }, target), true);
  assert.equal(canViewProfile({ userId: 'someone-else', isAdmin: false }, target), false);
  assert.equal(canViewProfile(null, target), false);
  assert.equal(canViewProfile(null, { _id: owner._id, privacy: { hideProfile: false } }), true);
  assert.equal(privacyOf(null).hideProfile, false);
});

// ─────────────────────────── ЛЕНТА И EVENT.USERID ───────────────────────────

test('событие, созданное через API, имеет userId', async () => {
  const user = await createUser();
  const film = await createFilm('Событие');

  await call('/api/ratings', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id), vibe: 8 }
  });

  const events = await Event.find({}).lean();
  assert.equal(events.length, 1);
  assert.ok(events[0].userId, 'у события нет автора');
  assert.equal(String(events[0].userId), String(user._id));
});

test('hideFromFeed скрывает события автора, снятие флага возвращает', async () => {
  const user = await createUser();
  const other = await createUser();
  const film = await createFilm('Лента');
  const token = signAccessToken(user._id);

  await call('/api/ratings', {
    method: 'POST', token,
    body: { filmId: String(film._id), vibe: 8 }
  });
  await call('/api/ratings', {
    method: 'POST', token: signAccessToken(other._id),
    body: { filmId: String(film._id), vibe: 5 }
  });

  const before = await call('/api/events');
  assert.equal(before.json.length, 2);

  await hide(user, { hideFromFeed: true });
  const hidden = await call('/api/events');
  assert.equal(hidden.json.length, 1);
  assert.equal(String(hidden.json[0].userId), String(other._id));

  await hide(user, {});
  const restored = await call('/api/events');
  assert.equal(restored.json.length, 2, 'снятие флага не вернуло события');
});

test('миграция Event.userId матчит по нику и идемпотентна', async () => {
  const author = await createUser();
  const film = await createFilm('Миграция');
  await Event.create({ type: 'rating', user: author.nickname, film: film.title, filmId: film._id, score: 70 });
  await Event.create({ type: 'review', user: author.nickname, film: film.title, filmId: film._id });
  await Event.create({ type: 'comment', user: author.nickname, film: film.title, filmId: film._id });

  const dry = await migrateEventUserId({ dryRun: true });
  assert.equal(dry.total, 3);
  assert.equal(dry.matched, 3);
  assert.equal(await Event.countDocuments({ userId: null }), 3, 'dry-run изменил данные');

  const applied = await migrateEventUserId();
  assert.equal(applied.updated, 3);
  assert.equal(await Event.countDocuments({ userId: null }), 0);

  const again = await migrateEventUserId();
  assert.equal(again.total, 0);
  assert.equal(again.updated, 0);
});

test('миграция Event.userId: одно осиротевшее событие пропускается', async () => {
  const author = await createUser();
  const film = await createFilm('Сирота');
  await Event.create({ type: 'rating', user: author.nickname, film: film.title, filmId: film._id });
  await Event.create({ type: 'rating', user: 'удалённый', film: film.title, filmId: film._id });

  const result = await migrateEventUserId();
  assert.equal(result.matched, 1);
  assert.equal(result.unmatched, 1);
  assert.equal(await Event.countDocuments({ userId: null }), 1);
});

test('миграция Event.userId: несколько несматченных — стоп без записи', async () => {
  const film = await createFilm('Массово');
  await Event.create({ type: 'rating', user: 'нет-такого-1', film: film.title, filmId: film._id });
  await Event.create({ type: 'rating', user: 'нет-такого-2', film: film.title, filmId: film._id });

  await assert.rejects(() => migrateEventUserId(), /несматченных событий 2/);
  assert.equal(await Event.countDocuments({ userId: null }), 2, 'частичная миграция недопустима');
});

// ─────────────────────────── RETRO-FIT B5 ───────────────────────────

test('дневник скрытого: 404 постороннему, полный список владельцу и админу', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const admin = await createUser({ isAdmin: true });
  const film = await createFilm('Дневник');
  await Watch.create({ userId: owner._id, filmId: film._id, watchedAt: new Date() });
  await hide(owner, { hideProfile: true });

  const foreign = await call(`/api/users/${owner._id}/watches`, {
    token: signAccessToken(stranger._id)
  });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error.code, 'PROFILE_HIDDEN');

  const anonymous = await call(`/api/users/${owner._id}/watches`);
  assert.equal(anonymous.status, 404);

  const own = await call(`/api/users/${owner._id}/watches`, { token: signAccessToken(owner._id) });
  assert.equal(own.status, 200);
  assert.equal(own.json.items.length, 1);

  const asAdmin = await call(`/api/users/${owner._id}/watches`, { token: signAccessToken(admin._id) });
  assert.equal(asAdmin.status, 200);
  assert.equal(asAdmin.json.items.length, 1);
});

test('дневник скрытого: тот же 404 и на /api/watches/user/:id', async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const film = await createFilm('Алиас');
  await Watch.create({ userId: owner._id, filmId: film._id, watchedAt: new Date() });
  await hide(owner, { hideProfile: true });

  const foreign = await call(`/api/watches/user/${owner._id}`, {
    token: signAccessToken(stranger._id)
  });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error.code, 'PROFILE_HIDDEN');
});

test('при hideProfile свой дневник пишется и читается', async () => {
  const user = await createUser();
  const film = await createFilm('Свой');
  await hide(user, { hideProfile: true });
  const token = signAccessToken(user._id);

  const created = await call('/api/watches', {
    method: 'POST', token, body: { filmId: String(film._id) }
  });
  assert.equal(created.status, 201);

  const mine = await call('/api/watches/me', { token });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.items.length, 1);
});

test('счётчик просмотров фильма не фильтрует скрытых', async () => {
  const hidden = await createUser();
  const normal = await createUser();
  const film = await createFilm('Счётчик');
  await Watch.create({ userId: hidden._id, filmId: film._id, watchedAt: new Date() });
  await Watch.create({ userId: normal._id, filmId: film._id, watchedAt: new Date() });
  await hide(hidden, { hideProfile: true });

  const count = await call(`/api/watches/${film._id}/count`);
  assert.equal(count.status, 200);
  assert.equal(count.json.count, 2, 'скрытый выпал из публичного счётчика');

  const filmDetail = await call(`/api/films/${film._id}`);
  assert.equal(filmDetail.json.watchesCount, 2);
});

test('публичный дневник открытого пользователя доступен без токена', async () => {
  const user = await createUser();
  const film = await createFilm('Открытый');
  await Watch.create({ userId: user._id, filmId: film._id, watchedAt: new Date() });

  const { status, json } = await call(`/api/users/${user._id}/watches`);
  assert.equal(status, 200);
  assert.equal(json.items.length, 1);
  assert.equal(json.private, false);
});

// ─────────────────────────── МИГРАЦИЯ ФЛАГОВ ───────────────────────────

test('миграция флагов приватности идемпотентна', async () => {
  const user = await createUser();
  await User.collection.updateOne({ _id: user._id }, { $unset: { privacy: '' } });

  const dry = await migratePrivacyFields({ dryRun: true });
  assert.equal(dry.withoutPrivacy, 1);
  assert.equal(dry.updated, 0);

  await migratePrivacyFields();
  const fresh = await User.findById(user._id).select('privacy');
  assert.equal(fresh.privacy.hideProfile, false);
  assert.equal(fresh.privacy.hideFromFeed, false);

  const again = await migratePrivacyFields();
  assert.equal(again.updated, 0);
});
