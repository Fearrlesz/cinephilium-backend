// utils/achievements.js

// ============================================================
// ДОСТИЖЕНИЯ (ГЕЙМИФИКАЦИЯ)
// ============================================================

// ============================================================
// 1. СПРАВОЧНИК ВСЕХ ДОСТИЖЕНИЙ (с иконками и описаниями)
// ============================================================

const ACHIEVEMENTS_META = {
  '🎬 Первый шаг': {
    id: 'first_rating',
    title: '🎬 Первый шаг',
    icon: '🎬',
    description: 'Поставить первую оценку'
  },
  '⭐ Кинолюбитель': {
    id: 'rating_10',
    title: '⭐ Кинолюбитель',
    icon: '⭐',
    description: 'Поставить 10 оценок'
  },
  '🎯 Ценитель кино': {
    id: 'rating_25',
    title: '🎯 Ценитель кино',
    icon: '🎯',
    description: 'Поставить 25 оценок'
  },
  '🔥 Энтузиаст': {
    id: 'rating_50',
    title: '🔥 Энтузиаст',
    icon: '🔥',
    description: 'Поставить 50 оценок'
  },
  '👑 Кинолегенда': {
    id: 'rating_100',
    title: '👑 Кинолегенда',
    icon: '👑',
    description: 'Поставить 100 оценок'
  },
  '📝 Критик': {
    id: 'first_review',
    title: '📝 Критик',
    icon: '📝',
    description: 'Написать первую рецензию'
  },
  '✍️ Мастер слова': {
    id: 'review_5',
    title: '✍️ Мастер слова',
    icon: '✍️',
    description: 'Написать 5 рецензий'
  },
  '💬 Первое слово': {
    id: 'first_comment',
    title: '💬 Первое слово',
    icon: '💬',
    description: 'Написать первый комментарий'
  },
  '🗣️ Активный зритель': {
    id: 'comment_10',
    title: '🗣️ Активный зритель',
    icon: '🗣️',
    description: 'Написать 10 комментариев'
  },
  '🎯 Меткий стрелок': {
    id: 'sharp_shooter',
    title: '🎯 Меткий стрелок',
    icon: '🎯',
    description: 'Поставить оценку 80+'
  },
  '⭐ Ценитель шедевров': {
    id: 'masterpiece_lover',
    title: '⭐ Ценитель шедевров',
    icon: '⭐',
    description: 'Поставить 5 оценок 80+'
  },
  '👑 Гурман': {
    id: 'gourmet',
    title: '👑 Гурман',
    icon: '👑',
    description: 'Поставить оценку 90'
  },
  '🤝 Дружелюбный': {
    id: 'friendly',
    title: '🤝 Дружелюбный',
    icon: '🤝',
    description: 'Получить 5 лайков на комментариях'
  },
  '🎪 Меценат': {
    id: 'patron',
    title: '🎪 Меценат',
    icon: '🎪',
    description: 'Добавить фильм в каталог'
  },
  '🎬 Первый кадр': {
    id: 'first_frame',
    title: '🎬 Первый кадр',
    icon: '🎬',
    description: 'Быть среди первых 100 пользователей'
  }
};

// ============================================================
// 2. БАЗОВЫЕ ДОСТИЖЕНИЯ (по счётчикам) - возвращаем ОБЪЕКТЫ
// ============================================================
function getBasicAchievements(ratingsCount, reviewsCount, commentsCount) {
  const earned = [];
  
  if (ratingsCount >= 1) earned.push('🎬 Первый шаг');
  if (ratingsCount >= 10) earned.push('⭐ Кинолюбитель');
  if (ratingsCount >= 25) earned.push('🎯 Ценитель кино');
  if (ratingsCount >= 50) earned.push('🔥 Энтузиаст');
  if (ratingsCount >= 100) earned.push('👑 Кинолегенда');
  
  if (reviewsCount >= 1) earned.push('📝 Критик');
  if (reviewsCount >= 5) earned.push('✍️ Мастер слова');
  
  if (commentsCount >= 1) earned.push('💬 Первое слово');
  if (commentsCount >= 10) earned.push('🗣️ Активный зритель');
  
  // Преобразуем названия в объекты через справочник
  return earned.map(name => {
    const meta = ACHIEVEMENTS_META[name];
    return meta ? { ...meta, earnedAt: new Date() } : { id: name, title: name, icon: '🏅', description: '', earnedAt: new Date() };
  });
}

// ============================================================
// 3. СПЕЦИАЛЬНЫЕ ДОСТИЖЕНИЯ - возвращаем ОБЪЕКТЫ
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

  // --- Лайки на комментариях ---
  const likedComments = await commentsCollection
    .find({ userId, likes: { $exists: true, $ne: [] } })
    .toArray();
  if (likedComments.length >= 5) earned.push('🤝 Дружелюбный');

  // --- Добавленные фильмы ---
  const importedFilms = await filmsCollection.countDocuments({ createdBy: userId });
  if (importedFilms >= 1) earned.push('🎪 Меценат');

  // --- Первый кадр ---
  const totalUsers = await usersCollection.countDocuments();
  if (totalUsers <= 100) {
    const hasActivity = await ratingsCollection.findOne({ userId }) ||
                        await db.collection('reviews').findOne({ userId }) ||
                        await commentsCollection.findOne({ userId });
    if (hasActivity) {
      earned.push('🎬 Первый кадр');
    }
  }

  // Преобразуем названия в объекты через справочник
  return earned.map(name => {
    const meta = ACHIEVEMENTS_META[name];
    return meta ? { ...meta, earnedAt: new Date() } : { id: name, title: name, icon: '🏅', description: '', earnedAt: new Date() };
  });
}

// ============================================================
// 4. ГЛАВНАЯ ФУНКЦИЯ - возвращает ОБЪЕКТЫ
// ============================================================
async function getUserAchievements(userId, db, ratingsCount, reviewsCount, commentsCount) {
  const basic = getBasicAchievements(ratingsCount, reviewsCount, commentsCount);
  const special = await getSpecialAchievements(userId, db);
  
  // Объединяем и убираем дубли по id
  const all = [...basic, ...special];
  const unique = all.filter((obj, index, self) => 
    index === self.findIndex(o => o.id === obj.id)
  );
  
  return unique;
}

// ============================================================
// 5. ЭКСПОРТ
// ============================================================
module.exports = {
  ACHIEVEMENTS_META,
  getBasicAchievements,
  getSpecialAchievements,
  getUserAchievements,
};
