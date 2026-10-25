process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/cinephilium-test-regression';
process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';
process.env.CORS_ORIGIN = 'https://film.ru';
process.env.COOKIE_DOMAIN = 'localhost';
process.env.COOKIE_SECURE = 'false';
// Бэкенд и фронтенд — разные домены: прокси постеров живёт на домене бэкенда.
process.env.IMAGE_PROXY_BASE_URL = 'https://api.film.ru';

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
const { generateInviteCode, hashToken } = require('../src/utils/tokens');
const { flagSybilAccounts } = require('../scripts/flag-sybil-accounts');
const Invite = require('../src/models/Invite');

let server;
let baseUrl;
let ipCounter = 1;

const MODELS = [User, Film, Rating, Review, Comment, Event, Action, Session, Invite];

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
}

// Инвайт создаём прямо в базе: админский API покрыт отдельным файлом тестов.
async function createInvite(overrides = {}) {
  const code = generateInviteCode();
  await Invite.create({
    codeHash: hashToken(code.replace('-', '')),
    codePrefix: code.slice(0, 4),
    ...overrides
  });
  return code;
}

let userSeq = 0;
async function createUser(overrides = {}) {
  userSeq += 1;
  return User.create({
    email: `user${userSeq}@example.com`,
    password: await bcrypt.hash('password123', 4),
    nickname: `user${userSeq}`,
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
});

beforeEach(clean);

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
});

// ─────────────────────────── AUTH ───────────────────────────

test('регистрация по инвайту: сразу токен, повторный код не срабатывает', async () => {
  await createUser(); // база не пустая — бутстрап-режим выключен
  const code = await createInvite();

  const registered = await call('/api/auth/register', {
    method: 'POST',
    body: {
      nickname: 'Новичок',
      password: 'password123',
      inviteCode: code.toLowerCase(),
      consent: { personalData: true, cookies: true }
    }
  });
  assert.equal(registered.status, 201);
  assert.ok(registered.json.accessToken, 'аккаунт должен входить сразу, без подтверждений');
  assert.ok(refreshCookieOf(registered), 'refresh-cookie не выставлена');

  const invite = await Invite.findOne({ codePrefix: code.slice(0, 4) });
  assert.ok(invite.usedAt, 'инвайт не помечен использованным');
  assert.equal(invite.usedBy.toString(), registered.json.user.id);

  const reuse = await call('/api/auth/register', {
    method: 'POST',
    body: {
      nickname: 'Второй',
      password: 'password123',
      inviteCode: code,
      consent: { personalData: true, cookies: true }
    }
  });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.json.error.code, 'INVITE_USED');
});

test('без инвайта регистрация закрыта, код нужен реальный', async () => {
  await createUser();

  const noCode = await call('/api/auth/register', {
    method: 'POST',
    body: {
      nickname: 'Без кода',
      password: 'password123',
      consent: { personalData: true, cookies: true }
    }
  });
  assert.equal(noCode.status, 403);
  assert.equal(noCode.json.error.code, 'INVITE_REQUIRED');

  const fakeCode = await call('/api/auth/register', {
    method: 'POST',
    body: {
      nickname: 'С фейком',
      password: 'password123',
      inviteCode: 'AAAA-BBBB',
      consent: { personalData: true, cookies: true }
    }
  });
  assert.equal(fakeCode.status, 400);
  assert.equal(fakeCode.json.error.code, 'INVITE_INVALID');

  assert.equal(await User.countDocuments({}), 1, 'неудачные попытки не должны создавать аккаунты');
});

test('первый пользователь пустой базы становится админом без инвайта', async () => {
  const first = await call('/api/auth/register', {
    method: 'POST',
    body: {
      nickname: 'Основатель',
      password: 'password123',
      consent: { personalData: true, cookies: true }
    }
  });
  assert.equal(first.status, 201);
  assert.equal(first.json.user.isAdmin, true);
});

