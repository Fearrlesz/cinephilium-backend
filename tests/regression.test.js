process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/cinephilium-test-regression';
process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';
process.env.CORS_ORIGIN = 'https://film.ru';
process.env.COOKIE_DOMAIN = 'localhost';
process.env.COOKIE_SECURE = 'false';
process.env.IMAGE_PROXY_BASE_URL = 'https://film.ru';

const { after, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const app = require('../src/app');
const User = require('../src/models/User');
const Film = require('../src/models/Film');
const Rating = require('../src/models/Rating');
const Review = require('../src/models/Review');
const Comment = require('../src/models/Comment');
const Event = require('../src/models/Event');
const Action = require('../src/models/Action');
const Session = require('../src/models/Session');
const { signAccessToken } = require('../src/utils/jwt');
const mailer = require('../src/services/mailer');

let server;
let baseUrl;
let ipCounter = 1;
const verificationCodes = new Map();
const originalSendVerificationCode = mailer.sendVerificationCode;

const MODELS = [User, Film, Rating, Review, Comment, Event, Action, Session];

function nextIp() {
  ipCounter += 1;
  return `203.0.113.${(ipCounter % 250) + 1}`;
}

async function call(path, { method = 'GET', body, token, cookies, headers = {} } = {}) {
  const requestHeaders = { 'x-forwarded-for': nextIp(), ...headers };
  if (body !== undefined && !requestHeaders['content-type']) {
    requestHeaders['content-type'] = 'application/json';
  }
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (cookies) requestHeaders.cookie = cookies;

  const res = await fetch(baseUrl + path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return {
    status: res.status,
    text,
    json,
    headers: res.headers,
    setCookie: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  };
}

function refreshCookieOf(response) {
  const raw = response.setCookie.find(cookie => cookie.startsWith('refresh_token='));
  return raw ? raw.split(';')[0] : null;
}

async function clean() {
  await Promise.all(MODELS.map(Model => Model.deleteMany({})));
  verificationCodes.clear();
}

let userSeq = 0;
async function createUser(overrides = {}) {
  userSeq += 1;
  return User.create({
    email: `user${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `user${userSeq}`,
    emailVerified: true,
    ...overrides
  });
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

async function createRating(userId, filmId) {
  return Rating.create({
    userId, filmId, genrePreset: null,
    blockWeights: { scenario: 30, characters: 25, visual: 20, sound: 15, style: 10 },
    scores: scores(), vibe: 5, technicalScore: 50, combinedScore: 50,
    textReview: '', likes: []
  });
}

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Перехватываем письма, чтобы тесты знали код подтверждения.
  mailer.sendVerificationCode = async (email, code) => {
    verificationCodes.set(email, code);
    return { ok: true };
  };
});

beforeEach(clean);

after(async () => {
  mailer.sendVerificationCode = originalSendVerificationCode;
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
});

// ─────────────────────────── AUTH ───────────────────────────

test('регистрация: 201, код на почту, вход запрещён до подтверждения', async () => {
  const registered = await call('/api/auth/register', {
    method: 'POST',
    body: { email: 'new@example.com', password: 'password123', nickname: 'Новичок' }
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.json.user.emailVerified, false);
  assert.equal(registered.json.accessToken, undefined);
  assert.ok(verificationCodes.get('new@example.com'), 'код не был отправлен');

  const blocked = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'new@example.com', password: 'password123' }
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'EMAIL_NOT_VERIFIED');

  const wrong = await call('/api/auth/verify-email', {
    method: 'POST',
    body: { email: 'new@example.com', code: '000000' }
  });
  assert.equal(wrong.status, 400);

  const verified = await call('/api/auth/verify-email', {
    method: 'POST',
    body: { email: 'new@example.com', code: verificationCodes.get('new@example.com') }
  });
  assert.equal(verified.status, 200);
  assert.ok(verified.json.accessToken);
  assert.ok(refreshCookieOf(verified), 'refresh-cookie не выставлена');
});

test('логин, /me, ротация refresh и выход', async () => {
  await createUser({ email: 'login@example.com' });

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'login@example.com', password: 'password123' }
  });
  assert.equal(login.status, 200);
  const accessToken = login.json.accessToken;
  const cookie = refreshCookieOf(login);
  assert.ok(cookie);

  const me = await call('/api/auth/me', { token: accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, 'login@example.com');
  assert.equal(me.json.password, undefined);

  const rotated = await call('/api/auth/refresh', { method: 'POST', cookies: cookie });
  assert.equal(rotated.status, 200);
  const rotatedCookie = refreshCookieOf(rotated);
  assert.ok(rotatedCookie);
  assert.notEqual(rotatedCookie, cookie, 'refresh-токен не ротировался');

  const reuse = await call('/api/auth/refresh', { method: 'POST', cookies: cookie });
  assert.equal(reuse.status, 401, 'старый refresh должен быть отозван');

  const loggedOut = await call('/api/auth/logout', { method: 'POST', cookies: rotatedCookie });
  assert.equal(loggedOut.status, 200);
  const afterLogout = await call('/api/auth/refresh', { method: 'POST', cookies: rotatedCookie });
  assert.equal(afterLogout.status, 401);
});

test('неподтверждённый пользователь не может ставить оценку', async () => {
  const user = await createUser({ emailVerified: false });
  const film = await Film.create({ tmdbId: 900, title: 'Фильм' });

  const response = await call('/api/ratings', {
    method: 'POST',
    token: signAccessToken(user._id),
    body: { filmId: String(film._id), scores: scores(), vibe: 5 }
  });
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'EMAIL_NOT_VERIFIED');
});

// ─────────────────────────── FILMS ───────────────────────────

test('поиск по названию не падает на спецсимволах и ReDoS-паттерне', async () => {
  await Film.create({ tmdbId: 1, title: 'Начало' });

  const bracket = await call('/api/films/search-by-title?title=%5B');
  assert.notEqual(bracket.status, 500, 'неэкранированная регулярка уронила запрос');
  assert.equal(bracket.status, 404);

  const redos = await call('/api/films/search-by-title?title=' + encodeURIComponent('(a+)+$'));
  assert.equal(redos.status, 404);

  const found = await call('/api/films/search-by-title?title=' + encodeURIComponent('нач'));
  assert.equal(found.status, 200);
  assert.equal(found.json.title, 'Начало');
});

test('список фильмов ограничивает limit и корректно чинит отрицательный page', async () => {
  await Film.create({ tmdbId: 2, title: 'Фильм' });

  const response = await call('/api/films?limit=100000&page=-5');
  assert.equal(response.status, 200);
  assert.equal(response.json.pagination.limit, 100);
  assert.equal(response.json.pagination.page, 1);
});

test('детали фильма отдают posterUrl из posterPath', async () => {
  const film = await Film.create({ tmdbId: 3, title: 'Постер', posterPath: '/x.jpg' });

  const response = await call(`/api/films/${film._id}`);
  assert.equal(response.status, 200);
  assert.equal(response.json.posterUrl, 'https://film.ru/api/tmdb-image?size=w500&path=%2Fx.jpg');
});

test('прокси постеров смонтирован в Express и валидирует вход', async () => {
  const traversal = await call('/api/tmdb-image?path=' + encodeURIComponent('../etc/passwd'));
  assert.equal(traversal.status, 400);

  const badSize = await call('/api/tmdb-image?path=%2Fx.jpg&size=huge');
  assert.equal(badSize.status, 400);
});

test('ошибки TMDB транслируются в 404 и 502, а не в 500', async () => {
  const user = await createUser();
  const token = signAccessToken(user._id);
  const realFetch = global.fetch;

  try {
    global.fetch = async (url, options) => String(url).includes('api.themoviedb.org')
      ? new Response('{}', { status: 404 })
      : realFetch(url, options);
    const notFound = await call('/api/films/import', { method: 'POST', token, body: { tmdbId: 999 } });
    assert.equal(notFound.status, 404);

    global.fetch = async (url, options) => String(url).includes('api.themoviedb.org')
      ? new Response('{}', { status: 500 })
      : realFetch(url, options);
    const down = await call('/api/films/import', { method: 'POST', token, body: { tmdbId: 999 } });
    assert.equal(down.status, 502);
  } finally {
    global.fetch = realFetch;
  }
});

// ─────────────────────────── RATINGS ───────────────────────────

test('оценка начисляет счётчик и баллы ровно один раз', async () => {
  const user = await createUser();
  const film = await Film.create({ tmdbId: 4, title: 'Фильм' });
  const token = signAccessToken(user._id);
  const payload = { filmId: String(film._id), scores: scores(10), vibe: 10, genrePreset: 'comedy' };

  const created = await call('/api/ratings', { method: 'POST', token, body: payload });
  assert.equal(created.status, 201);
  assert.equal(created.json.technicalScore, 100);
  assert.equal(created.json.combinedScore, 100);

  let stored = await User.findById(user._id);
  assert.equal(stored.counters.ratings, 1);
  assert.equal(stored.totalPoints, 10);

  const updated = await call('/api/ratings', { method: 'POST', token, body: payload });
  assert.equal(updated.status, 201);

  stored = await User.findById(user._id);
  assert.equal(stored.counters.ratings, 1, 'счётчик оценок увеличен повторно');
  assert.equal(stored.totalPoints, 10, 'баллы начислены повторно');
  assert.equal(await Rating.countDocuments({ userId: user._id }), 1);
});

test('слишком длинный textReview даёт 400, а не 500', async () => {
  const user = await createUser();
  const film = await Film.create({ tmdbId: 5, title: 'Фильм' });

  const response = await call('/api/ratings', {
    method: 'POST',
    token: signAccessToken(user._id),
    body: { filmId: String(film._id), scores: scores(), vibe: 5, textReview: 'x'.repeat(2001) }
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'VALIDATION_ERROR');
});

// ─────────────────────────── REVIEWS ───────────────────────────

test('черновик рецензии не виден чужим, но виден автору и админу', async () => {
  const author = await createUser();
  const stranger = await createUser();
  const admin = await createUser({ isAdmin: true });
  const film = await Film.create({ tmdbId: 6, title: 'Фильм' });
  const rating = await createRating(author._id, film._id);

  const created = await call('/api/reviews', {
    method: 'POST',
    token: signAccessToken(author._id),
    body: {
      filmId: String(film._id), ratingId: String(rating._id),
      title: 'Заголовок', text: 'x'.repeat(500)
    }
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.status, 'pending');

  const authorAfter = await User.findById(author._id);
  assert.equal(authorAfter.counters.reviews, 1);

  const reviewId = created.json._id;
  assert.equal((await call(`/api/reviews/details/${reviewId}`)).status, 404);
  assert.equal((await call(`/api/reviews/details/${reviewId}`, { token: signAccessToken(stranger._id) })).status, 404);
  assert.equal((await call(`/api/reviews/details/${reviewId}`, { token: signAccessToken(author._id) })).status, 200);
  assert.equal((await call(`/api/reviews/details/${reviewId}`, { token: signAccessToken(admin._id) })).status, 200);
});

test('публичный профиль не показывает чужие черновики', async () => {
  const author = await createUser();
  const film = await Film.create({ tmdbId: 7, title: 'Фильм' });
  const rating = await createRating(author._id, film._id);
  await Review.create({
    userId: author._id, filmId: film._id, ratingId: rating._id,
    title: 'Черновик', text: 'x'.repeat(500), status: 'pending'
  });

  const anonymous = await call(`/api/users/${author._id}`);
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.json.reviews.length, 0, 'аноним видит черновики');

  const owner = await call(`/api/users/${author._id}`, { token: signAccessToken(author._id) });
  assert.equal(owner.json.reviews.length, 1);
});

test('ответ на комментарий другого фильма отклоняется', async () => {
  const user = await createUser();
  const filmA = await Film.create({ tmdbId: 8, title: 'A' });
  const filmB = await Film.create({ tmdbId: 9, title: 'B' });
  const parent = await Comment.create({
    userId: user._id, filmId: filmA._id, text: 'родитель', status: 'approved'
  });
  const token = signAccessToken(user._id);

  const foreign = await call('/api/comments', {
    method: 'POST', token,
    body: { filmId: String(filmB._id), text: 'ответ', parentId: String(parent._id) }
  });
  assert.equal(foreign.status, 400);

  const own = await call('/api/comments', {
    method: 'POST', token,
    body: { filmId: String(filmA._id), text: 'ответ', parentId: String(parent._id) }
  });
  assert.equal(own.status, 200);
});

// ─────────────────────────── ADMIN ───────────────────────────

test('повторное одобрение не начисляет баллы и не плодит события', async () => {
  const author = await createUser();
  const admin = await createUser({ isAdmin: true });
  const film = await Film.create({ tmdbId: 10, title: 'Фильм' });
  const comment = await Comment.create({
    userId: author._id, filmId: film._id, text: 'комментарий', status: 'pending'
  });
  const token = signAccessToken(admin._id);

  const first = await call(`/api/admin/comments/${comment._id}/approve`, { method: 'PUT', token });
  assert.equal(first.status, 200);
  assert.equal((await User.findById(author._id)).totalPoints, 2);

  const second = await call(`/api/admin/comments/${comment._id}/approve`, { method: 'PUT', token });
  assert.equal(second.status, 200);
  assert.equal((await User.findById(author._id)).totalPoints, 2, 'баллы начислены повторно');
  assert.equal(await Event.countDocuments({ type: 'comment' }), 1, 'событие создано повторно');
  assert.equal((await User.findById(author._id)).counters.commentsApproved, 1);
});

test('кривой id в модерации даёт 400, а не 500', async () => {
  const admin = await createUser({ isAdmin: true });
  const response = await call('/api/admin/comments/not-an-id/approve', {
    method: 'PUT', token: signAccessToken(admin._id)
  });
  assert.equal(response.status, 400);
});

// ─────────────────────────── TOP / ERRORS / CORS ───────────────────────────

test('топ пользователей: пагинация, без пароля, limit ограничен', async () => {
  await createUser({ nickname: 'low', totalPoints: 5 });
  await createUser({ nickname: 'high', totalPoints: 50 });

  const response = await call('/api/top/users?limit=1');
  assert.equal(response.status, 200);
  assert.equal(response.json.items.length, 1);
  assert.equal(response.json.items[0].nickname, 'high');
  assert.equal(response.json.items[0].password, undefined);
  assert.equal(response.json.pagination.total, 2);

  const capped = await call('/api/top/users?limit=1000');
  assert.equal(capped.json.pagination.limit, 100);
});

test('404 и битый JSON — это JSON, чужой origin не получает CORS-заголовок', async () => {
  const notFound = await call('/api/nope');
  assert.equal(notFound.status, 404);
  assert.match(notFound.headers.get('content-type') || '', /json/);

  const brokenJson = await call('/api/auth/login', {
    method: 'POST',
    body: '{"email":',
    headers: { 'content-type': 'application/json' }
  });
  assert.equal(brokenJson.status, 400);
  assert.equal(brokenJson.json.error.code, 'INVALID_JSON');

  const evil = await call('/api/health', { headers: { origin: 'https://evil.example.com' } });
  assert.equal(evil.status, 200);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const allowed = await call('/api/health', { headers: { origin: 'https://film.ru' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://film.ru');
});
