#!/usr/bin/env node
/**
 * B7: сверка публичного счётчика сердечек.
 *
 * Film.likesCount должен равняться количеству FilmLike этого фильма с weight > 0
 * (DECISION B7/2A). Скрипт считает фактическое значение и исправляет расхождения.
 *
 * Запуск:
 *   node scripts/reconcile-film-likes.js --dry-run
 *   node scripts/reconcile-film-likes.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Film = require('../src/models/Film');
const FilmLike = require('../src/models/FilmLike');

async function reconcile({ dryRun = false, logger = console } = {}) {
  // Один проход по лайкам: группировка по фильму, только активные (weight > 0).
  const groups = await FilmLike.aggregate([
    { $match: { weight: { $gt: 0 } } },
    { $group: { _id: '$filmId', total: { $sum: 1 } } }
  ]);
  const expected = new Map(groups.map(group => [String(group._id), group.total]));

  const films = await Film.find().select('_id likesCount').lean();

  let mismatched = 0;
  let fixed = 0;

  for (const film of films) {
    const want = expected.get(String(film._id)) || 0;
    const actual = film.likesCount || 0;
    if (want === actual) continue;

    mismatched += 1;
    if (!dryRun) {
      await Film.updateOne({ _id: film._id }, { $set: { likesCount: want } });
      fixed += 1;
    }
  }

  logger.log(
    `[reconcile-film-likes] ${dryRun ? 'dry-run' : 'apply'}: ` +
    `films=${films.length}, расхождений=${mismatched}` +
    (dryRun ? '' : `, исправлено=${fixed}`)
  );

  return { dryRun, films: films.length, mismatched, fixed };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI не задан');
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const result = await reconcile({ dryRun });
    console.log(`[reconcile-film-likes] итог: ${JSON.stringify(result)}`);
    await mongoose.disconnect();
  })().catch(async error => {
    console.error('[reconcile-film-likes] ошибка:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { reconcile };
