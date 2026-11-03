// Тесты B8: полиморфные комментарии (film | review).
// Запуск: node --test tests/comment-targets.test.js
// База — in-memory MongoDB, внешний mongod не нужен.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'targets-test-access';
process.env.JWT_REFRESH_SECRET = 'targets-test-refresh';
process.env.TMDB_API_KEY = 'targets-test-tmdb';
process.env.ADMIN_SECRET_KEY = 'targets-test-admin';
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
let Event;
let migrateCommentTarget;

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
    email: `tgt${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `tgt${userSeq}`,
    ...overrides
  });
}

let filmSeq = 0;
async function createFilm(title = 'Фильм') {
  filmSeq += 1;
  return Film.create({ tmdbId: 100000 + filmSeq, title });
}

async function createRating(userId, filmId, completeness = 'vibe') {
  const isFull = completeness === 'full';
  return Rating.create({
    userId, filmId, completeness, vibe: 7,
    technicalScore: isFull ? 60 : 0,
    combinedScore: isFull ? 60 : 0,
    ...(isFull ? { scores: fullScores(8) } : {})
  });
}

async function createReview(userId, filmId, status = 'approved') {
  const rating = await Rating.findOne({ userId, filmId })
    || await createRating(userId, filmId, 'full');

  return Review.create({
    userId, filmId, ratingId: rating._id,
    title: 'Рецензия', text: 'x'.repeat(400), status
  });
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
  dbPath = path.join(process.cwd(), '.mongo-test', `targets-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });

  mongod = await MongoMemoryServer.create({
    instance: { dbPath, launchTimeout: 180000 }
  });
  process.env.MONGODB_URI = mongod.getUri('cinephilium-test-targets');

  await mongoose.connect(process.env.MONGODB_URI);
  const app = require('../src/app');

  User = require('../src/models/User');
  Film = require('../src/models/Film');
  Rating = require('../src/models/Rating');
  Review = require('../src/models/Review');
  Comment = require('../src/models/Comment');
  Event = require('../src/models/Event');
  migrateCommentTarget = require('../scripts/migrate-comment-target').migrate;

  await Promise.all([
    User.init(), Film.init(), Rating.init(), Review.init(), Comment.init(), Event.init()
  ]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User, Film, Rating, Review, Comment, Event].map(Model => Model.deleteMany({})));
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) {
    try { await mongod.stop(); } catch { /* mongod на Windows иногда шумит при остановке */ }
  }
  try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────── КОММЕНТАРИЙ К ФИЛЬМУ (B3 НЕ ТРОНУТ) ───────────────────────────

test('targetType=film без оценки фильма → 403 (гейтинг B3 работает)', async () => {
  const user = await createUser();
  const film = await createFilm('Без оценки');

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(user._id),
    body: { targetType: 'film', targetId: String(film._id), text: 'Мнение' }
  });

  assert.equal(status, 403);
  assert.equal(json.error.code, 'RATING_REQUIRED_FOR_COMMENT');
});

test('targetType=film с vibe → pending, filmId = targetId', async () => {
  const user = await createUser();
  const film = await createFilm('С оценкой');
  await createRating(user._id, film._id);

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(user._id),
    body: { targetType: 'film', targetId: String(film._id), text: 'Комментарий' }
  });

  assert.equal(status, 200);
  assert.equal(json.status, 'pending');
  assert.equal(json.targetType, 'film');
  assert.equal(String(json.targetId), String(film._id));
  assert.equal(String(json.filmId), String(film._id));
});

test('старый формат без targetType трактуется как film', async () => {
  // DECISION B8/compat: задеплоенный фронт шлёт только filmId.
  const user = await createUser();
  const film = await createFilm('Легаси');
  await createRating(user._id, film._id);

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(user._id),
    body: { filmId: String(film._id), text: 'Старый клиент' }
  });

  assert.equal(status, 200);
  assert.equal(json.targetType, 'film');
  assert.equal(String(json.targetId), String(film._id));
});

// ─────────────────────────── КОММЕНТАРИЙ К РЕЦЕНЗИИ ───────────────────────────

