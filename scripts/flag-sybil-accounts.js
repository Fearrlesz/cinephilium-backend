#!/usr/bin/env node
/**
 * Детектор аккаунтов-ферм.
 *
 * Ферма выглядит так: несколько аккаунтов регистрируются с одного IP за короткое
 * время и ставят оценки, чтобы раздуть средний балл фильма. Скрипт находит такие
 * кластеры и обнуляет вес их голосов:
 *   User.trustWeight = 0  — новые оценки аккаунта тоже не будут учитываться;
 *   Rating.weight    = 0  — уже поставленные оценки исключаются из агрегатов.
 *
 * Использование:
 *   node scripts/flag-sybil-accounts.js --dry-run
 *   node scripts/flag-sybil-accounts.js --min-accounts=5 --window-hours=1
 *   node scripts/flag-sybil-accounts.js --unflag
 *
 * Порог по умолчанию намеренно консервативный: 5 аккаунтов за 1 час с одного IP.
 * Это не трогает семью/офис, но ловит массовую регистрацию.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../src/models/User');
const Rating = require('../src/models/Rating');

async function findSybilClusters({ minAccounts = 5, windowHours = 1 } = {}) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  return User.aggregate([
    {
      $match: {
        registeredIp: { $nin: ['', null] },
        registeredAt: { $gte: since }
      }
    },
    {
      $group: {
        _id: '$registeredIp',
        userIds: { $push: '$_id' },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gte: minAccounts } } },
    { $sort: { count: -1 } }
  ]);
}

async function flagSybilAccounts({ minAccounts = 5, windowHours = 1, dryRun = false } = {}) {
  const clusters = await findSybilClusters({ minAccounts, windowHours });

  const details = [];
  let flaggedUsers = 0;
  let ratingsUpdated = 0;

  for (const cluster of clusters) {
    const ids = cluster.userIds;
    details.push({ ip: cluster._id, accounts: cluster.count });

    if (dryRun) continue;

    await User.updateMany(
      { _id: { $in: ids } },
      { $set: { flagged: true, trustWeight: 0 } }
    );
    const result = await Rating.updateMany(
      { userId: { $in: ids } },
      { $set: { weight: 0 } }
    );

    flaggedUsers += ids.length;
    ratingsUpdated += result.modifiedCount || 0;
  }

  return { clusters: clusters.length, flaggedUsers, ratingsUpdated, dryRun, details };
}

async function unflagAll() {
  const users = await User.updateMany(
    { flagged: true },
    { $set: { flagged: false, trustWeight: 1 } }
  );
  const ratings = await Rating.updateMany(
    { weight: 0 },
    { $set: { weight: 1 } }
  );
  return { unflaggedUsers: users.modifiedCount || 0, ratingsRestored: ratings.modifiedCount || 0 };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const has = flag => args.includes(flag);
  const num = (name, fallback) => {
    const arg = args.find(item => item.startsWith(`--${name}=`));
    return arg ? Number(arg.split('=')[1]) : fallback;
  };

  (async () => {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI не задан');
    }
    await mongoose.connect(process.env.MONGODB_URI);

    if (has('--unflag')) {
      const result = await unflagAll();
      console.log('Снято с учёта:', result);
    } else {
      const result = await flagSybilAccounts({
        minAccounts: num('min-accounts', 5),
        windowHours: num('window-hours', 1),
        dryRun: has('--dry-run')
      });
      console.log(result.dryRun ? 'Найдено (dry-run):' : 'Помечено:', result);
    }

    await mongoose.disconnect();
  })().catch(error => {
    console.error('Ошибка:', error.message);
    process.exit(1);
  });
}

module.exports = { findSybilClusters, flagSybilAccounts, unflagAll };
