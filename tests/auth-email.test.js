process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/cinephilium-test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const Review = require('../src/models/Review');
const Rating = require('../src/models/Rating');
const Film = require('../src/models/Film');
const mailer = require('../src/services/mailer');
const { hashToken } = require('../src/utils/tokens');
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

function mockSave(object) {
  return [object, 'save', async function save() {}];
}

test('1. register stores an unverified user and sends a hashed-code email', async () => {
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
    assert.equal(body.token, undefined);
    assert.equal(savedUser.emailVerified, false);
    assert.equal(savedUser.emailVerification.codeHash, hashToken(mailed.code));
    assert.equal(mailed.email, 'new@example.com');
  });
});

test('2. verify accepts the correct code and issues a token', async () => {
  const user = {
    _id: 'verified-user', email: 'verify@example.com', nickname: 'Verify', emailVerified: false,
    emailVerification: { codeHash: hashToken('123456'), expiresAt: new Date(Date.now() + 60000), attempts: 0 },
    save: async function save() {}
  };
  await withOverrides([[User, 'findOne', async () => user]], async () => {
    const response = await post('auth/verify-email', { email: user.email, code: '123456' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(body.token);
    assert.equal(user.emailVerified, true);
    assert.equal(user.emailVerification, null);
  });
});

test('3. incorrect verification code increments attempts', async () => {
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

test('4. verification is blocked after five incorrect attempts', async () => {
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

test('5. expired verification code is rejected', async () => {
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

test('6. verification resend honors the cooldown', async () => {
  const user = { emailVerified: false, emailVerification: { sentAt: new Date(), resendHistory: [] } };
  await withOverrides([[User, 'findOne', async () => user]], async () => {
    const response = await post('auth/resend-verification', { email: 'verify@example.com' });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'RESEND_COOLDOWN');
  });
});

test('7. verification resend honors the hourly limit', async () => {
  const now = Date.now();
  const user = {
    emailVerified: false,
    emailVerification: {
      sentAt: new Date(now - 61000),
      resendHistory: [new Date(now - 20 * 60000), new Date(now - 10 * 60000), new Date(now - 2 * 60000)]
    }
  };
  await withOverrides([[User, 'findOne', async () => user]], async () => {
    const response = await post('auth/resend-verification', { email: 'verify@example.com' });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'RESEND_LIMIT');
  });
});

test('8. forgot password stores only a token hash and sends a reset link', async () => {
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
});

test('9. forgot password returns the same response for an unknown email', async () => {
  await withOverrides([[User, 'findOne', async () => null]], async () => {
    const response = await post('auth/forgot-password', { email: 'missing@example.com' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: 'Если email существует, письмо отправлено' });
  });
});

test('10. valid reset token changes the password and is invalidated', async () => {
  const oldPassword = await bcrypt.hash('old-password', 4);
  const user = {
    password: oldPassword,
    passwordReset: { tokenHash: hashToken('reset-token'), expiresAt: new Date(Date.now() + 60000), usedAt: null },
    save: async function save() {}
  };
  await withOverrides([[User, 'findOne', async () => user]], async () => {
    const response = await post('auth/reset-password', { token: 'reset-token', newPassword: 'new-password' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, 'Пароль изменён');
    assert.equal(await bcrypt.compare('old-password', user.password), false);
    assert.equal(await bcrypt.compare('new-password', user.password), true);
    assert.equal(user.passwordReset, null);
  });
});

test('11. expired reset token is rejected', async () => {
  const user = { passwordReset: { expiresAt: new Date(Date.now() - 1000), usedAt: null } };
  await withOverrides([[User, 'findOne', async () => user]], async () => {
    const response = await post('auth/reset-password', { token: 'reset-token', newPassword: 'new-password' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_OR_EXPIRED_TOKEN');
  });
});

test('12. used reset token is rejected', async () => {
  const user = { passwordReset: { expiresAt: new Date(Date.now() + 60000), usedAt: new Date() } };
  await withOverrides([[User, 'findOne', async () => user]], async () => {
    const response = await post('auth/reset-password', { token: 'reset-token', newPassword: 'new-password' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_OR_EXPIRED_TOKEN');
  });
});

test('13. unverified user cannot create a review', async () => {
  const user = { _id: 'unverified-user', emailVerified: false, isAdmin: false };
  await withOverrides([[User, 'findById', async () => user]], async () => {
    const token = require('jsonwebtoken').sign({ userId: user._id }, process.env.JWT_SECRET);
    const response = await post('reviews', {}, token);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'EMAIL_NOT_VERIFIED');
  });
});

test('14. verified user can create a review', async () => {
  const user = { _id: 'verified-user', emailVerified: true, isAdmin: false };
  await withOverrides([
    [User, 'findById', async () => user],
    [Film, 'findById', async () => ({ _id: 'film-1' })],
    [Rating, 'findOne', async () => ({ _id: 'rating-1' })],
    [Review, 'findOne', async () => null],
    [Review.prototype, 'save', async function save() {}],
    [Review, 'findById', () => ({ populate() { return this; } })]
  ], async () => {
    const token = require('jsonwebtoken').sign({ userId: user._id }, process.env.JWT_SECRET);
    const response = await post('reviews', {
      filmId: '507f1f77bcf86cd799439011',
      ratingId: '507f1f77bcf86cd799439012',
      title: 'Review',
      text: 'a'.repeat(450)
    }, token);
    assert.equal(response.status, 200);
  });
});

test('15. registering an already verified email returns conflict', async () => {
  await withOverrides([
    [User, 'findOne', async query => query.email ? { emailVerified: true } : null]
  ], async () => {
    const response = await post('auth/register', {
      email: 'existing@example.com', password: 'password123', nickname: 'Existing'
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'CONFLICT');
  });
});

test('16. registering an unverified email resends after the cooldown', async () => {
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
});

test('register rejects passwords shorter than eight characters', async () => {
  const response = await post('auth/register', {
    email: 'short@example.com', password: '1234567', nickname: 'Short'
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
});