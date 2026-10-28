// Тесты P1/B1: двухступенчатая оценка (vibe → full).
// Запуск: node --test tests/vibe-rating.test.js
// База — in-memory MongoDB, внешний mongod не нужен.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'vibe-test-access';
process.env.JWT_REFRESH_SECRET = 'vibe-test-refresh';
process.env.TMDB_API_KEY = 'vibe-test-tmdb';
process.env.ADMIN_SECRET_KEY = 'vibe-test-admin';
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
let Event;
let Action;

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
    email: `vibe${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `vibe${userSeq}`,
    ...overrides
  });
}

let filmSeq = 0;
async function createFilm(title = 'Фильм') {
  filmSeq += 1;
  return Film.create({ tmdbId: 900000 + filmSeq, title });
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
  return { status: response.status, json, text, headers: response.headers };
}

before(async () => {
  dbPath = path.join(process.cwd(), '.mongo-test', `vibe-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });

  mongod = await MongoMemoryServer.create({
    instance: { dbPath, launchTimeout: 180000 }
  });
  process.env.MONGODB_URI = mongod.getUri('cinephilium-test-vibe');

  await mongoose.connect(process.env.MONGODB_URI);
  app = require('../src/app');

  ({ User, Film, Rating, Event, Action } = {
    User: require('../src/models/User'),
    Film: require('../src/models/Film'),
    Rating: require('../src/models/Rating'),
    Event: require('../src/models/Event'),
    Action: require('../src/models/Action')
  });

  await Promise.all([User.init(), Film.init(), Rating.init(), Event.init(), Action.init()]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User, Film, Rating, Event, Action].map(Model => Model.deleteMany({})));
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) {
    try { await mongod.stop(); } catch { /* mongod на Windows иногда шумит при остановке */ }
  }
  try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────── VIBE ───────────────────────────

test('лайт-оценка: только vibe, баллы 0, counters.ratings не растёт', async () => {
  const user = await createUser();
  const film = await createFilm('Лайт');

  const response = await call('/api/ratings', {
    method: 'POST',
    token: signAccessToken(user._id),
    body: { filmId: String(film._id), vibe: 8 }
  });

  assert.equal(response.status, 201, response.text);
  assert.equal(response.json.completeness, 'vibe');
  assert.equal(response.json.rating.completeness, 'vibe');
  assert.equal(response.json.rating.vibe, 8);
  assert.equal(response.json.rating.technicalScore, 0);
  assert.equal(response.json.rating.combinedScore, 0);
  assert.equal(response.json.rating.finalScore, undefined);
  assert.equal(response.json.rating.scores, null);
  assert.equal(response.json.rating.blockWeights, null);
  assert.equal(response.json.rating.genrePreset, null);
  assert.equal(response.json.rating.vibeCreatedAt, undefined, 'служебное поле не должно утекать');
  assert.equal(response.json.technicalScore, 0);
  assert.equal(response.json.combinedScore, 0);

  const stored = await Rating.findOne({ userId: user._id, filmId: film._id }).select('+vibeCreatedAt');
  assert.ok(stored);
  assert.equal(stored.completeness, 'vibe');
  const storedScores = stored.toObject().scores || {};
  const hasAnyCriterion = Object.values(storedScores).some(
    block => block && Object.values(block).some(Number.isFinite)
  );
  assert.equal(hasAnyCriterion, false, 'у vibe-оценки не должно быть 15 критериев');
  assert.equal(stored.technicalScore, 0);
  assert.equal(stored.combinedScore, 0);
  assert.ok(stored.vibeCreatedAt instanceof Date, 'vibeCreatedAt не записан');

  const userAfter = await User.findById(user._id);
  assert.equal(userAfter.counters.ratings, 0);
  assert.equal(userAfter.counters.vibes, 1);
  assert.equal(userAfter.totalPoints, 2, 'лайт должен давать +2 балла');

  const me = await call('/api/auth/me', { token: signAccessToken(user._id) });
  assert.equal(me.json.vibeWindow, undefined, 'служебное окно капа не должно утекать в API');

  const events = await Event.find({ type: 'vibe' });
  assert.equal(events.length, 1);
  assert.equal(events[0].score, null);
  assert.equal(events[0].metadata.vibe, 8);
  assert.equal(events[0].metadata.completeness, 'vibe');

  const actions = await Action.find({ userId: user._id, type: 'rating' });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].points, 2);
});