test('targetType=review без оценки фильма → 200: гейтинг B3 не применяется', async () => {
  const author = await createUser();
  const reader = await createUser();
  const film = await createFilm('Рецензия');
  const review = await createReview(author._id, film._id);

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(reader._id),
    body: { targetType: 'review', targetId: String(review._id), text: 'Спорно, но интересно' }
  });

  assert.equal(status, 200);
  assert.equal(json.status, 'pending');
  assert.equal(json.targetType, 'review');
  assert.equal(String(json.targetId), String(review._id));
  assert.equal(String(json.filmId), String(film._id), 'filmId не взят из рецензии');
});

test('targetType=review к несуществующей рецензии → 404', async () => {
  const user = await createUser();
  const ghost = new mongoose.Types.ObjectId();

  const { status } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(user._id),
    body: { targetType: 'review', targetId: String(ghost), text: 'Текст' }
  });

  assert.equal(status, 404);
});

test('pending-рецензия: посторонним 404, автору и админу 403 REVIEW_NOT_PUBLISHED', async () => {
  const author = await createUser();
  const stranger = await createUser();
  const admin = await createUser({ isAdmin: true });
  const film = await createFilm('Черновик');
  const review = await createReview(author._id, film._id, 'pending');
  const body = { targetType: 'review', targetId: String(review._id), text: 'Текст' };

  const asStranger = await call('/api/comments', {
    method: 'POST', token: signAccessToken(stranger._id), body
  });
  assert.equal(asStranger.status, 404, 'посторонний узнал о существовании черновика');

  const asAuthor = await call('/api/comments', {
    method: 'POST', token: signAccessToken(author._id), body
  });
  assert.equal(asAuthor.status, 403);
  assert.equal(asAuthor.json.error.code, 'REVIEW_NOT_PUBLISHED');

  const asAdmin = await call('/api/comments', {
    method: 'POST', token: signAccessToken(admin._id), body
  });
  assert.equal(asAdmin.status, 403);
});

test('rejected-рецензия ведёт себя как pending', async () => {
  const author = await createUser();
  const stranger = await createUser();
  const film = await createFilm('Отклонённая');
  const review = await createReview(author._id, film._id, 'rejected');
  const body = { targetType: 'review', targetId: String(review._id), text: 'Текст' };

  const asStranger = await call('/api/comments', {
    method: 'POST', token: signAccessToken(stranger._id), body
  });
  assert.equal(asStranger.status, 404);

  const asAuthor = await call('/api/comments', {
    method: 'POST', token: signAccessToken(author._id), body
  });
  assert.equal(asAuthor.status, 403);
});

test('filmId в теле для review игнорируется: источник истины — рецензия', async () => {
  // DECISION B8/2A.
  const author = await createUser();
  const reader = await createUser();
  const film = await createFilm('Настоящий');
  const otherFilm = await createFilm('Чужой');
  const review = await createReview(author._id, film._id);

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(reader._id),
    body: {
      targetType: 'review',
      targetId: String(review._id),
      filmId: String(otherFilm._id),
      text: 'Текст'
    }
  });

  assert.equal(status, 200);
  assert.equal(String(json.filmId), String(film._id), 'filmId взят из тела, а не из рецензии');
});

// ─────────────────────────── ОТВЕТЫ ───────────────────────────

test('ответ на комментарий другой цели → 400', async () => {
  const author = await createUser();
  const reader = await createUser();
  const film = await createFilm('Ответы');
  const review = await createReview(author._id, film._id);
  const filmComment = await Comment.create({
    userId: author._id, filmId: film._id, text: 'К фильму', status: 'approved'
  });

  const { status } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(reader._id),
    body: {
      targetType: 'review',
      targetId: String(review._id),
      parentId: String(filmComment._id),
      text: 'Скрестить треды'
    }
  });

  assert.equal(status, 400);
  assert.equal(await Comment.countDocuments({ parentId: filmComment._id }), 0);
});

test('ответ на pending-комментарий → 400', async () => {
  const author = await createUser();
  const film = await createFilm('Pending родитель');
  const review = await createReview(author._id, film._id);
  const pending = await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    text: 'Ещё не одобрен', status: 'pending'
  });

  const { status } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(author._id),
    body: {
      targetType: 'review',
      targetId: String(review._id),
      parentId: String(pending._id),
      text: 'Ответ'
    }
  });

  assert.equal(status, 400);
});

