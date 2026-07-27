// utils/achievements.js

// ============================================================
// ДОСТИЖЕНИЯ (ГЕЙМИФИКАЦИЯ)
// ============================================================

// Список базовых достижений (по количеству действий)
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
};

// ============================================================
// 1. БАЗОВЫЕ ДОСТИЖЕНИЯ (по счётчикам)
// ============================================================
function getBasicAchievements(ratingsCount, reviewsCount, commentsCount) {
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

// ============================================================
// 2. СПЕЦИАЛЬНЫЕ ДОСТИЖЕНИЯ (требуют запросов к БД)
// ============================================================
async function getSpecialAchievements(userId, db) {
  const earned = [];

  const ratingsCollection = db.collection('ratings');
  const commentsCollection = db.collection('comments');
  const filmsCollection = db.collection('films');
  const usersCollection = db.collection('users');

  // --- Высокие оценки (80+) ---
  const highRatings = await ratingsCollection
    .find({ userId, finalScore: { $gte: 80 } })
    .toArray();
  if (highRatings.length >= 1) earned.push('🎯 Меткий стрелок');
  if (highRatings.length >= 5) earned.push('⭐ Ценитель шедевров');

  // --- Оценки 90 (шедевры) ---
  const masterpieces = await ratingsCollection
    .find({ userId, finalScore: 90 })
    .toArray();
  if (masterpieces.length >= 1) earned.push('👑 Гурман');

  // --- Лайки на комментариях (полученные автором) ---
  const likedComments = await commentsCollection
    .find({ userId, likes: { $exists: true, $ne: [] } })
    .toArray();
  if (likedComments.length >= 5) earned.push('🤝 Дружелюбный');

  // --- Добавленные фильмы ---
  const importedFilms = await filmsCollection.countDocuments({ createdBy: userId });
  if (importedFilms >= 1) earned.push('🎪 Меценат');

  // --- ПЕРВЫЙ КАДР: первые 100 зарегистрированных пользователей ---
  const totalUsers = await usersCollection.countDocuments();
  
  if (totalUsers <= 100) {
    // Проверяем, есть ли у пользователя хоть какое-то действие
    const hasActivity = await ratingsCollection.findOne({ userId }) ||
                        await db.collection('reviews').findOne({ userId }) ||
                        await commentsCollection.findOne({ userId });
    
    if (hasActivity) {
      earned.push('🎬 Первый кадр');
    }
  }

  return earned;
}

// ============================================================
// 3. ГЛАВНАЯ ФУНКЦИЯ (используется в бэкенде)
// ============================================================
/**
 * Возвращает ВСЕ достижения пользователя (базовые + специальные)
 * @param {string} userId - ObjectId пользователя
 * @param {import('mongodb').Db} db - экземпляр базы данных
 * @param {number} ratingsCount - количество оценок (можно передать готовое, чтобы избежать лишнего запроса)
 * @param {number} reviewsCount - количество одобренных рецензий
 * @param {number} commentsCount - количество одобренных комментариев
 * @returns {Promise<string[]>} массив названий достижений
 */
async function getUserAchievements(userId, db, ratingsCount, reviewsCount, commentsCount) {
  // Базовые
  const basic = getBasicAchievements(ratingsCount, reviewsCount, commentsCount);
  // Специальные
  const special = await getSpecialAchievements(userId, db);
  // Объединяем и убираем дубли
  return [...new Set([...basic, ...special])];
}

// ============================================================
// ЭКСПОРТ (для обратной совместимости)
// ============================================================
module.exports = {
  ACHIEVEMENTS,
  getBasicAchievements,
  getSpecialAchievements,
  getUserAchievements,
};
