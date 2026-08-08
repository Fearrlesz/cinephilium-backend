require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

// Подключаемся к базе
mongoose.connect(MONGODB_URI)
  .then(async () => {
    console.log('✅ Подключено к MongoDB');
    
    const db = mongoose.connection.db;
    const usersCollection = db.collection('users');
    
    // Находим всех пользователей, у кого achievements - массив
    const users = await usersCollection.find({
      "achievements.0": { $exists: true }
    }).toArray();
    
    console.log(`📊 Найдено пользователей с массивом достижений: ${users.length}`);
    
    if (users.length === 0) {
      console.log('✅ Все пользователи уже обновлены!');
      process.exit(0);
    }
    
    console.log('📝 Первые 5 пользователей:');
    users.slice(0, 5).forEach(user => {
      console.log(`  - ${user.nickname || user._id}: ${JSON.stringify(user.achievements)}`);
    });
    
    // Обновляем каждого
    for (const user of users) {
      const oldAchievements = user.achievements || [];
      
      await usersCollection.updateOne(
        { _id: user._id },
        {
          $set: {
            "achievements": {
              all: oldAchievements,
              active: null
            }
          }
        }
      );
      
      console.log(`✅ Обновлён пользователь: ${user.nickname || user._id}`);
    }
    
    console.log('🎉 Миграция завершена!');
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Ошибка:', err);
    process.exit(1);
  });
