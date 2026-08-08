// migrate-force.js
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

// Справочник достижений (скопируйте из achievements.js)
const ACHIEVEMENTS_META = {
  '🎬 Первый шаг': { id: 'first_rating', title: '🎬 Первый шаг', icon: '🎬', description: 'Поставить первую оценку' },
  '⭐ Кинолюбитель': { id: 'rating_10', title: '⭐ Кинолюбитель', icon: '⭐', description: 'Поставить 10 оценок' },
  '🎯 Ценитель кино': { id: 'rating_25', title: '🎯 Ценитель кино', icon: '🎯', description: 'Поставить 25 оценок' },
  '🔥 Энтузиаст': { id: 'rating_50', title: '🔥 Энтузиаст', icon: '🔥', description: 'Поставить 50 оценок' },
  '👑 Кинолегенда': { id: 'rating_100', title: '👑 Кинолегенда', icon: '👑', description: 'Поставить 100 оценок' },
  '📝 Критик': { id: 'first_review', title: '📝 Критик', icon: '📝', description: 'Написать первую рецензию' },
  '✍️ Мастер слова': { id: 'review_5', title: '✍️ Мастер слова', icon: '✍️', description: 'Написать 5 рецензий' },
  '💬 Первое слово': { id: 'first_comment', title: '💬 Первое слово', icon: '💬', description: 'Написать первый комментарий' },
  '🗣️ Активный зритель': { id: 'comment_10', title: '🗣️ Активный зритель', icon: '🗣️', description: 'Написать 10 комментариев' },
  '🎯 Меткий стрелок': { id: 'sharp_shooter', title: '🎯 Меткий стрелок', icon: '🎯', description: 'Поставить оценку 80+' },
  '⭐ Ценитель шедевров': { id: 'masterpiece_lover', title: '⭐ Ценитель шедевров', icon: '⭐', description: 'Поставить 5 оценок 80+' },
  '👑 Гурман': { id: 'gourmet', title: '👑 Гурман', icon: '👑', description: 'Поставить оценку 90' },
  '🤝 Дружелюбный': { id: 'friendly', title: '🤝 Дружелюбный', icon: '🤝', description: 'Получить 5 лайков на комментариях' },
  '🎪 Меценат': { id: 'patron', title: '🎪 Меценат', icon: '🎪', description: 'Добавить фильм в каталог' },
  '🎬 Первый кадр': { id: 'first_frame', title: '🎬 Первый кадр', icon: '🎬', description: 'Быть среди первых 100 пользователей' },
  'dogville': { id: 'dogville', title: '🐕 Окно Овертона', icon: '🐕', description: 'Оценка фильма «Догвилль» в срок' }
};

mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('✅ Подключено к MongoDB');
    const db = mongoose.connection.db;
    const usersCollection = db.collection('users');
    
    const users = await usersCollection.find({}).toArray();
    let updated = 0;
    
    for (const user of users) {
      const achievements = user.achievements;
      
      // Если уже в правильном формате — пропускаем
      if (achievements && achievements.all && Array.isArray(achievements.all)) {
        if (achievements.all.length > 0 && typeof achievements.all[0] === 'object') {
          console.log(`✅ ${user.nickname} уже в правильном формате`);
          continue;
        }
      }
      
      console.log(`🔄 Обновляем ${user.nickname}...`);
      
      // Собираем все достижения из разных форматов
      let allAchievements = [];
      
      if (Array.isArray(achievements)) {
        // Старый формат: массив строк
        allAchievements = achievements;
      } else if (achievements && achievements.all && Array.isArray(achievements.all)) {
        // Новый формат, но внутри строки
        allAchievements = achievements.all;
      } else if (achievements && typeof achievements === 'object') {
        // Объект с ключами
        allAchievements = Object.values(achievements);
      }
      
      // Преобразуем строки в объекты
      const converted = allAchievements.map(item => {
        if (typeof item === 'string') {
          const meta = ACHIEVEMENTS_META[item] || ACHIEVEMENTS_META[item.toLowerCase()];
          if (meta) {
            return { ...meta, earnedAt: new Date() };
          }
          // Если не нашли — создаём заглушку
          return { id: item, title: item, icon: '🏅', description: '', earnedAt: new Date() };
        }
        return item;
      });
      
      // Сохраняем
      await usersCollection.updateOne(
        { _id: user._id },
        {
          $set: {
            "achievements": {
              all: converted,
              active: null
            }
          }
        }
      );
      
      updated++;
      console.log(`  ✅ Обновлён: ${converted.length} достижений`);
    }
    
    console.log(`🎉 Миграция завершена! Обновлено ${updated} пользователей.`);
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Ошибка:', err);
    process.exit(1);
  });
