process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/cinephilium-test';
process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';
process.env.CORS_ORIGIN = 'https://film.ru';
process.env.COOKIE_DOMAIN = 'localhost';
process.env.COOKIE_SECURE = 'false';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const { hashToken } = require('../src/utils/tokens');
const { signAccessToken, signRefreshToken } = require('../src/utils/jwt');
const app = require('../src/app');

let server;
let baseUrl;
let ipCounter = 1;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

async function request(path, { method = 'POST', body, token, cookie, headers = {} } = {}) {
  const requestHeaders = {
    'x-forwarded-for': `198.51.100.${ipCounter++}`,
    ...headers
  };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (cookie) requestHeaders.cookie = cookie;
  return fetch(`${baseUrl}/api/${path}`, {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

async function withOverrides(overrides, callback) {
  const originals = overrides.map(([object, key, value]) => {
    const original = object[key];
    object[key] = value;
    return [object, key, original];
  });
  try {
    return await callback();
  } finally {
    for (const [object, key, original] of originals) object[key] = original;
  }
}

function getCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  return setCookie?.match(/refresh_token=([^;]+)/)?.[1];
}

function cookieHeader(token) {
  return `refresh_token=${token}`;
}

test('1. login returns access token and stores refresh session in an HttpOnly cookie', async () => {
  const userId = new mongoose.Types.ObjectId();
  const password = await bcrypt.hash('password123', 4);
  const user = {
    _id: userId,
    email: 'login@example.com',
    nickname: 'Login',
    password,
    emailVerified: true,
    isAdmin: false,
    totalPoints: 0
  };
  let createdSession;
  await withOverrides([
    [User, 'findOne', async () => user],
    [Session.prototype, 'save', async function save() { createdSession = this; }]
  ], async () => {
    const response = await request('auth/login', { body: { email: user.email, password: 'password123' } });
    const body = await response.json();
    const setCookie = response.headers.get('set-cookie');
    const refreshToken = getCookie(response);
    assert.equal(response.status, 200);
    assert.ok(body.accessToken);
    assert.equal(body.token, undefined);
    assert.equal(body.refreshToken, undefined);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\/api\/auth/);
    assert.equal(createdSession.userId.toString(), userId.toString());
    assert.equal(createdSession.tokenHash, hashToken(refreshToken));
  });
});

test('2. refresh rotates the stored hash and returns a new access token and cookie', async () => {
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const oldToken = signRefreshToken(userId, sessionId);
  const session = {
    _id: sessionId,
    userId,
    tokenHash: hashToken(oldToken),
    expiresAt: new Date(Date.now() + 86400000)
  };
  const oldHash = session.tokenHash;
  await withOverrides([
    [Session, 'findOne', async () => session],
    [Session, 'updateOne', async (filter, update) => {
      assert.equal(filter.tokenHash, oldHash);
      Object.assign(session, update.$set);
      return { modifiedCount: 1 };
    }]
  ], async () => {
    const response = await request('auth/refresh', { cookie: cookieHeader(oldToken) });
    const body = await response.json();
    const newToken = getCookie(response);
    assert.equal(response.status, 200);
    assert.ok(body.accessToken);
    assert.ok(newToken);
    assert.notEqual(newToken, oldToken);
    assert.notEqual(session.tokenHash, oldHash);
    assert.equal(session.tokenHash, hashToken(newToken));
  });
});

test('3. refresh without a cookie returns 401', async () => {
  const response = await request('auth/refresh');
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'NO_REFRESH_TOKEN');
});

test('4. refresh with a revoked session returns 401 and clears the cookie', async () => {
  const token = signRefreshToken(new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId());
  await withOverrides([[Session, 'findOne', async () => null]], async () => {
    const response = await request('auth/refresh', { cookie: cookieHeader(token) });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'SESSION_REVOKED');
    assert.match(response.headers.get('set-cookie'), /refresh_token=;/);
    assert.match(response.headers.get('set-cookie'), /Path=\/api\/auth/);
  });
});

test('refresh rejects and deletes a session whose explicit expiry has passed', async () => {
  const token = signRefreshToken(new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId());
  let deletedId;
  await withOverrides([
    [Session, 'findOne', async () => ({ _id: new mongoose.Types.ObjectId(), expiresAt: new Date(Date.now() - 1000) })],
    [Session, 'deleteOne', async query => { deletedId = query._id; return { deletedCount: 1 }; }]
  ], async () => {
    const response = await request('auth/refresh', { cookie: cookieHeader(token) });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'SESSION_EXPIRED');
    assert.ok(deletedId);
    assert.match(response.headers.get('set-cookie'), /refresh_token=;/);
  });
});

test('5. logout removes the matching session and clears the cookie', async () => {
  const token = signRefreshToken(new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId());
  let removedHash;
  await withOverrides([
    [Session, 'deleteOne', async query => { removedHash = query.tokenHash; return { deletedCount: 1 }; }]
  ], async () => {
    const response = await request('auth/logout', { cookie: cookieHeader(token) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, 'Выход выполнен');
    assert.equal(removedHash, hashToken(token));
    assert.match(response.headers.get('set-cookie'), /refresh_token=;/);
  });
});

test('6. logout-all removes all sessions for the authenticated user', async () => {
  const userId = new mongoose.Types.ObjectId();
  const token = signAccessToken(userId);
  let removedUserId;
  await withOverrides([
    [User, 'findById', async () => ({ _id: userId, isAdmin: false })],
    [Session, 'deleteMany', async query => { removedUserId = query.userId; return { deletedCount: 2 }; }]
  ], async () => {
    const response = await request('auth/logout-all', { token });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, 'Все сессии завершены');
    assert.equal(removedUserId.toString(), userId.toString());
    assert.match(response.headers.get('set-cookie'), /refresh_token=;/);
  });
});

test('7. refresh after logout-all rejects the old refresh token', async () => {
  const oldToken = signRefreshToken(new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId());
  await withOverrides([[Session, 'findOne', async () => null]], async () => {
    const response = await request('auth/refresh', { cookie: cookieHeader(oldToken) });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'SESSION_REVOKED');
  });
});

test('8. access token expires in 15 minutes', () => {
  const payload = jwt.decode(signAccessToken(new mongoose.Types.ObjectId()));
  assert.equal(payload.exp - payload.iat, 15 * 60);
});

test('9. expired access token cannot access /me', async () => {
  const token = jwt.sign(
    { userId: new mongoose.Types.ObjectId().toString(), type: 'access' },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: -1, algorithm: 'HS256' }
  );
  const response = await request('auth/me', { method: 'GET', token });
  assert.equal(response.status, 401);
});

test('10. refresh token cannot be used as an access token', async () => {
  const token = signRefreshToken(new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId());
  const response = await request('auth/me', { method: 'GET', token });
  assert.equal(response.status, 401);
});

test('11. access token cannot be used as a refresh token', async () => {
  const token = signAccessToken(new mongoose.Types.ObjectId());
  const response = await request('auth/refresh', { cookie: cookieHeader(token) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'INVALID_REFRESH_TOKEN');
});

test('12. CORS preflight allows the configured origin and credentials', async () => {
  const response = await request('auth/refresh', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://film.ru',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization'
    }
  });
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://film.ru');
});
