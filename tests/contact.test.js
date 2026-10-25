process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/cinephilium-test-contact';
process.env.JWT_ACCESS_SECRET = 'test-jwt-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
process.env.TMDB_API_KEY = 'test-tmdb-key';
process.env.ADMIN_SECRET_KEY = 'test-admin-key';
process.env.CORS_ORIGIN = 'https://film.ru';
process.env.CLIENT_URL = 'https://front.example.com';
process.env.ADMIN_TELEGRAMS = 'fearrlez,asduna_piu';

const { after, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const app = require('../src/app');
const User = require('../src/models/User');
const Invite = require('../src/models/Invite');
const ContactRequest = require('../src/models/ContactRequest');
const { signAccessToken } = require('../src/utils/jwt');

let server;
let baseUrl;
let ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return `198.19.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
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
  return { status: response.status, json };
}

let userSeq = 0;
async function seedUser(overrides = {}) {
  userSeq += 1;
  return User.create({
    nickname: `seed${userSeq}`,
    password: await bcrypt.hash('password123', 4),
    ...overrides
  });
}

async function adminToken() {
  const admin = await seedUser({ isAdmin: true, telegram: '' });
  return { token: signAccessToken(admin._id), admin };
}

async function createRequest(overrides = {}) {
  return ContactRequest.create({
    nickname: 'Хочу в клуб',
    contact: '@wannabe',
    message: 'Люблю кино',
    ...overrides
  });
}

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Invite.deleteMany({}), ContactRequest.deleteMany({})]);
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await mongoose.disconnect();
});

// ─────────────────── ПУБЛИЧНЫЕ КОНТАКТЫ ───────────────────

test('страница связи показывает телеграмы из ADMIN_TELEGRAMS', async () => {
  const response = await call('/api/contact/admins');
  assert.equal(response.status, 200);

  const handles = response.json.admins.map(admin => admin.telegram);
  assert.deepEqual(handles, ['fearrlez', 'asduna_piu']);
  assert.equal(response.json.admins[0].nickname, null, 'запасной контакт идёт без никнейма');
});

test('телеграм админа из базы добавляется к контактам без дублей', async () => {
  await seedUser({ nickname: 'ss', isAdmin: true, telegram: 'asduna_piu' });
  await seedUser({ nickname: 'Дмитрий', isAdmin: true, telegram: 'fearrlez' });

  const response = await call('/api/contact/admins');
  const handles = response.json.admins.map(admin => admin.telegram);
  assert.deepEqual(handles.sort(), ['asduna_piu', 'fearrlez'], 'дубли не должны появляться');

  const ss = response.json.admins.find(admin => admin.nickname === 'ss');
  assert.equal(ss.telegram, 'asduna_piu');
});

// ─────────────────── ЗАЯВКИ ───────────────────

test('заявка сохраняется и содержит контакт и сообщение', async () => {
  const response = await call('/api/contact/request', {
    method: 'POST',
    body: { nickname: 'Новичок', contact: '@novichok', message: 'Хочу оценивать кино' }
  });
  assert.equal(response.status, 201);

  const saved = await ContactRequest.findOne({ nickname: 'Новичок' });
  assert.ok(saved, 'заявка не сохранена');
  assert.equal(saved.contact, '@novichok');
  assert.equal(saved.status, 'new');
  assert.ok(saved.ip, 'IP заявки не записан');
});

test('скрытое поле-ловушка не создаёт заявку, но отвечает успехом', async () => {
  const response = await call('/api/contact/request', {
    method: 'POST',
    body: { nickname: 'Бот', contact: '@bot', website: 'http://spam.example' }
  });
  assert.equal(response.status, 201);
  assert.equal(await ContactRequest.countDocuments({}), 0, 'бот всё-таки попал в базу');
});

test('короткий контакт отклоняется валидацией', async () => {
  const response = await call('/api/contact/request', {
    method: 'POST',
    body: { nickname: 'Без контакта', contact: '1' }
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'VALIDATION_ERROR');
});

test('с одного IP больше пяти заявок в час не проходит', async () => {
  const headers = { 'x-forwarded-for': '203.0.113.99' };
  let last;

  for (let i = 0; i < 6; i += 1) {
    last = await call('/api/contact/request', {
      method: 'POST',
      headers,
      body: { nickname: `Заявка ${i}`, contact: `@user${i}` }
    });
  }

  assert.equal(last.status, 429, 'лимит заявок не сработал');
});

// ─────────────────── АДМИНСКАЯ ОЧЕРЕДЬ ───────────────────

test('админ видит заявки, обычный пользователь — нет', async () => {
  await createRequest({ nickname: 'Очередь' });
  const { token } = await adminToken();
  const user = await seedUser();

  const adminList = await call('/api/admin/contact-requests', { token });
  assert.equal(adminList.status, 200);
  assert.equal(adminList.json.length, 1);
  assert.equal(adminList.json[0].nickname, 'Очередь');

  const userList = await call('/api/admin/contact-requests', { token: signAccessToken(user._id) });
  assert.equal(userList.status, 403);
});

test('одобрение заявки выдаёт рабочий инвайт и закрывает заявку', async () => {
  const request = await createRequest({ nickname: 'Одобренный', contact: '@approved' });
  const { token } = await adminToken();

  const approved = await call(`/api/admin/contact-requests/${request._id}/approve`, {
    method: 'POST',
    token
  });
  assert.equal(approved.status, 200);
  assert.match(approved.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const registration = await call('/api/auth/register', {
    method: 'POST',
    body: {
      nickname: 'Одобренный',
      password: 'password123',
      inviteCode: approved.json.code,
      consent: { personalData: true, cookies: true }
    }
  });
  assert.equal(registration.status, 201, 'код из заявки должен регистрировать');

  const saved = await ContactRequest.findById(request._id);
  assert.equal(saved.status, 'approved');
  assert.ok(saved.inviteId, 'инвайт не привязан к заявке');

  const again = await call(`/api/admin/contact-requests/${request._id}/approve`, {
    method: 'POST',
    token
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'REQUEST_ALREADY_REVIEWED');
});

test('отклонённую заявку нельзя потом одобрить', async () => {
  const request = await createRequest({ nickname: 'Отказ' });
  const { token } = await adminToken();

  const rejected = await call(`/api/admin/contact-requests/${request._id}/reject`, {
    method: 'POST',
    token
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.status, 'rejected');

  const approve = await call(`/api/admin/contact-requests/${request._id}/approve`, {
    method: 'POST',
    token
  });
  assert.equal(approve.status, 409);
});

// ─────────────────── ТЕЛЕГРАМ В ПРОФИЛЕ ───────────────────

test('админ задаёт телеграм, ссылка принимается и нормализуется', async () => {
  const { token } = await adminToken();
  const target = await seedUser({ nickname: 'ss' });

  const saved = await call(`/api/admin/users/${target._id}/telegram`, {
    method: 'POST',
    token,
    body: { telegram: 'https://t.me/asduna_piu' }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.telegram, 'asduna_piu');

  assert.equal((await User.findById(target._id)).telegram, 'asduna_piu');
});

test('кривой телеграм не сохраняется', async () => {
  const { token } = await adminToken();
  const target = await seedUser({ nickname: 'Плохой' });

  const response = await call(`/api/admin/users/${target._id}/telegram`, {
    method: 'POST',
    token,
    body: { telegram: 'это не телеграм!' }
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'INVALID_TELEGRAM');
});
