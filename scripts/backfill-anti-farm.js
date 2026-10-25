#!/usr/bin/env node
/**
 * Бэкфилл полей, появившихся в релизе 3.0 (согласия и анти-накрутка).
 *
 * Зачем: Mongoose проставляет значения по умолчанию только новым документам.
 * У старых пользователей/оценок полей weight, ip, trustWeight, flagged,
 * registeredIp, consent просто нет. Код это переживает (проверки написаны
 * через `$ne: 0` / `$exists`), но лучше привести данные к одной форме,
 * чтобы админ-запросы и скрипт детекции работали предсказуемо.
 *
 * Использование:
 *   node scripts/backfill-anti-farm.js --dry-run
 *   node scripts/backfill-anti-farm.js
 *
 * Скрипт идемпотентен: повторный запуск ничего не меняет.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../src/models/User');
const Rating = require('../src/models/Rating');

async function backfillAntiFarm({ dryRun = false } = {}) {
  const plans = [
    { name: 'User.trustWeight', model: User, filter: { trustWeight: { $exists: false } }, set: { trustWeight: 1 } },
    { name: 'User.flagged', model: User, filter: { flagged: { $exists: false } }, set: { flagged: false } },
    { name: 'User.registeredIp', model: User, filter: { registeredIp: { $exists: false } }, set: { registeredIp: '' } },
    { name: 'User.consent', model: User, filter: { consent: { $exists: false } }, set: { consent: null } },
    { name: 'Rating.weight', model: Rating, filter: { weight: { $exists: false } }, set: { weight: 1 } },
    { name: 'Rating.ip', model: Rating, filter: { ip: { $exists: false } }, set: { ip: '' } },
  ];

  const report = [];

  for (const plan of plans) {
    if (dryRun) {
      const count = await plan.model.countDocuments(plan.filter);
      report.push({ field: plan.name, affected: count, updated: 0 });
      continue;
    }
    const result = await plan.model.collection.updateMany(plan.filter, { $set: plan.set });
    report.push({ field: plan.name, affected: result.matchedCount ?? 0, updated: result.modifiedCount ?? 0 });
  }

  let indexes = [];
  if (!dryRun) {
    // Только новые не-уникальные индексы: createIndexes() целиком мог бы
    // упасть на существующих дублях по email/nickname.
    indexes = [
      await User.collection.createIndex({ registeredIp: 1, registeredAt: -1 }),
      await User.collection.createIndex({ flagged: 1 }),
    ];
  }

  return { dryRun, report, indexes };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI не задан');
    await mongoose.connect(process.env.MONGODB_URI);

    const result = await backfillAntiFarm({ dryRun });
    console.table(result.report);
    if (result.indexes.length) console.log('Индексы:', result.indexes);

    await mongoose.disconnect();
  })().catch(error => {
    console.error('Ошибка бэкфилла:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { backfillAntiFarm };
