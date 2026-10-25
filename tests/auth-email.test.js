process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/cinephilium-test';
process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';
process.env.CORS_ORIGIN = 'https://film.ru';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const Review = require('../src/models/Review');
const Rating = require('../src/models/Rating');
const Film = require('../src/models/Film');
const mailer = require('../src/services/mailer');
const { hashToken } = require('../src/utils/tokens');
const { signAccessToken } = require('../src/utils/jwt');
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

async function post(path, body, token) {
  const headers = {
    'content-type': 'application/json',
    'x-forwarded-for': `198.51.100.${ipCounter++}`
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/api/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
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

test('register stores an unverified user and sends a hashed-code email', async () => {
  let savedUser;
  let mailed;
  await withOverrides([
    [User, 'findOne', async () => null],
    [User.prototype, 'save', async function save() { savedUser = this; }],
    [mailer, 'sendVerificationCode', (email, code) => { mailed = { email, code }; }]
  ], async () => {
    const response = await post('auth/register', {
      email: 'new@example.com', password: 'password123', nickname: 'NewUser'
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.user.emailVerified, false);
    assert.equal(body.accessToken, undefined);
    assert.equal(savedUser.emailVerified, false);
    assert.equal(savedUser.emailVerification.codeHash, hashToken(mailed.code));
    assert.equal(mailed.email, 'new@example.com');
  });
});

test('verify accepts the correct code and issues an access token', async () => {
  const user = {
    _id: new mongoose.Types.ObjectId(), email: 'verify@example.com', nickname: 'Verify', emailVerified: false,
    emailVerification: { codeHash: hashToken('123456'), expiresAt: new Date(Date.now() + 60000), attempts: 0 },
    save: async function save() {}
  };
  await withOverrides([
    [User, 'findOne', async () => user],
    [Session.prototype, 'save', async function save() {}]
  ], async () => {
    const response = await post('auth/verify-email', { email: user.email, code: '123456' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(body.accessToken);
    assert.equal(body.token, undefined);
    assert.match(response.headers.get('set-cookie'), /refresh_token=.*HttpOnly/);
    assert.equal(user.emailVerified, true);
    assert.equal(user.emailVerification, null);
  });
});

test('incorrect verification code increments attempts', async () => {
  const user = {
    emailVerified: false,
    emailVerification: { codeHash: hashToken('123456'), expiresAt: new Date(Date.now() + 60000), attempts: 0 },
    save: async function save() {}
  };
  await withOverrides([[User, 'findOne', async () => user]], async () => {
    const response = await post('auth/verify-email', { email: 'verify@example.com', code: '654321' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_CODE');
    assert.equal(user.emailVerification.attempts, 1);
  });
});

test('verification is blocked after five incorrect attempts', async () => {
  const user = {
    emailVerified: false,
    emailVerification: { codeHash: hashToken('123456'), expiresAt: new Date(Date.now() + 60000), attempts: 5 }
  };
  await withOverrides([[User, 'findOne', async () => user]], async () => {
    const response = await post('auth/verify-email', { email: 'verify@example.com', code: '123456' });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'TOO_MANY_ATTEMPTS');
  });
});

test('expired verification code is rejected', async () => {
  const user = {
    emailVerified: false,
    emailVerification: { codeHash: hashToken('123456'), expiresAt: new Date(Date.now() - 1000), attempts: 0 }
  };
  await withOverrides([[User, 'findOne', async () => user]], async () => {
    const response = await post('auth/verify-email', { email: 'verify@example.com', code: '123456' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'CODE_EXPIRED');
  });
});

test('verification resend honors cooldown and hourly limit', async () => {
  const cooldownUser = { emailVerified: false, emailVerification: { sentAt: new Date(), resendHistory: [] } };
  await withOverrides([[User, 'findOne', async () => cooldownUser]], async () => {
    const response = await post('auth/resend-verification', { email: 'verify@example.com' });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'RESEND_COOLDOWN');
  });

  const now = Date.now();
  const limitedUser = {
    emailVerified: false,
    emailVerification: {
      sentAt: new Date(now - 61000),
      resendHistory: [new Date(now - 20 * 60000), new Date(now - 10 * 60000), new Date(now - 2 * 60000)]
    }
  };
  await withOverrides([[User, 'findOne', async () => limitedUser]], async () => {
    const response = await post('auth/resend-verification', { email: 'verify@example.com' });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'RESEND_LIMIT');
  });
});

test('forgot password stores only a token hash and hides unknown emails', async () => {
  const user = { email: 'forgot@example.com', save: async function save() {} };
  let resetUrl;
  await withOverrides([
    [User, 'findOne', async () => user],
    [mailer, 'sendPasswordReset', (_email, url) => { resetUrl = url; }]
  ], async () => {
    const response = await post('auth/forgot-password', { email: user.email });
    assert.equal(response.status, 200);
    const token = new URL(resetUrl).searchParams.get('token');
    assert.equal(user.passwordReset.tokenHash, hashToken(token));
    assert.ok(!JSON.stringify(user.passwordReset).includes(token));
  });

  await withOverrides([[User, 'findOne', async () => null]], async () => {
    const response = await post('auth/forgot-password', { email: 'missing@example.com' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'Если email существует, письмо отправлено' });
  });
});

test('valid password reset changes the password; expired and used tokens are rejected', async () => {
  const oldPassword = await bcrypt.hash('old-password', 4);
  const user = {
    _id: new mongoose.Types.ObjectId(),
    password: oldPassword,
    passwordReset: { tokenHash: hashToken('reset-token'), expiresAt: new Date(Date.now() + 60000), usedAt: null },
    save: async function save() {}
  };
  let revokedUserId;
  await withOverrides([
    [User, 'findOne', async () => user],
    [Session, 'deleteMany', async query => { revokedUserId = query.userId; return { deletedCount: 1 }; }]
  ], async () => {
    const response = await post('auth/reset-password', { token: 'reset-token', newPassword: 'new-password' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, 'Пароль изменён');
    assert.equal(await bcrypt.compare('new-password', user.password), true);
    assert.equal(user.passwordReset, null);
    assert.equal(revokedUserId.toString(), user._id.toString());
  });

  for (const passwordReset of [
    { expiresAt: new Date(Date.now() - 1000), usedAt: null },
    { expiresAt: new Date(Date.now() + 60000), usedAt: new Date() }
  ]) {
    await withOverrides([[User, 'findOne', async () => ({ passwordReset })]], async () => {
      const response = await post('auth/reset-password', { token: 'reset-token', newPassword: 'new-password' });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'INVALID_OR_EXPIRED_TOKEN');
    });
  }
});

test('unverified users cannot create reviews and verified users can', async () => {
  const unverifiedUser = { _id: 'unverified-user', emailVerified: false, isAdmin: false };
  await withOverrides([[User, 'findById', async () => unverifiedUser]], async () => {
    const response = await post('reviews', {}, signAccessToken(unverifiedUser._id));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'EMAIL_NOT_VERIFIED');
  });

  const verifiedUser = { _id: new mongoose.Types.ObjectId(), emailVerified: true, isAdmin: false };
  await withOverrides([
    [User, 'findById', async () => verifiedUser],
    [Film, 'findById', async () => ({ _id: 'film-1' })],
    [Rating, 'findOne', async () => ({ _id: 'rating-1' })],
    [Review, 'findOne', async () => null],
    [User, 'updateOne', async () => ({ modifiedCount: 1 })],
    [Review.prototype, 'save', async function save() {}],
    [Review, 'findById', () => ({ populate() { return this; }, toObject() { return {}; } })]
  ], async () => {
    const response = await post('reviews', {
      filmId: '507f1f77bcf86cd799439011',
      ratingId: '507f1f77bcf86cd799439012',
      title: 'Review',
      text: 'a'.repeat(450)
    }, signAccessToken(verifiedUser._id));
    assert.equal(response.status, 200);
  });
});

test('registration rejects duplicates, resends pending verification, and validates passwords', async () => {
  await withOverrides([[User, 'findOne', async query => query.email ? { emailVerified: true } : null]], async () => {
    const response = await post('auth/register', {
      email: 'existing@example.com', password: 'password123', nickname: 'Existing'
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'CONFLICT');
  });

  const user = {
    _id: 'pending-user', email: 'pending@example.com', nickname: 'Pending', emailVerified: false,
    emailVerification: { sentAt: new Date(Date.now() - 61000), resendHistory: [new Date(Date.now() - 61000)] },
    save: async function save() {}
  };
  let sendCount = 0;
  await withOverrides([
    [User, 'findOne', async () => user],
    [mailer, 'sendVerificationCode', () => { sendCount += 1; }]
  ], async () => {
    const response = await post('auth/register', {
      email: user.email, password: 'password123', nickname: user.nickname
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, 'Проверьте почту для подтверждения');
    assert.equal(sendCount, 1);
  });

  const response = await post('auth/register', {
    email: 'short@example.com', password: '1234567', nickname: 'Short'
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
});
