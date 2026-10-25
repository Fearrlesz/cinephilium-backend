process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/cinephilium-test-auth-invite';
process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';
process.env.CORS_ORIGIN = 'https://film.ru';
process.env.CLIENT_URL = 'https://front.example.com';
process.env.REGISTRATION_MODE = 'invite';

const { after, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const app = require('../src/app');
const User = require('../src/models/User');
const Invite = require('../src/models/Invite');
const Session = require('../src/models/Session');
const { signAccessToken } = require('../src/utils/jwt');
const { generateInviteCode, hashToken } = require('../src/utils/tokens');

let server;
let baseUrl;
let ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
  const requestHeaders = { 'x-forwarded-for': nextIp(), ...headers };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (token) requestHeaders.authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json, text };
}

const consent = { personalData: true, cookies: true };

let userSeq = 0;
async function seedUser(overrides = {}) {
  userSeq += 1;
  return User.create({
    nickname: `seed${userSeq}`,
    password: await bcrypt.hash('password123', 4),
    ...overrides
  });
}

async function seedInvite(overrides = {}) {
  const code = generateInviteCode();
  const invite = await Invite.create({
    codeHash: hashToken(code.replace('-', '')),
    codePrefix: code.slice(0, 4),
    ...overrides
  });
  return { code, invite };
}

async function adminToken() {
  const admin = await seedUser({ isAdmin: true });
  return signAccessToken(admin._id);
}

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Invite.deleteMany({}), Session.deleteMany({})]);
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await mongoose.disconnect();
});

// ─────────────────── КОНФИГ И РЕГИСТРАЦИЯ ───────────────────

test('config сообщает, что без инвайта не зарегистрироваться', async () => {
  const response = await call('/api/auth/config');
  assert.equal(response.status, 200);
  assert.equal(response.json.registrationMode, 'invite');
  assert.equal(response.json.inviteRequired, true);
});

test('регистрация по инвайту сразу выдаёт токен и гасит код', async () => {
  await seedUser();
  const { code, invite } = await seedInvite();

  const response = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Кинолюб', password: 'password123', inviteCode: ` ${code.toLowerCase()} `, consent }
  });

  assert.equal(response.status, 201);
  assert.ok(response.json.accessToken, 'аккаунт должен входить сразу, без подтверждений');
  assert.equal(response.json.user.nickname, 'Кинолюб');
  assert.equal(response.json.user.isAdmin, false);

  const refreshed = await Invite.findById(invite._id);
  assert.ok(refreshed.usedAt, 'инвайт не помечен использованным');
  assert.equal(refreshed.usedBy.toString(), response.json.user.id);

  const session = await Session.findOne({ userId: response.json.user.id });
  assert.ok(session, 'сессия не создана');
});

test('регистрация без инвайта запрещена, а мусорный код не принимается', async () => {
  await seedUser();

  const noCode = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Без кода', password: 'password123', consent }
  });
  assert.equal(noCode.status, 403);
  assert.equal(noCode.json.error.code, 'INVITE_REQUIRED');

  const garbage = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Мусор', password: 'password123', inviteCode: 'ABC', consent }
  });
  assert.equal(garbage.status, 400);
  assert.equal(garbage.json.error.code, 'INVITE_INVALID');

  assert.equal(await User.countDocuments({}), 1, 'неудачные попытки не должны создавать аккаунты');
});

test('использованный, просроченный и отозванный инвайты отклоняются', async () => {
  await seedUser();

  const used = await seedInvite({ usedAt: new Date(), usedBy: new mongoose.Types.ObjectId() });
  const usedResponse = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Повтор', password: 'password123', inviteCode: used.code, consent }
  });
  assert.equal(usedResponse.status, 409);
  assert.equal(usedResponse.json.error.code, 'INVITE_USED');

  const expired = await seedInvite({ expiresAt: new Date(Date.now() - 60_000) });
  const expiredResponse = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Просрочка', password: 'password123', inviteCode: expired.code, consent }
  });
  assert.equal(expiredResponse.status, 410);
  assert.equal(expiredResponse.json.error.code, 'INVITE_EXPIRED');

  const revoked = await seedInvite({ revokedAt: new Date() });
  const revokedResponse = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Отзыв', password: 'password123', inviteCode: revoked.code, consent }
  });
  assert.equal(revokedResponse.status, 410);
  assert.equal(revokedResponse.json.error.code, 'INVITE_REVOKED');
});

test('занятый никнейм не даёт создать второй аккаунт по тому же коду', async () => {
  await seedUser();
  const { code } = await seedInvite();

  const first = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Уникум', password: 'password123', inviteCode: code, consent }
  });
  assert.equal(first.status, 201);

  const { code: secondCode } = await seedInvite();
  const duplicate = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Уникум', password: 'password123', inviteCode: secondCode, consent }
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'CONFLICT');
});

