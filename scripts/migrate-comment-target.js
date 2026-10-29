#!/usr/bin/env node
/**
 * B8: полиморфизм комментариев.
 *
 * Что делает (идемпотентно):
 *   1. Комментарии без targetType → targetType: 'film', targetId: filmId.
 *   2. Страховка: film-комментарии с targetType, но без targetId → targetId: filmId.
 *
 * Старые комментарии все были к фильму, поэтому других вариантов нет (DECISION B8/4A).
 *
 * Запуск:
 *   node scripts/migrate-comment-target.js --dry-run
 *   node scripts/migrate-comment-target.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Comment = require('../src/models/Comment');

async function migrate({ dryRun = false, logger = console } = {}) {
  const missingType = {
    $or: [{ targetType: { $exists: false } }, { targetType: null }]
  };
  const missingTargetId = {
    targetType: 'film',
    $or: [{ targetId: { $exists: false } }, { targetId: null }]
  };

  const withoutType = await Comment.countDocuments(missingType);
  const withoutTargetId = await Comment.countDocuments(missingTargetId);

  logger.log(
    `[migrate-comment-target] ${dryRun ? 'dry-run' : 'apply'}: ` +
    `comments без targetType=${withoutType}, film-комментариев без targetId=${withoutTargetId}`
  );

  let typed = 0;
  let targeted = 0;

  if (!dryRun) {
    // Aggregation-update: targetId ссылается на поле filmId того же документа,
    // поэтому обычный $set со строкой '$filmId' тут не годится.
    const typedResult = await Comment.collection.updateMany(missingType, [
      { $set: { targetType: 'film', targetId: '$filmId' } }
    ]);
    typed = typedResult.modifiedCount || 0;

    const targetResult = await Comment.collection.updateMany(missingTargetId, [
      { $set: { targetId: '$filmId' } }
    ]);
    targeted = targetResult.modifiedCount || 0;

    logger.log(`[migrate-comment-target] обновлено: targetType+targetId=${typed}, targetId=${targeted}`);
  }

  const remaining = dryRun ? withoutType : await Comment.countDocuments(missingType);

  return { dryRun, withoutType, withoutTargetId, typed, targeted, remaining };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI не задан');
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const result = await migrate({ dryRun });
    console.log(`[migrate-comment-target] итог: ${JSON.stringify(result)}`);
    await mongoose.disconnect();
  })().catch(async error => {
    console.error('[migrate-comment-target] ошибка:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { migrate };
