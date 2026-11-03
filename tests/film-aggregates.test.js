// Тесты B2: агрегаты фильма по двум осям (vibe / full).
// Запуск: node --test tests/film-aggregates.test.js
// База — in-memory MongoDB, внешний mongod не нужен.
//
// Что держим: средний вайб считается по всем оценкам, технический и
// комбинированный — только по полным; три счётчика раздельные; в топе участвуют
// только те, у кого есть число по оси; total считает участников; округление
// до десятых единое; легаси averageRating остаётся алиасом среднего технического.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'aggregates-test-access';
process.env.JWT_REFRESH_SECRET = 'aggregates-test-refresh';
process.env.TMDB_API_KEY = 'aggregates-test-tmdb';
process.env.ADMIN_SECRET_KEY = 'aggregates-test-admin';
process.env.CORS_ORIGIN = 'https://film.ru';
process.env.COOKIE_DOMAIN = 'localhost';
process.env.COOKIE_SECURE = 'false';

const { after, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let server;
let baseUrl;
let dbPath;
let User;
let Film;
let Rating;

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
async function createUser() {
  userSeq += 1;
  return User.create({
    email: `agg${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `agg${userSeq}`
  });
}

let filmSeq = 0;
async function createFilm(title = 'Фильм') {
  filmSeq += 1;
  return Film.create({ tmdbId: 800000 + filmSeq, title });
}

/**
 * Оценка кладётся прямо в базу: тестируем агрегаты, а не расчёт баллов.
 * У vibe технический и комбинированный — 0 (маркер «не вычислено»), как в B1.
 */
async function createRating({
  filmId,
  userId,
  completeness = 'full',
  vibe = 8,
  technicalScore = 70,
  combinedScore = 70,
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
  dbPath = path.join(process.cwd(), '.mongo-test', `aggregates-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });

  mongod = await MongoMemoryServer.create({
    instance: { dbPath, launchTimeout: 180000 }
  });
  process.env.MONGODB_URI = mongod.getUri('cinephilium-test-aggregates');

  await mongoose.connect(process.env.MONGODB_URI);
  const app = require('../src/app');

  User = require('../src/models/User');
  Film = require('../src/models/Film');
  Rating = require('../src/models/Rating');

  await Promise.all([User.init(), Film.init(), Rating.init()]);

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User, Film, Rating].map(Model => Model.deleteMany({})));
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) {
    try { await mongod.stop(); } catch { /* mongod на Windows иногда шумит при остановке */ }
  }
  try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────── СРЕДНИЕ И СЧЁТЧИКИ ───────────────────────────

test('смешанный набор: вайб по всем, технический и комбинированный — только по полным', async () => {
  const film = await createFilm('Смешанный');
  const users = [await createUser(), await createUser(), await createUser(), await createUser()];

  await createRating({ filmId: film._id, userId: users[0]._id, vibe: 6, technicalScore: 70, combinedScore: 80 });
  await createRating({ filmId: film._id, userId: users[1]._id, vibe: 7, technicalScore: 74, combinedScore: 82 });
  await createRating({ filmId: film._id, userId: users[2]._id, vibe: 8, technicalScore: 76, combinedScore: 84 });
  await createRating({ filmId: film._id, userId: users[3]._id, completeness: 'vibe', vibe: 10 });

  const { status, json } = await call(`/api/films/${film._id}`);
  assert.equal(status, 200);

  // (70 + 74 + 76) / 3 = 73.33 → 73.3. Старый баг дал бы (70+74+76+0)/4 = 55.
  assert.equal(json.averageTechnical, 73.3, 'vibe-ноль попал в техническое среднее');
  assert.notEqual(json.averageTechnical, 55);
  assert.equal(json.averageCombined, 82);
  // Вайб — по всем: (6 + 7 + 8 + 10) / 4 = 7.75 → 7.8
  assert.equal(json.averageVibe, 7.8);

  assert.equal(json.votesCount, 4, 'votesCount = vibe + full');
  assert.equal(json.vibesCount, 1);
  assert.equal(json.fullCount, 3);
});

test('только vibe: вайб есть, технический и комбинированный — честные нули', async () => {
  const film = await createFilm('Только вайб');
  const user = await createUser();
  await createRating({ filmId: film._id, userId: user._id, completeness: 'vibe', vibe: 9 });

  const { status, json } = await call(`/api/films/${film._id}`);
  assert.equal(status, 200);
  assert.equal(json.averageVibe, 9);
  assert.equal(json.averageTechnical, 0);
  assert.equal(json.averageCombined, 0);
  assert.equal(json.votesCount, 1);
  assert.equal(json.vibesCount, 1);
  assert.equal(json.fullCount, 0);
});

