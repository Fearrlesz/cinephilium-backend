#!/usr/bin/env node
/**
 * B9: закреплённое достижение.
 *
 * Что делает (идемпотентно):
 *   Всем User, у кого поля `pinnedAchievement` нет, ставит `null`.
 *   Пользователей с уже установленным (или явно null) значением не трогает:
 *   источник правды — self-service через PUT /api/users/me/pinned-achievement.
 *
 * Запуск:
 *   node scripts/add-pinned-achievement.js --dry-run
 *   node scripts/add-pinned-achievement.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../src/models/User');

async function migrate({ dryRun = false, logger = console } = {}) {
  const missing = { pinnedAchievement: { $exists: false } };

  const withoutField = await User.countDocuments(missing);
  const totalUsers = await User.estimatedDocumentCount();

  logger.log(
    `[add-pinned-achievement] ${dryRun ? 'dry-run' : 'apply'}: ` +
    `users без pinnedAchievement=${withoutField}, всего users=${totalUsers}`
  );

  let updated = 0;

  if (!dryRun) {
    const result = await User.collection.updateMany(missing, {
      $set: { pinnedAchievement: null }
    });
    updated = result.modifiedCount || 0;

    const skipped = Math.max(0, totalUsers - updated);
    logger.log(
      `[add-pinned-achievement] обновлено users=${updated}, пропущено (поле уже есть)=${skipped}`
    );
  }

  return {
    dryRun,
    withoutField,
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
    console.log(`[add-pinned-achievement] итог: ${JSON.stringify(result)}`);
    await mongoose.disconnect();
  })().catch(async error => {
    console.error('[add-pinned-achievement] ошибка:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { migrate };
