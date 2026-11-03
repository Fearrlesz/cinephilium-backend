#!/usr/bin/env node
/**
 * B-PRIVACY: Event.userId — автор события отдельным полем (вариант A).
 *
 * Старые события матчатся по нику: ник уникален и не меняется (AGENT_CONTEXT §5).
 * Скрипт идемпотентен: повторный прогон находит 0 событий без userId.
 *
 * Правило по несматченным (из спецификации):
 *   - 0 — норма;
 *   - ровно 1 — осиротевшее событие (удалённый пользователь): пропускаем с логом;
 *   - больше 1 — СТОП: это уже не одиночный случай, нужен разбор. Миграция
 *     ничего не пишет и завершается с кодом 1.
 *
 * Запуск:
 *   node scripts/add-event-userid.js --dry-run
 *   node scripts/add-event-userid.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const Event = require('../src/models/Event');
const User = require('../src/models/User');

async function migrate({ dryRun = false, logger = console } = {}) {
  const missing = { $or: [{ userId: { $exists: false } }, { userId: null }] };

  const total = await Event.countDocuments(missing);
  const events = await Event.find(missing).select('_id user').lean();

  const nicknames = [...new Set(events.map(event => String(event.user || '')))];
  const users = nicknames.length > 0
    ? await User.find({ nickname: { $in: nicknames } }).select('_id nickname').lean()
    : [];
  const byNickname = new Map(users.map(user => [user.nickname, user._id]));

  const matched = [];
  const unmatched = [];

  for (const event of events) {
    const userId = byNickname.get(String(event.user || ''));
    if (userId) matched.push({ eventId: event._id, userId });
    else unmatched.push(event);
  }

  logger.log(
    `[add-event-userid] ${dryRun ? 'dry-run' : 'apply'}: ` +
    `events без userId=${total}, сматчено=${matched.length}, без пользователя=${unmatched.length}`
  );

  for (const event of unmatched) {
    logger.log(`[add-event-userid] не найден пользователь: event=${event._id} user="${event.user}"`);
  }

  if (unmatched.length > 1) {
    // Спецификация: несколько несматченных — стоп и вопрос, а не «пропустить с логом».
    // Ничего не пишем: иначе получим частично миграированную базу и ложную уверенность.
    const error = new Error(
      `несматченных событий ${unmatched.length} (>1) — нужен разбор, миграция остановлена, записи не изменены`
    );
    error.code = 'MASS_MISMATCH';
    throw error;
  }

  let updated = 0;

  if (!dryRun) {
    for (const { eventId, userId } of matched) {
      const result = await Event.collection.updateOne({ _id: eventId }, { $set: { userId } });
      updated += result.modifiedCount || 0;
    }

    if (unmatched.length === 1) {
      logger.log('[add-event-userid] одно осиротевшее событие пропущено (вероятно, удалённый пользователь)');
    }

    logger.log(`[add-event-userid] обновлено events=${updated}`);
  }

  return { dryRun, total, matched: matched.length, unmatched: unmatched.length, updated };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI не задан');
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const result = await migrate({ dryRun });
    console.log(`[add-event-userid] итог: ${JSON.stringify(result)}`);
    await mongoose.disconnect();
  })().catch(async error => {
    console.error('[add-event-userid] ошибка:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { migrate };
