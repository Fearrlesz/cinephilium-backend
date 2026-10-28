#!/usr/bin/env node
/**
 * P1/B1: миграция двухступенчатой оценки.
 *
 * Что делает (идемпотентно):
 *   1. Rating без completeness → completeness: 'full'
 *      (все оценки, сделанные до P1, — полные).
 *   2. User без counters.vibes → counters.vibes: 0.
 *
 * Запуск:
 *   node scripts/migrate-p1-vibe-ratings.js --dry-run   # только счётчики
 *   node scripts/migrate-p1-vibe-ratings.js             # боевой прогон
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Rating = require('../src/models/Rating');
const User = require('../src/models/User');

async function migrate({ dryRun = false, logger = console } = {}) {
  const ratingFilter = {
    $or: [{ completeness: { $exists: false } }, { completeness: null }]
  };
  const userFilter = {
    $or: [{ 'counters.vibes': { $exists: false } }, { 'counters.vibes': null }]
  };

  const ratingsCount = await Rating.countDocuments(ratingFilter);
  const usersCount = await User.countDocuments(userFilter);

  logger.log(
    `[migrate-p1] ${dryRun ? 'dry-run' : 'apply'}: ` +
    `ratings без completeness=${ratingsCount}, users без counters.vibes=${usersCount}`
  );

  let ratingsUpdated = 0;
  let usersUpdated = 0;

  if (!dryRun) {
    const ratingsResult = await Rating.collection.updateMany(
      ratingFilter,
      { $set: { completeness: 'full' } }
    );
    const usersResult = await User.collection.updateMany(
      userFilter,
      { $set: { 'counters.vibes': 0 } }
    );

    ratingsUpdated = ratingsResult.modifiedCount || 0;
    usersUpdated = usersResult.modifiedCount || 0;
    logger.log(`[migrate-p1] обновлено: ratings=${ratingsUpdated}, users=${usersUpdated}`);
  }

  return { dryRun, ratingsCount, usersCount, ratingsUpdated, usersUpdated };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI не задан');
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const result = await migrate({ dryRun });
    console.log(`[migrate-p1] итог: ${JSON.stringify(result)}`);
    await mongoose.disconnect();
  })().catch(async error => {
    console.error('[migrate-p1] ошибка:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { migrate };