test('ответ второго уровня → 400 (один уровень вложенности)', async () => {
  const author = await createUser();
  const film = await createFilm('Два уровня');
  const review = await createReview(author._id, film._id);
  const root = await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    text: 'Корень', status: 'approved'
  });
  const reply = await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    parentId: root._id, text: 'Ответ', status: 'approved'
  });

  const { status } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(author._id),
    body: {
      targetType: 'review',
      targetId: String(review._id),
      parentId: String(reply._id),
      text: 'Третий уровень'
    }
  });

  assert.equal(status, 400);
});

test('ответ на опубликованный комментарий той же цели → 200', async () => {
  const author = await createUser();
  const reader = await createUser();
  const film = await createFilm('Нормальный ответ');
  const review = await createReview(author._id, film._id);
  const root = await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    text: 'Корень', status: 'approved'
  });

  const { status, json } = await call('/api/comments', {
    method: 'POST', token: signAccessToken(reader._id),
    body: {
      targetType: 'review',
      targetId: String(review._id),
      parentId: String(root._id),
      text: 'Согласен'
    }
  });

  assert.equal(status, 200);
  assert.equal(String(json.parentId), String(root._id));
});

// ─────────────────────────── ЧТЕНИЕ ───────────────────────────

test('GET /api/comments?targetType=review: пагинация и ответы', async () => {
  const author = await createUser();
  const film = await createFilm('Список');
  const review = await createReview(author._id, film._id);
  const root = await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    text: 'Корень', status: 'approved'
  });
  await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    parentId: root._id, text: 'Ответ', status: 'approved'
  });
  await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'film', text: 'К фильму', status: 'approved'
  });

  const { status, json } = await call(
    `/api/comments?targetType=review&targetId=${review._id}&page=1&limit=10`
  );

  assert.equal(status, 200);
  assert.equal(json.items.length, 1, 'в тред рецензии попал комментарий к фильму');
  assert.equal(json.items[0].replies.length, 1);
  assert.equal(json.pagination.total, 1);
});

test('GET /api/comments?targetType=film: симметрия', async () => {
  const user = await createUser();
  const film = await createFilm('Симметрия');
  await Comment.create({ userId: user._id, filmId: film._id, text: 'К фильму', status: 'approved' });

  const { status, json } = await call(`/api/comments?targetType=film&targetId=${film._id}`);

  assert.equal(status, 200);
  assert.equal(json.items.length, 1);
  assert.equal(json.items[0].targetType, 'film');
});

test('GET /api/comments без targetType → 400', async () => {
  const { status } = await call('/api/comments?targetId=507f1f77bcf86cd799439011');
  assert.equal(status, 400);
});

test('старый GET /api/comments/:filmId не отдаёт комментарии к рецензиям', async () => {
  // Ключевой тест развилки 3: у комментария к рецензии filmId тоже заполнен.
  const author = await createUser();
  const film = await createFilm('Разделение');
  const review = await createReview(author._id, film._id);
  await Comment.create({ userId: author._id, filmId: film._id, text: 'К фильму', status: 'approved' });
  await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    text: 'К рецензии', status: 'approved'
  });

  const { status, json } = await call(`/api/comments/${film._id}`);

  assert.equal(status, 200);
  assert.ok(Array.isArray(json), 'формат старого роута изменился');
  assert.equal(json.length, 1);
  assert.equal(json[0].text, 'К фильму');
});

test('немигрированный комментарий (без targetType) виден в film-выборке', async () => {
  // DECISION B8/legacy-read: окно «деплой → миграция» не ломает старые данные.
  const user = await createUser();
  const film = await createFilm('Легаси-данные');
  const legacy = await Comment.create({
    userId: user._id, filmId: film._id, text: 'Старый', status: 'approved'
  });
  await Comment.collection.updateOne({ _id: legacy._id }, { $unset: { targetType: '', targetId: '' } });

  const oldRoute = await call(`/api/comments/${film._id}`);
  assert.equal(oldRoute.json.length, 1);

  const newRoute = await call(`/api/comments?targetType=film&targetId=${film._id}`);
  assert.equal(newRoute.json.items.length, 1);
});

