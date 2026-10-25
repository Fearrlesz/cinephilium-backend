#!/usr/bin/env node
/**
 * Демонстрация механики регистрации: инвайт → аккаунт → вход → сброс пароля.
 *
 * Перед запуском подними бэкенд на отдельной базе:
 *   PORT=3100 MONGODB_URI=mongodb://127.0.0.1:27017/cinephilium-demo node src/server.js
 * затем:
 *   node scripts/demo-registration.js
 *
 * Работает только с локальной базой (127.0.0.1) и очищает её перед прогоном,
 * чтобы шаги были воспроизводимы. Это учебный сценарий, а не часть приложения.
 */
require('dotenv').config();

const mongoose = require('mongoose');

const BASE = process.env.DEMO_BASE_URL || 'http://127.0.0.1:3100/api';
const DB_URI = 'mongodb://127.0.0.1:27017/cinephilium-demo';

function step(title) {
  console.log(`\n=== ${title} ===`);
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, json };
}

function show(label, result) {
  const body = result.json === undefined ? '' : JSON.stringify(result.json);
  console.log(`${label}: HTTP ${result.status} ${body.slice(0, 220)}`);
}

const consent = { personalData: true, cookies: true };

async function main() {
  // Чистая база — иначе «первый пользователь» не будет первым.
  await mongoose.connect(DB_URI);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log('База cinephilium-demo очищена');

  step('1. Что говорит сервер о регистрации');
  show('GET /auth/config', await call('/auth/config'));

  step('2. Первый пользователь на пустой базе — без инвайта, сразу админ');
  const admin = await call('/auth/register', {
    method: 'POST',
    body: { nickname: 'Дмитрий', password: 'admin-password', consent }
  });
  show('POST /auth/register', admin);
  const adminToken = admin.json.accessToken;
  console.log(`   isAdmin = ${admin.json.user.isAdmin}, токен выдан: ${Boolean(adminToken)}`);

  step('3. Админ выдаёт инвайт-код');
  const invite = await call('/admin/invites', {
    method: 'POST',
    token: adminToken,
    body: { quantity: 1, note: 'для друга' }
  });
  show('POST /admin/invites', invite);
  const code = invite.json.invites[0].code;
  console.log(`   КОД: ${code}`);

  step('4. Друг регистрируется этим кодом');
  const user = await call('/auth/register', {
    method: 'POST',
    body: { nickname: 'Аня', password: 'anya-password', inviteCode: code.toLowerCase(), consent }
  });
  show('POST /auth/register', user);
  console.log(`   токен выдан сразу: ${Boolean(user.json.accessToken)}`);

  step('5. Тот же код второй раз — нельзя');
  show('POST /auth/register (повтор)', await call('/auth/register', {
    method: 'POST',
    body: { nickname: 'Второй', password: 'second-password', inviteCode: code, consent }
  }));

  step('6. Без кода — нельзя');
  show('POST /auth/register (без кода)', await call('/auth/register', {
    method: 'POST',
    body: { nickname: 'Третий', password: 'third-password', consent }
  }));

  step('7. Вход по никнейму');
  const login = await call('/auth/login', {
    method: 'POST',
    body: { nickname: 'Аня', password: 'anya-password' }
  });
  show('POST /auth/login', login);

  step('8. Неверный пароль');
  show('POST /auth/login (неверный)', await call('/auth/login', {
    method: 'POST',
    body: { nickname: 'Аня', password: 'wrong-password' }
  }));

  step('9. Админ выдаёт одноразовую ссылку сброса');
  const userId = user.json.user.id;
  const link = await call(`/admin/users/${userId}/reset-link`, { method: 'POST', token: adminToken });
  show('POST /admin/users/:id/reset-link', link);
  const resetToken = decodeURIComponent(link.json.url.split('token=')[1]);
  console.log(`   token = ${resetToken.slice(0, 16)}…`);

  step('10. Сброс пароля по ссылке');
  show('POST /auth/reset-password', await call('/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, newPassword: 'anya-new-password' }
  }));

  step('11. Старый пароль больше не работает, новый — работает');
  show('POST /auth/login (старый)', await call('/auth/login', {
    method: 'POST',
    body: { nickname: 'Аня', password: 'anya-password' }
  }));
  show('POST /auth/login (новый)', await call('/auth/login', {
    method: 'POST',
    body: { nickname: 'Аня', password: 'anya-new-password' }
  }));

  step('12. Ссылка одноразовая');
  show('POST /auth/reset-password (повтор)', await call('/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, newPassword: 'another-password' }
  }));
}

main().catch(error => {
  console.error('Ошибка демонстрации:', error.message);
  process.exitCode = 1;
});
