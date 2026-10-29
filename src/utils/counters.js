const User = require('../models/User');

const counterFields = new Set([
  'ratings',
  'vibes',
  'reviews',
  'reviewsApproved',
  'comments',
  'commentsApproved',
  'filmLikes',
  'watches',
  'watchlist',
  'followers',
  'following',
  'likesReceived'
]);

async function incCounter(userId, field, delta = 1) {
  if (!userId || !counterFields.has(field) || typeof delta !== 'number' || !Number.isFinite(delta)) {
    throw new Error('incCounter: bad args');
  }

  const path = `counters.${field}`;
  if (delta < 0) {
    return User.updateOne(
      { _id: userId, [path]: { $gte: Math.abs(delta) } },
      { $inc: { [path]: delta } }
    );
  }

  return User.updateOne({ _id: userId }, { $inc: { [path]: delta } });
}

module.exports = { incCounter };