test('лайк комментария к рецензии работает и не гейтится', async () => {
  const author = await createUser();
  const liker = await createUser();
  const film = await createFilm('Лайк');
  const review = await createReview(author._id, film._id);
  const comment = await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    text: 'Текст', status: 'approved'
  });

  const { status, json } = await call(`/api/comments/${comment._id}/like`, {
    method: 'POST', token: signAccessToken(liker._id)
  });

  assert.equal(status, 200);
  assert.equal(json.liked, true);
});

// ─────────────────────────── МОДЕРАЦИЯ ───────────────────────────

test('одобрение комментария к рецензии: счётчик растёт, событие НЕ создаётся', async () => {
  const author = await createUser();
  const admin = await createUser({ isAdmin: true });
  const film = await createFilm('Модерация рецензии');
  const review = await createReview(author._id, film._id);
  const comment = await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    text: 'Текст', status: 'pending'
  });

  const { status } = await call(`/api/admin/comments/${comment._id}/approve`, {
    method: 'PUT', token: signAccessToken(admin._id)
  });

  assert.equal(status, 200);
  const fresh = await User.findById(author._id).select('counters');
  assert.equal(fresh.counters.commentsApproved, 1);
  // Считаем только comment-события: achievement-событие от updateAchievements
  // к этому решению отношения не имеет.
  assert.equal(await Event.countDocuments({ type: 'comment' }), 0, 'событие в ленту всё-таки создалось');
});

test('одобрение комментария к фильму по-прежнему создаёт событие', async () => {
  const author = await createUser();
  const admin = await createUser({ isAdmin: true });
  const film = await createFilm('Модерация фильма');
  const comment = await Comment.create({
    userId: author._id, filmId: film._id, text: 'Текст', status: 'pending'
  });

  await call(`/api/admin/comments/${comment._id}/approve`, {
    method: 'PUT', token: signAccessToken(admin._id)
  });

  const events = await Event.find({ type: 'comment' }).lean();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'comment');
});

test('админ-очередь отдаёт targetType', async () => {
  const author = await createUser();
  const admin = await createUser({ isAdmin: true });
  const film = await createFilm('Очередь');
  const review = await createReview(author._id, film._id);
  await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    text: 'На модерации', status: 'pending'
  });

  const { status, json } = await call('/api/admin/pending/comments', {
    token: signAccessToken(admin._id)
  });

  assert.equal(status, 200);
  assert.equal(json[0].targetType, 'review');
});

test('ник автора комментария к рецензии виден (публичный контент)', async () => {
  const author = await createUser({ privacy: { hideProfile: true, hideFromFeed: false } });
  const film = await createFilm('Скрытый автор');
  const review = await createReview(author._id, film._id);
  await Comment.create({
    userId: author._id, filmId: film._id, targetType: 'review', targetId: review._id,
    text: 'Текст', status: 'approved'
  });

  const { json } = await call(`/api/comments?targetType=review&targetId=${review._id}`);
  assert.equal(json.items[0].userId.nickname, author.nickname);
});

// ─────────────────────────── МИГРАЦИЯ ───────────────────────────

test('миграция проставляет targetType и targetId, идемпотентна', async () => {
  const user = await createUser();
  const film = await createFilm('Миграция');
  const legacy = await Comment.create({ userId: user._id, filmId: film._id, text: 'Старый', status: 'approved' });
  await Comment.collection.updateOne({ _id: legacy._id }, { $unset: { targetType: '', targetId: '' } });

  const dry = await migrateCommentTarget({ dryRun: true });
  assert.equal(dry.withoutType, 1);
  const rawAfterDry = await Comment.collection.findOne({ _id: legacy._id });
  assert.equal(rawAfterDry.targetType, undefined, 'dry-run изменил данные');

  const applied = await migrateCommentTarget();
  assert.equal(applied.typed, 1);

  const migrated = await Comment.findById(legacy._id);
  assert.equal(migrated.targetType, 'film');
  assert.equal(String(migrated.targetId), String(film._id));

  const again = await migrateCommentTarget();
  assert.equal(again.withoutType, 0);
  assert.equal(again.typed, 0);
});
