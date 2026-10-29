#!/usr/bin/env node
/**
 * B5: миграция дневника просмотров.
 *
 * Что делает (идемпотентно):
 *   1. User без counters.watches → 0.
 *   2. Затем counters.watches выставляется по факту: количество записей Watch
 *      у пользователя (источник правды — сама коллекция, а не догадка).
 *   3. User без diaryPrivate → false (дневник открыт по умолчанию, DECISION B5/3).
 *
 * Запуск:
 *   node scripts/migrate-b5-watches.js --dry-run   # только счётчики
 *   node scripts/migrate-b5-watches.js             # боевой прогон
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Watch = require('../src/models/Watch');
const User = require('../src/models/User');

async function migrate({ dryRun = false, logger = console } = {}) {
  const withoutCounter = {
    $or: [{ 'counters.watches': { $exists: false } }, { 'counters.watches': null }]
  };
  const withoutPrivacy = {
    $or: [{ diaryPrivate: { $exists: false } }, { diaryPrivate: null }]
  };

  const usersWithoutCounter = await User.countDocuments(withoutCounter);
  const usersWithoutPrivacy = await User.countDocuments(withoutPrivacy);

  // Группировка по пользователю: даже если записи уже есть, счётчик будет верным.
  const groups = await Watch.aggregate([
    { $group: { _id: '$userId', total: { $sum: 1 } } }
  ]);

  logger.log(
    `[migrate-b5] ${dryRun ? 'dry-run' : 'apply'}: ` +
    `users без counters.watches=${usersWithoutCounter}, ` +
    `users без diaryPrivate=${usersWithoutPrivacy}, ` +
    `пользователей с записями=${groups.length}`
  );

  let usersUpdated = 0;
  let countersSet = 0;

  if (!dryRun) {
    const privacyResult = await User.collection.updateMany(
      withoutPrivacy,
      { $set: { diaryPrivate: false } }
    );
    usersUpdated += privacyResult.modifiedCount || 0;

    const zeroResult = await User.collection.updateMany(
      withoutCounter,
      { $set: { 'counters.watches': 0 } }
    );
    usersUpdated += zeroResult.modifiedCount || 0;

    for (const group of groups) {
      const result = await User.collection.updateOne(
        { _id: group._id },
        { $set: { 'counters.watches': group.total } }
      );
      countersSet += result.modifiedCount || 0;
    }

    logger.log(`[migrate-b5] обновлено: users=${usersUpdated}, counters.watches=${countersSet}`);
  }

  return {
    dryRun,
    usersWithoutCounter,
    usersWithoutPrivacy,
    usersWithWatches: groups.length,
    usersUpdated,
    countersSet
  };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI не задан');
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const result = await migrate({ dryRun });
    console.log(`[migrate-b5] итог: ${JSON.stringify(result)}`);
    await mongoose.disconnect();
  })().catch(async error => {
    console.error('[migrate-b5] ошибка:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { migrate };