test('первый пользователь пустой базы — админ без инвайта', async () => {
  const response = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Основатель', password: 'password123', consent }
  });
  assert.equal(response.status, 201);
  assert.equal(response.json.user.isAdmin, true);
});

test('без согласий аккаунт не создаётся', async () => {
  await seedUser();
  const { code } = await seedInvite();

  const response = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Без согласий', password: 'password123', inviteCode: code }
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'VALIDATION_ERROR');
  assert.equal(await User.countDocuments({ nickname: 'Без согласий' }), 0);
});

// ─────────────────────────── ВХОД ───────────────────────────

test('вход по никнейму; старая почта тоже работает; чужой пароль — 401', async () => {
  const user = await seedUser({ nickname: 'Критик', email: 'critic@example.com' });

  const byNickname = await call('/api/auth/login', {
    method: 'POST',
    body: { nickname: 'Критик', password: 'password123' }
  });
  assert.equal(byNickname.status, 200);
  assert.ok(byNickname.json.accessToken);

  const byEmail = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'critic@example.com', password: 'password123' }
  });
  assert.equal(byEmail.status, 200, 'старые аккаунты должны входить по почте');

  const wrong = await call('/api/auth/login', {
    method: 'POST',
    body: { nickname: 'Критик', password: 'not-my-password' }
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'UNAUTHORIZED');
  assert.equal(user.nickname, 'Критик');
});

// ─────────────────── АДМИН: ИНВАЙТЫ ───────────────────

test('админ выдаёт коды, список их не раскрывает, отзыв закрывает вход', async () => {
  const token = await adminToken();

  const created = await call('/api/admin/invites', {
    method: 'POST',
    token,
    body: { quantity: 2, note: 'для друзей' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.invites.length, 2);
  const [firstCode] = created.json.invites.map(item => item.code);
  assert.match(firstCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const list = await call('/api/admin/invites', { token });
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 2);
  for (const invite of list.json) {
    assert.equal(invite.code, undefined, 'коды не должны храниться и отдаваться целиком');
    assert.equal(invite.status, 'active');
    assert.equal(invite.prefix, firstCode.slice(0, 4).length ? invite.prefix : '');
  }

  const inviteId = list.json.find(item => item.prefix === firstCode.slice(0, 4)).id;
  const revoked = await call(`/api/admin/invites/${inviteId}`, { method: 'DELETE', token });
  assert.equal(revoked.status, 200);

  const registration = await call('/api/auth/register', {
    method: 'POST',
    body: { nickname: 'Отозванный', password: 'password123', inviteCode: firstCode, consent }
  });
  assert.equal(registration.status, 410);
  assert.equal(registration.json.error.code, 'INVITE_REVOKED');
});

test('обычный пользователь не может выдавать инвайты', async () => {
  const user = await seedUser();
  const response = await call('/api/admin/invites', {
    method: 'POST',
    token: signAccessToken(user._id),
    body: { quantity: 1 }
  });
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'FORBIDDEN');
});

// ─────────────── АДМИН: СБРОС ПАРОЛЯ ───────────────

test('админская ссылка сбрасывает пароль один раз и убивает сессии', async () => {
  const token = await adminToken();
  const user = await seedUser({ nickname: 'Забывчивый' });
  await Session.create({
    userId: user._id,
    tokenHash: 'deadbeef',
    expiresAt: new Date(Date.now() + 3600_000)
  });

  const link = await call(`/api/admin/users/${user._id}/reset-link`, { method: 'POST', token });
  assert.equal(link.status, 200);
  assert.match(link.json.url, /^https:\/\/front\.example\.com\/reset-password\?token=/);

  const resetToken = decodeURIComponent(link.json.url.split('token=')[1]);
  const reset = await call('/api/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, newPassword: 'brand-new-password' }
  });
  assert.equal(reset.status, 200);
  assert.equal(await Session.countDocuments({ userId: user._id }), 0, 'сессии не отозваны');

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { nickname: 'Забывчивый', password: 'brand-new-password' }
  });
  assert.equal(login.status, 200);

  const oldPassword = await call('/api/auth/login', {
    method: 'POST',
    body: { nickname: 'Забывчивый', password: 'password123' }
  });
  assert.equal(oldPassword.status, 401, 'старый пароль должен перестать работать');

  const secondUse = await call('/api/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, newPassword: 'another-password-1' }
  });
  assert.equal(secondUse.status, 400);
  assert.equal(secondUse.json.error.code, 'INVALID_OR_EXPIRED_TOKEN');
});

test('ссылка для несуществующего пользователя — 404', async () => {
  const token = await adminToken();
  const response = await call(`/api/admin/users/${new mongoose.Types.ObjectId()}/reset-link`, {
    method: 'POST',
    token
  });
  assert.equal(response.status, 404);
});
