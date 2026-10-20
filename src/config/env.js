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
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM;
const EMAIL_CODE_TTL_MIN = Number(process.env.EMAIL_CODE_TTL_MIN || 10);
const EMAIL_RESEND_COOLDOWN_SEC = Number(process.env.EMAIL_RESEND_COOLDOWN_SEC || 60);
const EMAIL_RESEND_MAX_PER_HOUR = Number(process.env.EMAIL_RESEND_MAX_PER_HOUR || 3);

module.exports = {
  EXCLUSIVE_NICKNAME,
  PORT,
  MONGODB_URI,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  EMAIL_CODE_TTL_MIN,
  EMAIL_RESEND_COOLDOWN_SEC,
  EMAIL_RESEND_MAX_PER_HOUR
};