test('полная оценка сразу: completeness full, баллы 10–100, +10', async () => {
  const user = await createUser();
  const film = await createFilm('Полная');

  const response = await call('/api/ratings', {
    method: 'POST',
    token: signAccessToken(user._id),
    body: {
      filmId: String(film._id),
      scores: scores(8),
      vibe: 8,
      genrePreset: 'drama'
    }
  });

  assert.equal(response.status, 201, response.text);
  assert.equal(response.json.completeness, 'full');
  assert.equal(response.json.rating.completeness, 'full');
  assert.equal(response.json.technicalScore, 80);
  assert.equal(response.json.combinedScore, 80);
  assert.ok(response.json.technicalScore >= 10 && response.json.technicalScore <= 100);

  const userAfter = await User.findById(user._id);
  assert.equal(userAfter.counters.ratings, 1);
  assert.equal(userAfter.counters.vibes, 0);
  assert.equal(userAfter.totalPoints, 10);

  const events = await Event.find({ type: 'rating' });
  assert.equal(events.length, 1);
  assert.equal(events[0].score, 80);
});

test('апгрейд без vibe оставляет вайб из лайт-оценки', async () => {
  const user = await createUser();
  const film = await createFilm('Без нового вайба');
  const token = signAccessToken(user._id);

  await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(film._id), vibe: 6 }
  });

  const upgraded = await call('/api/ratings', {
    method: 'POST',
    token,
    body: { filmId: String(film._id), scores: scores(8) }
  });

  assert.equal(upgraded.status, 201, upgraded.text);
  assert.equal(upgraded.json.vibe, 6);
  assert.equal((await Rating.findOne({ userId: user._id, filmId: film._id })).vibe, 6);

  // technical = 80, combined = 80*0.7 + 6*3 = 74
  assert.equal(upgraded.json.combinedScore, 74);
});

test('кап: 49 занятых слотов — создание проходит, 50-й занимает последний', async () => {
  const user = await createUser();
  const film = await createFilm('49 слотов');
  const recent = Array.from({ length: 49 }, (_, i) => new Date(Date.now() - i * 1000));
  await User.collection.updateOne({ _id: user._id }, { $set: { vibeWindow: recent } });

  const response = await call('/api/ratings', {
    method: 'POST',
    token: signAccessToken(user._id),
    body: { filmId: String(film._id), vibe: 8 }
  });

  assert.equal(response.status, 201, response.text);
  const raw = await User.collection.findOne({ _id: user._id });
  assert.equal(raw.vibeWindow.length, 50);
  assert.equal(await Rating.countDocuments({ userId: user._id }), 1);
});

test('кап скользящий: отметки старше 24 часов не считаются', async () => {
  const user = await createUser();
  const film = await createFilm('Старое окно');
  const old = Array.from(
    { length: 50 },
    (_, i) => new Date(Date.now() - (25 * 60 * 60 * 1000) - i * 1000)
  );
  await User.collection.updateOne({ _id: user._id }, { $set: { vibeWindow: old } });

  const response = await call('/api/ratings', {
    method: 'POST',
    token: signAccessToken(user._id),
    body: { filmId: String(film._id), vibe: 8 }
  });

  assert.equal(response.status, 201, response.text);
});

test('повторный лайт — апдейт той же записи, без повторных баллов и счётчика', async () => {
  const user = await createUser();
  const film = await createFilm('Повтор');
  const token = signAccessToken(user._id);

  const first = await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(film._id), vibe: 8 }
  });
  const second = await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(film._id), vibe: 9 }
  });

  assert.equal(first.status, 201, first.text);
  assert.equal(second.status, 201, second.text);
  assert.equal(second.json.rating._id, first.json.rating._id);
  assert.equal(second.json.rating.vibe, 9);

  assert.equal(await Rating.countDocuments({ userId: user._id, filmId: film._id }), 1);
  assert.equal((await User.findById(user._id)).counters.vibes, 1);
  assert.equal((await User.findById(user._id)).totalPoints, 2);
  assert.equal(await Event.countDocuments({ type: 'vibe' }), 1);
});