test('только full: все три средних есть, vibe-счётчик нулевой', async () => {
  const film = await createFilm('Только полная');
  const user = await createUser();
  await createRating({
    filmId: film._id, userId: user._id, vibe: 8, technicalScore: 90, combinedScore: 87
  });

  const { json } = await call(`/api/films/${film._id}`);
  assert.equal(json.averageVibe, 8);
  assert.equal(json.averageTechnical, 90);
  assert.equal(json.averageCombined, 87);
  assert.equal(json.votesCount, 1);
  assert.equal(json.vibesCount, 0);
  assert.equal(json.fullCount, 1);
});

test('фильм без единой оценки: нули, страница не падает', async () => {
  const film = await createFilm('Пустой');

  const { status, json } = await call(`/api/films/${film._id}`);
  assert.equal(status, 200);
  assert.equal(json.averageVibe, 0);
  assert.equal(json.averageTechnical, 0);
  assert.equal(json.averageCombined, 0);
  assert.equal(json.votesCount, 0);
  assert.equal(json.vibesCount, 0);
  assert.equal(json.fullCount, 0);
});

test('оценки с нулевым весом не влияют ни на средние, ни на счётчики', async () => {
  const film = await createFilm('С накруткой');
  const honest = await createUser();
  const flagged = await createUser();

  await createRating({
    filmId: film._id, userId: honest._id, vibe: 5, technicalScore: 50, combinedScore: 50
  });
  await createRating({
    filmId: film._id, userId: flagged._id, vibe: 10, technicalScore: 100, combinedScore: 100, weight: 0
  });

  const detail = await call(`/api/films/${film._id}`);
  assert.equal(detail.json.averageTechnical, 50);
  assert.equal(detail.json.averageCombined, 50);
  assert.equal(detail.json.averageVibe, 5);
  assert.equal(detail.json.votesCount, 1, 'помеченная оценка попала в votesCount');
  assert.equal(detail.json.fullCount, 1);

  const catalog = await call('/api/films?sort=technical&limit=100');
  const item = catalog.json.films.find(f => String(f._id) === String(film._id));
  assert.equal(item.averageTechnical, 50);
  assert.equal(item.votesCount, 1);
});

test('фильм, где все оценки с нулевым весом, выпадает из топа и из каталога не исчезает', async () => {
  const film = await createFilm('Только накрутка');
  const flagged = await createUser();
  await createRating({
    filmId: film._id, userId: flagged._id, technicalScore: 100, combinedScore: 100, weight: 0
  });

  const top = await call('/api/films/top?sort=technical');
  assert.equal(top.json.films.length, 0);
  assert.equal(top.json.total, 0);

  const catalog = await call('/api/films?sort=technical&limit=100');
  const item = catalog.json.films.find(f => String(f._id) === String(film._id));
  assert.ok(item, 'фильм должен остаться в каталоге');
  assert.equal(item.averageTechnical, null);
  assert.equal(item.votesCount, 0);
});

// ─────────────────────────── СПИСКИ И ТОПЫ ───────────────────────────

test('топ по техническому не содержит фильмов без полных оценок, топ по вайбу — содержит', async () => {
  const fullFilm = await createFilm('Глубокий');
  const vibeFilm = await createFilm('Вайбовый');
  const userA = await createUser();
  const userB = await createUser();

  await createRating({
    filmId: fullFilm._id, userId: userA._id, vibe: 8, technicalScore: 50, combinedScore: 41
  });
  await createRating({ filmId: vibeFilm._id, userId: userB._id, completeness: 'vibe', vibe: 10 });

  const technical = await call('/api/films/top?sort=technical&limit=20');
  const technicalIds = technical.json.films.map(f => String(f._id));
  assert.deepEqual(technicalIds, [String(fullFilm._id)]);
  assert.equal(technical.json.total, 1);

  const vibe = await call('/api/films/top?sort=vibe&limit=20');
  const vibeIds = vibe.json.films.map(f => String(f._id));
  assert.equal(vibeIds.length, 2);
  assert.equal(vibeIds[0], String(vibeFilm._id), 'вайбовый фильм должен быть первым');
  assert.equal(vibe.json.total, 2);
});

test('total в топе считает участников фильтра, а не все фильмы базы', async () => {
  const rated = await createFilm('Оценённый');
  await createFilm('Неоценённый 1');
  await createFilm('Неоценённый 2');
  const user = await createUser();
  await createRating({ filmId: rated._id, userId: user._id, technicalScore: 60, combinedScore: 60 });

  const top = await call('/api/films/top?sort=technical&limit=20');
  assert.equal(top.json.films.length, 1);
  assert.equal(top.json.total, 1);

  const catalog = await call('/api/films?limit=100');
  assert.equal(catalog.json.pagination.total, 3, 'каталог по-прежнему показывает все фильмы');
});

