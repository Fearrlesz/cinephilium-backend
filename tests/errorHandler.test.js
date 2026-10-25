process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/cinephilium-test-errors';
process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';
process.env.CORS_ORIGIN = 'https://film.ru';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');
const { signAccessToken } = require('../src/utils/jwt');
const app = require('../src/app');

let server;
let baseUrl;

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

test('unknown routes use the standard not-found error', async () => {
  const response = await fetch(`${baseUrl}/api/nonexistent`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: { code: 'NOT_FOUND', message: 'Маршрут не найден' }
  });
});

test('registration validation reports the email field', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: '', password: '', nickname: '' })
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(body.error.details.some(detail => detail.field === 'email'));
});

test('duplicate registration returns conflict', async () => {
  const originalFindOne = User.findOne;
  User.findOne = async () => ({ _id: 'existing-user', emailVerified: true });
  try {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'existing@example.com',
        password: 'password123',
        nickname: 'Existing'
      })
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.error.code, 'CONFLICT');
  } finally {
    User.findOne = originalFindOne;
  }
});

test('invalid film IDs return validation errors', async () => {
  const response = await fetch(`${baseUrl}/api/films/not-a-valid-id`);
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('unexpected errors are hidden from clients and logged', async () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const response = await fetch(`${baseUrl}/api/test/internal-error`);
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('boom'));
    assert.ok(!JSON.stringify(body).includes('stack'));
    assert.ok(logged.some(args => JSON.stringify(args).includes('boom')));
  } finally {
    console.error = originalConsoleError;
  }
});

test('auth-required routes reject requests without a token', async () => {
  const response = await fetch(`${baseUrl}/api/auth/me`);
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

test('admin routes reject authenticated non-admin users', async () => {
  const originalFindById = User.findById;
  User.findById = async () => ({ _id: 'regular-user', isAdmin: false });
  try {
    const token = signAccessToken('regular-user');
    const response = await fetch(`${baseUrl}/api/admin/pending/comments`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.error.code, 'FORBIDDEN');
  } finally {
    User.findById = originalFindById;
  }
});
