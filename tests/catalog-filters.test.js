process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'catalog-filter-test-access';
process.env.JWT_REFRESH_SECRET = 'catalog-filter-test-refresh';
process.env.TMDB_API_KEY = 'catalog-filter-test-tmdb';
process.env.ADMIN_SECRET_KEY = 'catalog-filter-test-admin';
process.env.CORS_ORIGIN = 'https://film.ru';
process.env.COOKIE_DOMAIN = 'localhost';
process.env.COOKIE_SECURE = 'false';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let server;
let baseUrl;
let dbPath;

async function get(endpoint) {
  const response = await fetch(baseUrl + endpoint);
  const data = await response.json();
  return { status: response.status, data };
}

before(async () => {
  dbPath = path.join(process.cwd(), '.mongo-test', `catalog-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dbPath, { recursive: true });
  mongod = await MongoMemoryServer.create({ instance: { dbPath, launchTimeout: 180000 } });
  process.env.MONGODB_URI = mongod.getUri('cinephilium');
  await mongoose.connect(process.env.MONGODB_URI);
  const app = require('../src/app');
  const Film = require('../src/models/Film');
  const Rating = require('../src/models/Rating');
  const User = require('../src/models/User');

  const user = await User.create({
    email: 'catalog@example.com',
    password: 'hash',
    nickname: 'catalog'
  });
  const rows = [
    ['Alpha', 2001, ['Drama'], 8],
    ['Beta', 2005, ['Comedy'], 7],
    ['Gamma', 2010, ['Drama'], 6],
    ['Delta', 1999, ['Horror'], null],
    ['Epsilon', 2020, ['Drama'], null]
  ];
  for (const [title, year, genres, score] of rows) {
    const film = await Film.create({ tmdbId: 900000 + year, title, year, genres });
    if (score) {
      await Rating.create({
        userId: user._id,
        filmId: film._id,
        completeness: 'vibe',
        vibe: score
      });
    }
  }

  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  if (dbPath) fs.rmSync(dbPath, { recursive: true, force: true });
});

test('q filters by escaped title substring', async () => {
  const { status, data } = await get('/api/films?q=alp');
  assert.equal(status, 200);
  assert.deepEqual(data.films.map(f => f.title), ['Alpha']);
  assert.equal(data.pagination.total, 1);
});

test('q escapes regex metacharacters instead of throwing', async () => {
  const { status, data } = await get('/api/films?q=%5B');
  assert.equal(status, 200);
  assert.equal(data.films.length, 0);
  assert.equal(data.pagination.total, 0);
});

test('genre and year range filter the result and total', async () => {
  const drama = await get('/api/films?genre=Drama&limit=50');
  assert.deepEqual(drama.data.films.map(f => f.title).sort(), ['Alpha', 'Epsilon', 'Gamma']);
  assert.equal(drama.data.pagination.total, 3);

  const years = await get('/api/films?yearFrom=2005&yearTo=2010&limit=50');
  assert.deepEqual(years.data.films.map(f => f.title).sort(), ['Beta', 'Gamma']);
  assert.equal(years.data.pagination.total, 2);
});

test('rated filters with and without ratings', async () => {
  const rated = await get('/api/films?rated=1&limit=50');
  assert.deepEqual(rated.data.films.map(f => f.title).sort(), ['Alpha', 'Beta', 'Gamma']);
  const unrated = await get('/api/films?rated=0&limit=50');
  assert.deepEqual(unrated.data.films.map(f => f.title).sort(), ['Delta', 'Epsilon']);
});

test('sort=title and sort=new are stable and paginated', async () => {
  const title = await get('/api/films?sort=title&limit=2&page=1');
  assert.deepEqual(title.data.films.map(f => f.title), ['Alpha', 'Beta']);
  assert.equal(title.data.pagination.pages, 3);

  const fresh = await get('/api/films?sort=new&limit=2&page=1');
  assert.deepEqual(fresh.data.films.map(f => f.title), ['Epsilon', 'Delta']);
});

test('facets returns genre counts and year min/max', async () => {
  const { status, data } = await get('/api/films/facets');
  assert.equal(status, 200);
  const drama = data.genres.find(item => item.value === 'Drama');
  assert.equal(drama.count, 3);
  assert.equal(data.years.min, 1999);
  assert.equal(data.years.max, 2020);
});