test('пустой топ отдаётся пустым и предлагает vibe-топ только когда там есть что смотреть', async () => {
  const vibeFilm = await createFilm('Вайбовый');
  const user = await createUser();
  await createRating({ filmId: vibeFilm._id, userId: user._id, completeness: 'vibe', vibe: 7 });

  const technical = await call('/api/films/top?sort=technical');
  assert.equal(technical.json.films.length, 0);
  assert.equal(technical.json.total, 0);
  assert.equal(technical.json.fallback.sort, 'vibe');
  assert.equal(technical.json.fallback.available, true);

  await Rating.deleteMany({});
  const empty = await call('/api/films/top?sort=technical');
  assert.equal(empty.json.films.length, 0);
  assert.equal(empty.json.total, 0);
  assert.equal(empty.json.fallback.available, false, 'обещать vibe-топ на пустой базе нельзя');

  // На самом vibe-топе подсказка про вайб бессмысленна.
  await createRating({ filmId: vibeFilm._id, userId: user._id, completeness: 'vibe', vibe: 7 });
  const vibe = await call('/api/films/top?sort=vibe');
  assert.equal(vibe.json.films.length, 1);
  assert.equal(vibe.json.fallback.available, false);
});

test('каталог показывает фильм без оценок в конце, со null в средних', async () => {
  const rated = await createFilm('Оценённый');
  const unrated = await createFilm('Свежий импорт');
  const user = await createUser();
  await createRating({ filmId: rated._id, userId: user._id, technicalScore: 70, combinedScore: 70 });

  const { json } = await call('/api/films?sort=technical&limit=100');
  assert.equal(json.films.length, 2);
  assert.equal(String(json.films[0]._id), String(rated._id), 'оценённый фильм должен идти первым');

  const fresh = json.films.find(f => String(f._id) === String(unrated._id));
  assert.ok(fresh, 'неоценённый фильм должен остаться в каталоге');
  assert.equal(fresh.averageTechnical, null, 'в каталоге отсутствие числа — null, не 0');
  assert.equal(fresh.averageVibe, null);
  assert.equal(fresh.votesCount, 0);
  assert.equal(fresh.fullCount, 0);
});

test('sort=new отдаёт свежие импорты первыми и считает total по всей базе', async () => {
  const older = await createFilm('Старый');
  const newer = await createFilm('Новый');

  const { json } = await call('/api/films?sort=new&limit=100');
  assert.equal(json.sort, 'createdAt');
  assert.equal(json.pagination.total, 2);
  assert.equal(String(json.films[0]._id), String(newer._id));
  assert.equal(String(json.films[1]._id), String(older._id));
});

// ─────────────────────────── ОКРУГЛЕНИЕ И ЛЕГАСИ ───────────────────────────

test('округление до десятых одинаково на странице, в каталоге и в топе', async () => {
  const film = await createFilm('Дробный');
  const users = [await createUser(), await createUser(), await createUser()];
  // (70 + 70 + 71) / 3 = 70.333... → 70.3
  await createRating({ filmId: film._id, userId: users[0]._id, technicalScore: 70, combinedScore: 70 });
  await createRating({ filmId: film._id, userId: users[1]._id, technicalScore: 70, combinedScore: 70 });
  await createRating({ filmId: film._id, userId: users[2]._id, technicalScore: 71, combinedScore: 71 });

  const detail = await call(`/api/films/${film._id}`);
  const catalog = await call('/api/films?sort=technical&limit=100');
  const top = await call('/api/films/top?sort=technical&limit=20');

  const fromCatalog = catalog.json.films.find(f => String(f._id) === String(film._id));
  const fromTop = top.json.films.find(f => String(f._id) === String(film._id));

  assert.equal(detail.json.averageTechnical, 70.3);
  assert.equal(fromCatalog.averageTechnical, 70.3);
  assert.equal(fromTop.averageTechnical, 70.3);
  assert.equal(detail.json.averageCombined, 70.3);
  assert.equal(fromCatalog.averageCombined, 70.3);
});

test('averageRating остаётся алиасом averageTechnical на странице, в каталоге и в топе', async () => {
  const film = await createFilm('Алиас');
  const user = await createUser();
  await createRating({ filmId: film._id, userId: user._id, technicalScore: 64, combinedScore: 64 });

  const detail = await call(`/api/films/${film._id}`);
  assert.equal(detail.json.averageRating, detail.json.averageTechnical);
  assert.equal(detail.json.averageRating, 64);

  const catalog = await call('/api/films?limit=100');
  const fromCatalog = catalog.json.films.find(f => String(f._id) === String(film._id));
  assert.equal(fromCatalog.averageRating, fromCatalog.averageTechnical);

  const top = await call('/api/films/top?sort=technical&limit=20');
  assert.equal(top.json.films[0].averageRating, top.json.films[0].averageTechnical);
});

test('у неоценённого фильма алиас тоже null в каталоге и 0 на странице', async () => {
  const film = await createFilm('Без оценок');

  const detail = await call(`/api/films/${film._id}`);
  assert.equal(detail.json.averageRating, 0);
  assert.equal(detail.json.averageTechnical, 0);

  const catalog = await call('/api/films?limit=100');
  const item = catalog.json.films.find(f => String(f._id) === String(film._id));
  assert.equal(item.averageRating, null);
  assert.equal(item.averageTechnical, null);
});
