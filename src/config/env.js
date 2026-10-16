require('dotenv').config();

const requiredEnv = ['MONGODB_URI', 'JWT_SECRET', 'TMDB_API_KEY', 'ADMIN_SECRET_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`❌ Отсутствуют обязательные переменные окружения: ${missingEnv.join(', ')}`);
  console.error('   Добавьте их в настройках Render (Environment Variables)');
  process.exit(1);
}

console.log('✅ Все переменные окружения заданы');
console.log('🔍 CLIENT_URL =', process.env.CLIENT_URL || '❌ НЕ УСТАНОВЛЕНА');
console.log(
  '🔍 TMDB_API_KEY =',
  process.env.TMDB_API_KEY
    ? `✅ Есть (первые 10 символов: ${process.env.TMDB_API_KEY.slice(0, 10)}...)`
    : '❌ НЕТ'
);

const EXCLUSIVE_NICKNAME = 'Дмитрий';
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

module.exports = { EXCLUSIVE_NICKNAME, PORT, MONGODB_URI };
