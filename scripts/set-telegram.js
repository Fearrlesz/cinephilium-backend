#!/usr/bin/env node
/**
 * Задать телеграм пользователя (обычно админа) из терминала.
 *
 *   node scripts/set-telegram.js ss asduna_piu
 *   node scripts/set-telegram.js ss @asduna_piu
 *   node scripts/set-telegram.js ss https://t.me/asduna_piu
 *   node scripts/set-telegram.js ss ""            # очистить
 *
 * Телеграм показывается на странице «Связь с админами».
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../src/models/User');
const { normalizeTelegram, isValidTelegram } = require('../src/utils/telegram');

async function main() {
  const [nickname, rawHandle] = process.argv.slice(2);

  if (!nickname) {
    console.error('Укажи никнейм: node scripts/set-telegram.js <никнейм> <@телеграм>');
    process.exitCode = 1;
    return;
  }
  if (!process.env.MONGODB_URI) {
    console.error('Не задан MONGODB_URI (проверь .env)');
    process.exitCode = 1;
    return;
  }

  const handle = normalizeTelegram(rawHandle);
  if (handle && !isValidTelegram(handle)) {
    console.error('Телеграм должен быть вида @nickname (3–32 символа: буквы, цифры, подчёркивание)');
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

  user.telegram = handle;
  await user.save();

  console.log(handle
    ? `Телеграм «${user.nickname}»: @${handle}`
    : `Телеграм «${user.nickname}» очищен`);

  await mongoose.disconnect();
}

main().catch(async error => {
  console.error('Ошибка:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
