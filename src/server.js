// Инициализация env ДО всего остального
const { PORT, MONGODB_URI } = require('./config/env');
const mongoose = require('mongoose');
const app = require('./app');

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('✅ Подключено к MongoDB');
    app.listen(PORT, () => {
      console.log(`✅ Сервер запущен на порту ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Ошибка подключения к MongoDB:', err);
    process.exit(1);
  });