test('апгрейд vibe → full: тот же _id, weight сохранён, ip обновлён, +8', async () => {
  const user = await createUser({ trustWeight: 0 });
  const film = await createFilm('Апгрейд');
  const token = signAccessToken(user._id);

  const light = await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(film._id), vibe: 6 }
  });
  assert.equal(light.status, 201, light.text);
  const ratingId = light.json.rating._id;

  await Rating.updateOne({ _id: ratingId }, { $set: { ip: '10.0.0.1' } });

  const upgraded = await call('/api/ratings', {
    method: 'POST',
    token,
    body: {
      filmId: String(film._id),
      scores: scores(7),
      vibe: 9,
      genrePreset: 'drama'
    }
  });

  assert.equal(upgraded.status, 201, upgraded.text);
  assert.equal(upgraded.json.rating._id, ratingId);
  assert.equal(upgraded.json.completeness, 'full');
  assert.equal(
    new Date(upgraded.json.rating.createdAt).getTime(),
    new Date(light.json.rating.createdAt).getTime(),
    'createdAt должен сохраниться'
  );

  const stored = await Rating.findById(ratingId);
  assert.equal(stored.completeness, 'full');
  assert.equal(stored.vibe, 9, 'vibe должен меняться (3A)');
  assert.equal(stored.weight, 0, 'weight: 0 должен сохраниться');
  assert.notEqual(stored.ip, '10.0.0.1', 'ip должен обновиться');
  assert.match(stored.ip, /^203\.0\.113\./);

  const userAfter = await User.findById(user._id);
  assert.equal(userAfter.counters.ratings, 1);
  assert.equal(userAfter.counters.vibes, 0);
  assert.equal(userAfter.totalPoints, 10, '2 за vibe + 8 за апгрейд');
  assert.ok(
    userAfter.achievements.some(text => text.includes('Первое впечатление')),
    'апгрейд должен сохранить «Первое впечатление»'
  );
});

test('даунгрейд запрещён: full + vibe → 400 ALREADY_FULL_RATING, данные целы', async () => {
  const user = await createUser();
  const film = await createFilm('Даунгрейд');
  const token = signAccessToken(user._id);

  await call('/api/ratings', {
    method: 'POST',
    token,
    body: { filmId: String(film._id), scores: scores(8), vibe: 8 }
  });

  const downgrade = await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(film._id), vibe: 3 }
  });

  assert.equal(downgrade.status, 400);
  assert.equal(downgrade.json.error.code, 'ALREADY_FULL_RATING');

  const stored = await Rating.findOne({ userId: user._id, filmId: film._id });
  assert.equal(stored.completeness, 'full');
  assert.ok(stored.scores);
  assert.equal(stored.technicalScore, 80);
  assert.equal(stored.vibe, 8, 'vibe не должен измениться');
});

test('лайт строгий: лишние полные поля без 15 критериев → 400', async () => {
  const user = await createUser();
  const film = await createFilm('Строгий лайт');
  const token = signAccessToken(user._id);

  const response = await call('/api/ratings', {
    method: 'POST',
    token,
    body: {
      filmId: String(film._id),
      vibe: 8,
      textReview: 'Текст, который нельзя молча потерять'
    }
  });

  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'VALIDATION_ERROR');
  assert.equal(await Rating.countDocuments({ userId: user._id }), 0);
});

test('дневной кап: 50 vibe за 24 часа, 51-й → 429, апгрейд не блокируется', async () => {
  const user = await createUser();
  const films = [];
  for (let i = 0; i < 51; i += 1) films.push(await createFilm(`Кап ${i}`));
  const token = signAccessToken(user._id);

  const recent = Array.from({ length: 50 }, (_, i) => new Date(Date.now() - i * 1000));
  await User.collection.updateOne({ _id: user._id }, { $set: { vibeWindow: recent } });

  const limited = await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(films[0]._id), vibe: 8 }
  });

  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'VIBE_LIMIT_REACHED');
  assert.equal(limited.json.error.details.limit, 50);
  assert.equal(limited.json.error.details.window, '24h');
  assert.ok(Date.parse(limited.json.error.details.retryAt) > Date.now());
  assert.equal(await Rating.countDocuments({ userId: user._id }), 0, 'при 429 в БД ничего не пишется');

  // Апгрейд уже существующей vibe-оценки капом не ограничен.
  const seeded = await Rating.create({
    userId: user._id,
    filmId: films[0]._id,
    vibe: 5,
    completeness: 'vibe',
    technicalScore: 0,
    combinedScore: 0,
    scores: null,
    weight: 1,
    vibeCreatedAt: new Date()
  });

  const upgraded = await call('/api/ratings', {
    method: 'POST',
    token,
    body: { filmId: String(films[0]._id), scores: scores(8), vibe: 7 }
  });

  assert.equal(upgraded.status, 201, upgraded.text);
  assert.equal((await Rating.findById(seeded._id)).completeness, 'full');
});

