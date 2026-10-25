#!/usr/bin/env node
/**
 * Выдача инвайт-кодов из терминала — на случай, когда админки под рукой нет
 * или нужно создать самый первый доступ на пустой базе.
 *
 *   node scripts/new-invite.js                # 1 код
 *   node scripts/new-invite.js 5              # 5 кодов
 *   node scripts/new-invite.js 3 --note "друзья" --days 30
 *
 * Коды печатаются один раз: в базе лежат только их хеши.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Invite = require('../src/models/Invite');
const { generateInviteCode, hashToken } = require('../src/utils/tokens');

function parseArgs(argv) {
  const args = { quantity: 1, note: '', days: Number(process.env.INVITE_TTL_DAYS || 0) };
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--note') {
      args.note = String(argv[i + 1] || '');
      i += 1;
    } else if (arg === '--days') {
      args.days = Number(argv[i + 1] || 0);
      i += 1;
    } else {
      rest.push(arg);
    }
  }

  if (rest[0]) args.quantity = Number(rest[0]);
  return args;
}

async function main() {
  const { quantity, note, days } = parseArgs(process.argv.slice(2));

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    console.error('Количество кодов — целое число от 1 до 50');
    process.exitCode = 1;
    return;
  }

  if (!process.env.MONGODB_URI) {
    console.error('Не задан MONGODB_URI (проверь .env)');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const expiresAt = days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
  const codes = [];
  const docs = [];

  for (let i = 0; i < quantity; i += 1) {
    const code = generateInviteCode();
    codes.push(code);
    docs.push({
      codeHash: hashToken(code.replace('-', '')),
      codePrefix: code.slice(0, 4),
      note,
      expiresAt
    });
  }

  await Invite.insertMany(docs);

  console.log(`Создано кодов: ${codes.length}${expiresAt ? `, действуют до ${expiresAt.toISOString()}` : ', бессрочные'}`);
  for (const code of codes) console.log(`  ${code}`);
  console.log('\nКоды показываются один раз — сохрани их сейчас.');

  await mongoose.disconnect();
}

main().catch(async error => {
  console.error('Ошибка:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
