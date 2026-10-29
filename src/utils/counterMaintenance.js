const User = require('../models/User');
const Rating = require('../models/Rating');
const Review = require('../models/Review');
const Comment = require('../models/Comment');
const Watch = require('../models/Watch');
const Action = require('../models/Action');

const BATCH_SIZE = 500;
const unsupportedCounters = {
  filmLikes: 0,
  watchlist: 0,
  followers: 0,
  following: 0
};

async function countUserCounters(userId) {
  const [ratings, vibes, reviews, reviewsApproved, comments, commentsApproved, watches, likesReceived] = await Promise.all([
    Rating.countDocuments({ userId, completeness: 'full' }),
    Rating.countDocuments({ userId, completeness: 'vibe' }),
    Review.countDocuments({ userId }),
    Review.countDocuments({ userId, status: 'approved' }),
    Comment.countDocuments({ userId }),
    Comment.countDocuments({ userId, status: 'approved' }),
    // B5: дневник — история, поэтому считаются все записи, включая пересмотры.
    Watch.countDocuments({ userId }),
    Action.countDocuments({ userId, type: 'like' })
  ]);

  return {
    ratings,
    vibes,
    reviews,
    reviewsApproved,
    comments,
    commentsApproved,
    watches,
    ...unsupportedCounters,
    likesReceived
  };
}

async function processUsers({ reconcile = false } = {}) {
  let processed = 0;
  let errors = 0;
  let batch = [];

  async function processBatch(users) {
    await Promise.all(users.map(async user => {
      try {
        const expected = await countUserCounters(user._id);
        if (reconcile) {
          for (const [field, value] of Object.entries(expected)) {
            const actual = user.counters?.[field] || 0;
            if (actual !== value) {
              console.log(`userId=${user._id} field=${field} expected=${value} actual=${actual}`);
            }
          }
        }

        await User.updateOne({ _id: user._id }, { $set: { counters: expected } });
        processed += 1;
      } catch (error) {
        errors += 1;
        console.error(`userId=${user._id} error=${error.message}`);
      }
    }));
  }

  const cursor = User.find().select('_id counters').lean().cursor({ batchSize: BATCH_SIZE });
  for await (const user of cursor) {
    batch.push(user);
    if (batch.length === BATCH_SIZE) {
      await processBatch(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await processBatch(batch);

  console.log(`processed: ${processed}, errors: ${errors}`);
  return { processed, errors };
}

module.exports = { countUserCounters, processUsers };