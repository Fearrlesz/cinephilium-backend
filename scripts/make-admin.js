#!/usr/bin/env node
/**
 * Выдать или снять права администратора из терминала.
 *
 *   node scripts/make-admin.js Аня              # сделать админом
 *   node scripts/make-admin.js Аня --revoke     # снять права
 *
 * Нужна та же MONGODB_URI, что в .env — скрипт работает напрямую с базой,
 * поэтому годится и для случая, когда админов не осталось вовсе.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../src/models/User');

function parseArgs(argv) {
  const nicknames = [];
  let revoke = false;

  for (const arg of argv) {
    if (arg === '--revoke') revoke = true;
    else if (!arg.startsWith('--')) nicknames.push(arg);
  }

  return { nickname: nicknames.join(' ').trim(), revoke };
}

async function main() {
  const { nickname, revoke } = parseArgs(process.argv.slice(2));

  if (!nickname) {
    console.error('Укажи никнейм: node scripts/make-admin.js <никнейм> [--revoke]');
    process.exitCode = 1;
    return;
  }
  if (!process.env.MONGODB_URI) {
    console.error('Не задан MONGODB_URI (проверь .env)');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ nickname });
  if (!user) {
    console.error(`Пользователь «${nickname}» не найден`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  if (revoke) {
    const admins = await User.countDocuments({ isAdmin: true });
    if (user.isAdmin && admins <= 1) {
      console.error('Это последний администратор — снять права нельзя');
      process.exitCode = 1;
      await mongoose.disconnect();
      return;
    }
  }

  if (user.isAdmin === !revoke) {
    console.log(`«${user.nickname}» уже ${revoke ? 'не админ' : 'админ'} — ничего не изменилось`);
    await mongoose.disconnect();
    return;
  }

  user.isAdmin = !revoke;
  await user.save();

  console.log(
    revoke
      ? `Права администратора сняты: ${user.nickname}`
      : `Теперь администратор: ${user.nickname} (id ${user._id})`
  );

  await mongoose.disconnect();
}

main().catch(async error => {
  console.error('Ошибка:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
