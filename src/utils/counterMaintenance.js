const User = require('../models/User');
const Rating = require('../models/Rating');
const Review = require('../models/Review');
const Comment = require('../models/Comment');
const Watch = require('../models/Watch');
const WatchlistItem = require('../models/WatchlistItem');
const FilmLike = require('../models/FilmLike');
const Action = require('../models/Action');

const BATCH_SIZE = 500;
// Счётчики, которые пока не считаются ни из одной коллекции. ВАЖНО: processUsers
// делает $set: { counters } целиком, поэтому всё, что не посчитано, обнуляется.
// watchlist убран отсюда в B6, filmLikes — в B7: оба стали реальными коллекциями.
const unsupportedCounters = {
  followers: 0,
  following: 0
};

async function countUserCounters(userId) {
  const [ratings, vibes, reviews, reviewsApproved, comments, commentsApproved, watches, watchlist, filmLikes, likesReceived] = await Promise.all([
    Rating.countDocuments({ userId, completeness: 'full' }),
    Rating.countDocuments({ userId, completeness: 'vibe' }),
    Review.countDocuments({ userId }),
    Review.countDocuments({ userId, status: 'approved' }),
    Comment.countDocuments({ userId }),
    Comment.countDocuments({ userId, status: 'approved' }),
    // B5: дневник — история, поэтому считаются все записи, включая пересмотры.
    Watch.countDocuments({ userId }),
    // B6: watchlist — состояние, одна запись на пару user+film.
    WatchlistItem.countDocuments({ userId }),
    // B7: это ЛИЧНЫЙ счётчик действий — считает все лайки, включая weight: 0.
    // Публичный агрегат Film.likesCount взвешенный и живёт в Film.
    FilmLike.countDocuments({ userId }),
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
    watchlist,
    filmLikes,
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