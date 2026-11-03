#!/usr/bin/env node
/**
 * B6: счётчик watchlist.
 *
 * Что делает (идемпотентно):
 *   1. User без counters.watchlist → 0.
 *   2. Затем counters.watchlist выставляется по факту — количеством записей
 *      WatchlistItem (источник правды — коллекция, а не догадка).
 *
 * Запуск:
 *   node scripts/add-watchlist-counters.js --dry-run
 *   node scripts/add-watchlist-counters.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../src/models/User');
const WatchlistItem = require('../src/models/WatchlistItem');

async function migrate({ dryRun = false, logger = console } = {}) {
  const missing = {
    $or: [{ 'counters.watchlist': { $exists: false } }, { 'counters.watchlist': null }]
  };

  const withoutCounter = await User.countDocuments(missing);
  const totalUsers = await User.estimatedDocumentCount();

  const groups = await WatchlistItem.aggregate([
    { $group: { _id: '$userId', total: { $sum: 1 } } }
  ]);

  logger.log(
    `[add-watchlist] ${dryRun ? 'dry-run' : 'apply'}: ` +
    `users без counters.watchlist=${withoutCounter}, ` +
    `пользователей с записями=${groups.length}, всего users=${totalUsers}`
  );

  let updated = 0;

  if (!dryRun) {
    const zero = await User.collection.updateMany(missing, { $set: { 'counters.watchlist': 0 } });
    updated += zero.modifiedCount || 0;

    for (const group of groups) {
      const result = await User.collection.updateOne(
        { _id: group._id },
        { $set: { 'counters.watchlist': group.total } }
      );
      updated += result.modifiedCount || 0;
    }

    const skipped = Math.max(0, totalUsers - updated);
    logger.log(`[add-watchlist] обновлено users=${updated}, пропущено (значение уже верное)=${skipped}`);
  }

  return {
    dryRun,
    withoutCounter,
    usersWithItems: groups.length,
    totalUsers,
    updated,
    skipped: dryRun ? null : Math.max(0, totalUsers - updated)
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
    console.log(`[add-watchlist] итог: ${JSON.stringify(result)}`);
    await mongoose.disconnect();
  })().catch(async error => {
    console.error('[add-watchlist] ошибка:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { migrate };
