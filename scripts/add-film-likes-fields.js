#!/usr/bin/env node
/**
 * B7: поля сердечек.
 *
 * Что делает (идемпотентно):
 *   1. Film без likesCount → likesCount: 0 (публичный агрегат, DECISION B7/5C).
 *   2. User без counters.filmLikes → 0 (личный счётчик действий).
 *
 * Это ДВА РАЗНЫХ числа: Film.likesCount — сколько сердечек у фильма (weight > 0),
 * counters.filmLikes — сколько лайков поставил человек (включая weight: 0).
 *
 * Запуск:
 *   node scripts/add-film-likes-fields.js --dry-run
 *   node scripts/add-film-likes-fields.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Film = require('../src/models/Film');
const User = require('../src/models/User');

async function migrate({ dryRun = false, logger = console } = {}) {
  const filmFilter = {
    $or: [{ likesCount: { $exists: false } }, { likesCount: null }]
  };
  const userFilter = {
    $or: [{ 'counters.filmLikes': { $exists: false } }, { 'counters.filmLikes': null }]
  };

  const filmsWithoutCount = await Film.countDocuments(filmFilter);
  const usersWithoutCounter = await User.countDocuments(userFilter);

  logger.log(
    `[add-film-likes] ${dryRun ? 'dry-run' : 'apply'}: ` +
    `films без likesCount=${filmsWithoutCount}, users без counters.filmLikes=${usersWithoutCounter}`
  );

  let filmsUpdated = 0;
  let usersUpdated = 0;

  if (!dryRun) {
    const films = await Film.collection.updateMany(filmFilter, { $set: { likesCount: 0 } });
    const users = await User.collection.updateMany(userFilter, { $set: { 'counters.filmLikes': 0 } });

    filmsUpdated = films.modifiedCount || 0;
    usersUpdated = users.modifiedCount || 0;
    logger.log(`[add-film-likes] обновлено: films=${filmsUpdated}, users=${usersUpdated}`);
  }

  return { dryRun, filmsWithoutCount, usersWithoutCounter, filmsUpdated, usersUpdated };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI не задан');
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const result = await migrate({ dryRun });
    console.log(`[add-film-likes] итог: ${JSON.stringify(result)}`);
    await mongoose.disconnect();
  })().catch(async error => {
    console.error('[add-film-likes] ошибка:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { migrate };
