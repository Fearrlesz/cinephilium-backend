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
const FilmLike = require('../src/models/FilmLike');
const Film = require('../src/models/Film');

/**
 * Пересчитывает Film.likesCount для перечисленных фильмов: публичный счётчик
 * считает только лайки с weight > 0 (DECISION B7/2A).
 *
 * DECISION: B7/recount — при пометке и снятии пометки выбран ПОЛНЫЙ ПЕРЕСЧЁТ
 * затронутых фильмов, а не инкремент на «количество активных лайков».
 * Причины: операция идемпотентна (повторный прогон не уводит счётчик),
 * не накапливает дрейф при частичных сбоях и совпадает по логике с
 * reconcile-film-likes.js. Фильмов у одного кластера немного, цена пересчёта мала.
 */
async function recomputeLikesCounts(filmIds = []) {
  let films = 0;
  let changed = 0;

  for (const filmId of filmIds) {
    const count = await FilmLike.countDocuments({ filmId, weight: { $gt: 0 } });
    const result = await Film.updateOne({ _id: filmId }, { $set: { likesCount: count } });
    films += 1;
    changed += result.modifiedCount || 0;
  }

  return { films, changed };
}

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
  let likesUpdated = 0;
  let filmsRecomputed = 0;

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

    // B7: третье и четвёртое место — вес лайков и публичный счётчик фильмов.
    // Без этого сердечки фермы остались бы в Film.likesCount навсегда.
    const likeFilmIds = await FilmLike.distinct('filmId', { userId: { $in: ids } });
    const likesResult = await FilmLike.updateMany(
      { userId: { $in: ids } },
      { $set: { weight: 0 } }
    );
    const recomputed = await recomputeLikesCounts(likeFilmIds);

    flaggedUsers += ids.length;
    ratingsUpdated += result.modifiedCount || 0;
    likesUpdated += likesResult.modifiedCount || 0;
    filmsRecomputed += recomputed.changed;
  }

  return {
    clusters: clusters.length,
    flaggedUsers,
    ratingsUpdated,
    likesUpdated,
    filmsRecomputed,
    dryRun,
    details
  };
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

  // B7: симметрично возвращаем вес лайкам и пересчитываем счётчики их фильмов.
  const likeFilmIds = await FilmLike.distinct('filmId', { weight: 0 });
  const likes = await FilmLike.updateMany(
    { weight: 0 },
    { $set: { weight: 1 } }
  );
  const recomputed = await recomputeLikesCounts(likeFilmIds);

  return {
    unflaggedUsers: users.modifiedCount || 0,
    ratingsRestored: ratings.modifiedCount || 0,
    likesRestored: likes.modifiedCount || 0,
    filmsRecomputed: recomputed.changed
  };
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

module.exports = { findSybilClusters, flagSybilAccounts, unflagAll, recomputeLikesCounts };