test('логин, /me, ротация refresh и выход', async () => {
  const user = await createUser({ email: 'login@example.com' });

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { nickname: user.nickname, password: 'password123' }
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

test('неверный пароль не пускает, пользователь без почты оценивает фильмы', async () => {
  const user = await createUser({ email: undefined });
  const film = await Film.create({ tmdbId: 900, title: 'Фильм' });

  const wrong = await call('/api/auth/login', {
    method: 'POST',
    body: { nickname: user.nickname, password: 'wrong-password' }
  });
  assert.equal(wrong.status, 401);

  const rated = await call('/api/ratings', {
    method: 'POST',
    token: signAccessToken(user._id),
    body: { filmId: String(film._id), scores: scores(), vibe: 5 }
  });
  assert.equal(rated.status, 201, 'аккаунт без почты должен иметь полный доступ');
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
  assert.equal(response.json.posterUrl, 'https://api.film.ru/api/tmdb-image?size=w500&path=%2Fx.jpg');
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

// ─────────────── СОВМЕСТИМОСТЬ С ФРОНТЕНДОМ ───────────────

test('легаси-поле poster заполняется готовым URL', async () => {
  const film = await Film.create({ tmdbId: 11, title: 'Легаси', posterPath: '/y.jpg' });

  const response = await call(`/api/films/${film._id}`);
  assert.equal(response.status, 200);
  assert.equal(response.json.posterUrl, 'https://api.film.ru/api/tmdb-image?size=w500&path=%2Fy.jpg');
  assert.equal(response.json.poster, response.json.posterUrl, 'старый клиент не получит poster');
});

test('профиль доступен по никнейму', async () => {
  const user = await createUser({ nickname: 'Критик' });

  const byNickname = await call('/api/users/nickname/' + encodeURIComponent('Критик'));
  assert.equal(byNickname.status, 200);
  assert.equal(byNickname.json.nickname, 'Критик');
  assert.equal(String(byNickname.json._id), String(user._id));

  assert.equal((await call('/api/users/nickname/nobody-here')).status, 404);
});

test('/users/me/achievements отдаёт earned и totalPoints', async () => {
  const user = await createUser();

  assert.equal((await call('/api/users/me/achievements')).status, 401);

  const response = await call('/api/users/me/achievements', { token: signAccessToken(user._id) });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.json.earned));
  assert.ok(Array.isArray(response.json.possible));
  assert.equal(response.json.totalPoints, 0);
  assert.equal(response.json.progress.ratings, 0);
});

test('алиас /api/poster/:size/* валидирует размер', async () => {
  const badSize = await call('/api/poster/huge/x.jpg');
  assert.equal(badSize.status, 400);
});

test('сквозной сценарий фронтенда: регистрация → оценка → рецензия → модерация', async () => {
  await createUser();
  const inviteCode = await createInvite();

  const registered = await call('/api/auth/register', {
    method: 'POST',
    body: {
      nickname: 'Путешественник', password: 'password123', inviteCode,
      consent: { personalData: true, cookies: true }
    }
  });
  assert.equal(registered.status, 201);

  const token = registered.json.accessToken;
  const cookie = refreshCookieOf(registered);
  assert.ok(token);

  const me = await call('/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.ok(me.json._id);

  const film = await Film.create({ tmdbId: 777, title: 'Сквозной', posterPath: '/z.jpg' });

  const list = await call('/api/films?page=1&limit=20&sort=technical');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.films));

  const top = await call('/api/films/top?sort=combined&limit=5');
  assert.equal(top.status, 200);
  assert.ok(Array.isArray(top.json.films));

  const detail = await call(`/api/films/${film._id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.json.poster, 'poster пустой — фронт покажет заглушку');
  assert.ok(detail.json.posterUrl);

  const filmUsers = await call(`/api/films/${film._id}/users`);
  assert.ok(Array.isArray(filmUsers.json));

  const rated = await call('/api/ratings', {
    method: 'POST', token,
    body: {
      filmId: String(film._id),
      scores: scores(9),
      vibe: 7,
      genrePreset: 'drama',
      blockWeights: [25, 20, 20, 15, 20],
      textReview: 'Хорошо'
    }
  });
  assert.equal(rated.status, 201);

  const detailAfter = await call(`/api/films/${film._id}`, { token });
  assert.ok(detailAfter.json.userRating, 'userRating не вернулся фронту');

  const review = await call('/api/reviews', {
    method: 'POST', token,
    body: {
      filmId: String(film._id),
      ratingId: String(rated.json.rating._id),
      title: 'Заголовок',
      text: 'x'.repeat(500)
    }
  });
  assert.equal(review.status, 200);

  const anonReviews = await call(`/api/reviews/${film._id}`);
  assert.equal(anonReviews.json.length, 0, 'pending-рецензия попала в публичный список');

  const comment = await call('/api/comments', {
    method: 'POST', token,
    body: { filmId: String(film._id), text: 'Комментарий' }
  });
  assert.equal(comment.status, 200);

  const comments = await call(`/api/comments/${film._id}`);
  assert.equal(comments.status, 200);
  assert.ok(Array.isArray(comments.json));

  const myRatings = await call('/api/ratings/user', { token });
  assert.equal(myRatings.status, 200);
  assert.equal(myRatings.json.length, 1);

  const myReviews = await call('/api/reviews/user', { token });
  assert.equal(myReviews.status, 200);
  assert.equal(myReviews.json.length, 1);

  const publicProfile = await call(`/api/users/${me.json._id}`);
  assert.equal(publicProfile.status, 200);
  assert.equal(publicProfile.json.reviews.length, 0, 'чужой видит черновик');

  const ownProfile = await call(`/api/users/${me.json._id}`, { token });
  assert.equal(ownProfile.json.reviews.length, 1);

  const byNickname = await call('/api/users/nickname/' + encodeURIComponent('Путешественник'));
  assert.equal(byNickname.status, 200);
  assert.ok(byNickname.json._id);

  const achievements = await call('/api/users/me/achievements', { token });
  assert.equal(achievements.status, 200);

  const topUsers = await call('/api/top/users');
  assert.ok(Array.isArray(topUsers.json.items));

  const events = await call('/api/events');
  assert.ok(Array.isArray(events.json));
  assert.ok(events.json.length >= 1, 'лента событий пуста');

  const admin = await createUser({ isAdmin: true });
  const adminToken = signAccessToken(admin._id);

  const pendingReviews = await call('/api/admin/pending/reviews', { token: adminToken });
  assert.equal(pendingReviews.status, 200);
  assert.equal(pendingReviews.json.length, 1);

  const approved = await call(`/api/admin/reviews/${review.json._id}/approve`, {
    method: 'PUT', token: adminToken
  });
  assert.equal(approved.status, 200);

  const afterApprove = await call(`/api/reviews/${film._id}`);
  assert.equal(afterApprove.json.length, 1);

  const loggedOut = await call('/api/auth/logout', { method: 'POST', cookies: cookie });
  assert.equal(loggedOut.status, 200);
});

// ─────────────── СОГЛАСИЯ И АНТИ-НАКРУТКА ───────────────

test('регистрация без согласий не создаёт пользователя', async () => {
  const response = await call('/api/auth/register', {
    method: 'POST',
    body: { password: 'password123', nickname: 'NoConsent' }
  });

  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'VALIDATION_ERROR');
  assert.equal(
    await User.countDocuments({ nickname: 'NoConsent' }),
    0,
    'пользователь создан без согласий'
  );
});

test('согласия сохраняются вместе с аккаунтом', async () => {
  await createUser();
  const inviteCode = await createInvite();

  const response = await call('/api/auth/register', {
    method: 'POST',
    body: {
      nickname: 'Consent',
      password: 'password123',
      inviteCode,
      consent: { personalData: true, cookies: true, version: '1.0' }
    }
  });
  assert.equal(response.status, 201);

  const user = await User.findOne({ nickname: 'Consent' });
  assert.ok(user, 'пользователь не создан');
  assert.equal(user.consent.personalData, true);
  assert.equal(user.consent.cookies, true);
  assert.equal(user.consent.version, '1.0');
  assert.ok(user.consent.acceptedAt instanceof Date);
  assert.ok(user.registeredIp, 'IP регистрации не сохранён');
});

test('с одного IP нельзя зарегистрировать больше 10 аккаунтов в час', async () => {
  await createUser();

  const headers = { 'x-forwarded-for': '198.51.100.77' };
  let last;

  for (let i = 0; i < 11; i += 1) {
    const inviteCode = await createInvite();
    last = await call('/api/auth/register', {
      method: 'POST',
      headers,
      body: {
        password: 'password123',
        nickname: `farm${i}`,
        inviteCode,
        consent: { personalData: true, cookies: true }
      }
    });
  }

  assert.equal(last.status, 429, 'лимит регистраций с одного IP не сработал');
});

test('накрутка оценками возможна, но обнуляется детектором ферм', async () => {
  const film = await Film.create({ tmdbId: 555, title: 'Накрученный' });
  const farmIp = '203.0.113.250';

  for (let i = 0; i < 10; i += 1) {
    const user = await User.create({
      email: `sybil${i}@example.com`,
      password: 'x',
      nickname: `sybil${i}`,
      registeredIp: farmIp
    });
    await Rating.create({
      userId: user._id,
      filmId: film._id,
      scores: scores(10),
      vibe: 10,
      technicalScore: 100,
      combinedScore: 100,
      weight: 1
    });
  }

  const inflated = await call(`/api/films/${film._id}`);
  assert.equal(inflated.json.averageRating, 100);
  assert.equal(inflated.json.votesCount, 10);

  const top = await call('/api/films/top?limit=20');
  assert.equal(String(top.json.films[0]._id), String(film._id), 'накрутка не подняла фильм в топ');

  const result = await flagSybilAccounts({ minAccounts: 5, windowHours: 24 });
  assert.equal(result.clusters, 1);
  assert.equal(result.flaggedUsers, 10);

  const cleaned = await call(`/api/films/${film._id}`);
  assert.equal(cleaned.json.votesCount, 0, 'оценки фермы всё ещё учитываются');
  assert.equal(cleaned.json.averageRating, 0);

  const topAfter = await call('/api/films/top?limit=20');
  assert.equal(topAfter.json.films.length, 0, 'фильм остался в топе после чистки');

  const usersTop = await call('/api/top/users');
  assert.equal(usersTop.json.items.length, 0, 'помеченные фермы остались в топе пользователей');
  assert.equal(usersTop.json.pagination.total, 0);
});
