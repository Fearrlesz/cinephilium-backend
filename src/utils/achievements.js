// utils/achievements.js

const mongoose = require('mongoose');

// ============================================================
// ДОСТИЖЕНИЯ (ГЕЙМИФИКАЦИЯ)
// ============================================================

const ACHIEVEMENTS = {
  FIRST_RATING: '🎬 Первый шаг',
  RATING_10: '⭐ Кинолюбитель',
  RATING_25: '🎯 Ценитель кино',
  RATING_50: '🔥 Энтузиаст',
  RATING_100: '👑 Кинолегенда',
  FIRST_REVIEW: '📝 Критик',
  REVIEW_5: '✍️ Мастер слова',
  FIRST_COMMENT: '💬 Первое слово',
  COMMENT_10: '🗣️ Активный зритель',
  FIRST_FRAME: '🎬 Первый кадр',
};

function getBasicAchievements(ratingsCount, reviewsCount, commentsCount) {
  const earned = [];

  if (ratingsCount >= 1)   earned.push(ACHIEVEMENTS.FIRST_RATING);
  if (ratingsCount >= 10)  earned.push(ACHIEVEMENTS.RATING_10);
  if (ratingsCount >= 25)  earned.push(ACHIEVEMENTS.RATING_25);
  if (ratingsCount >= 50)  earned.push(ACHIEVEMENTS.RATING_50);
  if (ratingsCount >= 100) earned.push(ACHIEVEMENTS.RATING_100);

  if (reviewsCount >= 1) earned.push(ACHIEVEMENTS.FIRST_REVIEW);
  if (reviewsCount >= 5) earned.push(ACHIEVEMENTS.REVIEW_5);

  if (commentsCount >= 1)  earned.push(ACHIEVEMENTS.FIRST_COMMENT);
  if (commentsCount >= 10) earned.push(ACHIEVEMENTS.COMMENT_10);

  return earned;
}

async function getSpecialAchievements(userId, db) {
  const earned = [];

  const uid = mongoose.Types.ObjectId.isValid(userId)
    ? new mongoose.Types.ObjectId(userId)
    : userId;

  const ratingsCollection  = db.collection('ratings');
  const commentsCollection = db.collection('comments');
  const filmsCollection    = db.collection('films');
  const usersCollection    = db.collection('users');

  const highRatings = await ratingsCollection
    .find({ userId: uid, combinedScore: { $gte: 80 } })
    .toArray();
  if (highRatings.length >= 1) earned.push('🎯 Меткий стрелок');
  if (highRatings.length >= 5) earned.push('⭐ Ценитель шедевров');

  const masterpieces = await ratingsCollection
    .find({ userId: uid, combinedScore: 90 })
    .toArray();
  if (masterpieces.length >= 1) earned.push('👑 Гурман');

  const likedComments = await commentsCollection
    .find({ userId: uid, likes: { $exists: true, $ne: [] } })
    .toArray();
  if (likedComments.length >= 5) earned.push('🤝 Дружелюбный');

  const importedFilms = await filmsCollection.countDocuments({ createdBy: uid });
  if (importedFilms >= 1) earned.push('🎪 Меценат');

  const firstHundredUsers = await usersCollection
    .find({}, { projection: { _id: 1 } })
    .sort({ _id: 1 })
    .limit(100)
    .toArray();

  const isFirstHundred = firstHundredUsers.some(
    (u) => u._id.toString() === userId.toString()
  );

  if (isFirstHundred) earned.push(ACHIEVEMENTS.FIRST_FRAME);

  return earned;
}

async function getUserAchievements(userId, db, ratingsCount, reviewsCount, commentsCount) {
  const basic = getBasicAchievements(ratingsCount, reviewsCount, commentsCount);
  const special = await getSpecialAchievements(userId, db);
  return [...new Set([...basic, ...special])];
}

module.exports = {
  ACHIEVEMENTS,
  getBasicAchievements,
  getSpecialAchievements,
  getUserAchievements,
};
