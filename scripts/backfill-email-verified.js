const { MONGODB_URI } = require('../src/config/env');
const mongoose = require('mongoose');
const User = require('../src/models/User');

async function backfillEmailVerified() {
  await mongoose.connect(MONGODB_URI);
  const result = await User.collection.updateMany(
    { emailVerified: { $exists: false } },
    { $set: { emailVerified: true } }
  );
  console.log(`Marked ${result.modifiedCount} existing users as email verified`);
}

backfillEmailVerified()
  .catch(error => {
    console.error('Email verification backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());