test('достижения: effective = ratings + vibes/5, пороги ×2, FIRST_VIBE отдельно', async () => {
  const { getBasicAchievements, ACHIEVEMENTS } = require('../src/utils/achievements');

  assert.equal(ACHIEVEMENTS.RATING_10, undefined, 'старая константа должна быть переименована');
  assert.ok(ACHIEVEMENTS.RATING_20);
  assert.ok(ACHIEVEMENTS.RATING_50);
  assert.ok(ACHIEVEMENTS.RATING_100);
  assert.ok(ACHIEVEMENTS.RATING_200);

  const twenty = getBasicAchievements(0, 100, 0, 0);
  assert.ok(twenty.includes(ACHIEVEMENTS.RATING_20), '100 vibe = effective 20');
  assert.ok(!twenty.includes(ACHIEVEMENTS.RATING_50));

  const nineteen = getBasicAchievements(0, 95, 0, 0);
  assert.ok(!nineteen.includes(ACHIEVEMENTS.RATING_20), '95 vibe = 19.8, порог не пройден');

  const firstFull = getBasicAchievements(1, 0, 0, 0);
  assert.ok(firstFull.includes(ACHIEVEMENTS.FIRST_RATING));
  assert.ok(!firstFull.includes(ACHIEVEMENTS.RATING_20));

  const firstVibe = getBasicAchievements(0, 5, 0, 0);
  assert.ok(firstVibe.includes(ACHIEVEMENTS.FIRST_VIBE));
  assert.ok(!firstVibe.includes(ACHIEVEMENTS.FIRST_RATING), 'FIRST_RATING — только за полную');
});

test('completeness отдаётся везде, где API возвращает рейтинг', async () => {
  const user = await createUser();
  const film = await createFilm('Везде');
  const token = signAccessToken(user._id);

  const created = await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(film._id), vibe: 8 }
  });
  const ratingId = created.json.rating._id;

  const filmResponse = await call(`/api/films/${film._id}`, { token });
  assert.equal(filmResponse.json.userRating.completeness, 'vibe');
  assert.equal(filmResponse.json.userRating.vibeCreatedAt, undefined);

  const myRatings = await call('/api/ratings/user', { token });
  assert.equal(myRatings.json[0].completeness, 'vibe');

  const filmRatings = await call(`/api/films/${film._id}/ratings`);
  assert.equal(filmRatings.json[0].rating.completeness, 'vibe');

  const filmUsers = await call(`/api/films/${film._id}/users`);
  assert.equal(filmUsers.json[0].rating.completeness, 'vibe');

  const details = await call(`/api/ratings/${ratingId}/details`);
  assert.equal(details.json.completeness, 'vibe');

  const profile = await call(`/api/users/${user._id}`);
  assert.equal(profile.json.ratings[0].completeness, 'vibe');
});

test('повторная полная оценка не начисляет баллы второй раз', async () => {
  const user = await createUser();
  const film = await createFilm('Повтор full');
  const token = signAccessToken(user._id);

  await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(film._id), scores: scores(8), vibe: 8 }
  });
  await call('/api/ratings', {
    method: 'POST', token, body: { filmId: String(film._id), scores: scores(9), vibe: 9 }
  });

  const userAfter = await User.findById(user._id);
  assert.equal(userAfter.counters.ratings, 1);
  assert.equal(userAfter.totalPoints, 10);
  assert.equal(await Event.countDocuments({ type: 'rating' }), 1);
});

// ─────────────────────────── MIGRATION ───────────────────────────

test('миграция: completeness full и counters.vibes 0, dry-run и идемпотентность', async () => {
  const { migrate } = require('../scripts/migrate-p1-vibe-ratings');
  const user = await createUser();
  const film = await createFilm('Миграция');

  await Rating.collection.insertOne({
    userId: user._id,
    filmId: film._id,
    vibe: 5,
    technicalScore: 50,
    combinedScore: 50,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  await User.collection.updateOne({ _id: user._id }, { $unset: { 'counters.vibes': 1 } });

  const beforeRead = await call(`/api/films/${film._id}`, { token: signAccessToken(user._id) });
  assert.equal(beforeRead.json.userRating.completeness, 'full', 'старая запись читается как full');

  const dry = await migrate({ dryRun: true, logger: { log() {} } });
  assert.ok(dry.ratingsCount >= 1);
  assert.ok(dry.usersCount >= 1);
  assert.equal((await Rating.collection.findOne({ filmId: film._id })).completeness, undefined);

  const applied = await migrate({ logger: { log() {} } });
  assert.ok(applied.ratingsUpdated >= 1);
  assert.ok(applied.usersUpdated >= 1);

  const ratingRaw = await Rating.collection.findOne({ filmId: film._id });
  assert.equal(ratingRaw.completeness, 'full');
  const userRaw = await User.collection.findOne({ _id: user._id });
  assert.equal(userRaw.counters.vibes, 0);

  const again = await migrate({ dryRun: true, logger: { log() {} } });
  assert.equal(again.ratingsCount, 0);
  assert.equal(again.usersCount, 0);
});
