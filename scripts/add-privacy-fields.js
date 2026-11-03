#!/usr/bin/env node
/**
 * B-PRIVACY: флаги приватности у всех пользователей.
 *
 * Что делает (идемпотентно):
 *   1. User без privacy → privacy: { hideProfile: false, hideFromFeed: false }.
 *   2. User с частично заполненным privacy → дозаполняет недостающие флаги.
 *
 * Запуск:
 *   node scripts/add-privacy-fields.js --dry-run   # только считает
 *   node scripts/add-privacy-fields.js             # боевой прогон
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../src/models/User');

const FULL_PRIVACY = { hideProfile: false, hideFromFeed: false };

async function migrate({ dryRun = false, logger = console } = {}) {
  const missingWhole = { $or: [{ privacy: { $exists: false } }, { privacy: null }] };
  const missingHideProfile = {
    'privacy.hideProfile': { $exists: false }
  };
  const missingHideFromFeed = {
    'privacy.hideFromFeed': { $exists: false }
  };

  const withoutPrivacy = await User.countDocuments(missingWhole);
  const withoutHideProfile = await User.countDocuments(missingHideProfile);
  const withoutHideFromFeed = await User.countDocuments(missingHideFromFeed);

  logger.log(
    `[add-privacy] ${dryRun ? 'dry-run' : 'apply'}: ` +
    `users без privacy=${withoutPrivacy}, без hideProfile=${withoutHideProfile}, ` +
    `без hideFromFeed=${withoutHideFromFeed}`
  );

  let updated = 0;

  if (!dryRun) {
    // Порядок важен: сначала целиком пустой объект, потом частичные случаи —
    // второй шаг не должен перетереть уже выставленные значения.
    const whole = await User.collection.updateMany(missingWhole, { $set: { privacy: FULL_PRIVACY } });
    updated += whole.modifiedCount || 0;

    const hideProfile = await User.collection.updateMany(
      missingHideProfile,
      { $set: { 'privacy.hideProfile': false } }
    );
    updated += hideProfile.modifiedCount || 0;

    const hideFromFeed = await User.collection.updateMany(
      missingHideFromFeed,
      { $set: { 'privacy.hideFromFeed': false } }
    );
    updated += hideFromFeed.modifiedCount || 0;

    logger.log(`[add-privacy] обновлено users=${updated}`);
  }

  return { dryRun, withoutPrivacy, withoutHideProfile, withoutHideFromFeed, updated };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');

  (async () => {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI не задан');
    }

    await mongoose.connect(process.env.MONGODB_URI);
    const result = await migrate({ dryRun });
    console.log(`[add-privacy] итог: ${JSON.stringify(result)}`);
    await mongoose.disconnect();
  })().catch(async error => {
    console.error('[add-privacy] ошибка:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { migrate, FULL_PRIVACY };
