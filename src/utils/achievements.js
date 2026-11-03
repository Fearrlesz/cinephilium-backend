// utils/achievements.js

const mongoose = require('mongoose');

// ============================================================
// ДОСТИЖЕНИЯ (ГЕЙМИФИКАЦИЯ)
// ============================================================

const ACHIEVEMENTS = {
  FIRST_VIBE: '💭 Первое впечатление',
  FIRST_RATING: '🎬 Первый шаг',
  RATING_20: '⭐ Кинолюбитель',
  RATING_50: '🎯 Ценитель кино',
  RATING_100: '🔥 Энтузиаст',
  RATING_200: '👑 Кинолегенда',
  FIRST_REVIEW: '📝 Критик',
  REVIEW_5: '✍️ Мастер слова',
  FIRST_COMMENT: '💬 Первое слово',
  COMMENT_10: '🗣️ Активный зритель',
  FIRST_FRAME: '🎬 Первый кадр',
};

// Одна глубокая оценка весит как пять vibe-оценок.
function effectiveRatings(ratingsCount = 0, vibesCount = 0) {
  return Number(ratingsCount) + Number(vibesCount) / 5;
}

function getBasicAchievements(ratingsCount = 0, vibesCount = 0, reviewsCount = 0, commentsCount = 0) {
  const earned = [];

  // FIRST_RATING — именно за первую полную оценку, а не за 5 vibe.
  if (ratingsCount >= 1) earned.push(ACHIEVEMENTS.FIRST_RATING);
  if (vibesCount >= 1) earned.push(ACHIEVEMENTS.FIRST_VIBE);

  const effective = effectiveRatings(ratingsCount, vibesCount);
  if (effective >= 20)  earned.push(ACHIEVEMENTS.RATING_20);
  if (effective >= 50)  earned.push(ACHIEVEMENTS.RATING_50);
  if (effective >= 100) earned.push(ACHIEVEMENTS.RATING_100);
  if (effective >= 200) earned.push(ACHIEVEMENTS.RATING_200);

  if (reviewsCount >= 1) earned.push(ACHIEVEMENTS.FIRST_REVIEW);
  if (reviewsCount >= 5) earned.push(ACHIEVEMENTS.REVIEW_5);

  if (commentsCount >= 1)  earned.push(ACHIEVEMENTS.FIRST_COMMENT);
  if (commentsCount >= 10) earned.push(ACHIEVEMENTS.COMMENT_10);

  return earned;
}

async function getSpecialAchievements(userId, db, ratingsCount = 0) {
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

  // «Первый кадр» — первый сотне и только тем, у кого есть хотя бы одна
  // полная оценка. Уже выданные достижения не отбираются: updateAchievements
  // только добавляет новые.
  if (isFirstHundred && ratingsCount >= 1) earned.push(ACHIEVEMENTS.FIRST_FRAME);

  return earned;
}

async function getUserAchievements(userId, db, counters = {}, reviewsCount = 0, commentsCount = 0) {
  const ratingsCount = Number(counters?.ratings) || 0;
  const vibesCount = Number(counters?.vibes) || 0;

  const basic = getBasicAchievements(ratingsCount, vibesCount, reviewsCount, commentsCount);
  const special = await getSpecialAchievements(userId, db, ratingsCount);
  return [...new Set([...basic, ...special])];
}

module.exports = {
  ACHIEVEMENTS,
  effectiveRatings,
  getBasicAchievements,
  getSpecialAchievements,
  getUserAchievements,
};
