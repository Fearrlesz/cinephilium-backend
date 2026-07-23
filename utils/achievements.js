// ============================================================
// ДОСТИЖЕНИЯ (ГЕЙМИФИКАЦИЯ)
// ============================================================

// Список всех достижений
const ACHIEVEMENTS = {
  FIRST_RATING: '🎬 Первый шаг',
  RATING_10: '⭐ Кинолюбитель',
  RATING_50: '🔥 Энтузиаст',
  RATING_100: '👑 Кинолегенда',
  FIRST_REVIEW: '📝 Критик',
  REVIEW_5: '✍️ Мастер слова',
  RATING_25: '🎯 Ценитель кино',
  FIRST_COMMENT: '💬 Первое слово',
  COMMENT_10: '🗣️ Активный зритель',
};

// Функция расчёта достижений
function getAchievements(ratingsCount, reviewsCount, commentsCount) {
  const earned = [];
  
  if (ratingsCount >= 1) earned.push(ACHIEVEMENTS.FIRST_RATING);
  if (ratingsCount >= 10) earned.push(ACHIEVEMENTS.RATING_10);
  if (ratingsCount >= 25) earned.push(ACHIEVEMENTS.RATING_25);
  if (ratingsCount >= 50) earned.push(ACHIEVEMENTS.RATING_50);
  if (ratingsCount >= 100) earned.push(ACHIEVEMENTS.RATING_100);
  
  if (reviewsCount >= 1) earned.push(ACHIEVEMENTS.FIRST_REVIEW);
  if (reviewsCount >= 5) earned.push(ACHIEVEMENTS.REVIEW_5);
  
  if (commentsCount >= 1) earned.push(ACHIEVEMENTS.FIRST_COMMENT);
  if (commentsCount >= 10) earned.push(ACHIEVEMENTS.COMMENT_10);
  
  return earned;
}

module.exports = { ACHIEVEMENTS, getAchievements };
