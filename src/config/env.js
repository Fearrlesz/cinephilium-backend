require('dotenv').config();

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const requiredEnv = ['MONGODB_URI', 'TMDB_API_KEY', 'ADMIN_SECRET_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (!JWT_ACCESS_SECRET) missingEnv.push('JWT_ACCESS_SECRET');
if (!JWT_REFRESH_SECRET) missingEnv.push('JWT_REFRESH_SECRET');

if (missingEnv.length > 0) {
  console.error(`❌ Отсутствуют обязательные переменные окружения: ${missingEnv.join(', ')}`);
  console.error('   Добавьте их в настройках Render (Environment Variables)');
  process.exit(1);
}

if (JWT_ACCESS_SECRET === JWT_REFRESH_SECRET) {
  console.error('❌ JWT_ACCESS_SECRET и JWT_REFRESH_SECRET должны различаться');
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
const JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const JWT_REFRESH_TTL_DAYS = Number(process.env.JWT_REFRESH_TTL_DAYS || 30);
// По умолчанию домен НЕ задаём: host-only cookie корректно работает и на
// localhost, и на onrender.com. Захардкоженный 'localhost' в проде ломает
// refresh-cookie на реальном домене.
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined
  ? process.env.NODE_ENV === 'production'
  : process.env.COOKIE_SECURE === 'true';
const CORS_ORIGIN = process.env.CORS_ORIGIN || process.env.CLIENT_URL || 'http://localhost:3000';
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM;
const EMAIL_CODE_TTL_MIN = Number(process.env.EMAIL_CODE_TTL_MIN || 10);
const EMAIL_RESEND_COOLDOWN_SEC = Number(process.env.EMAIL_RESEND_COOLDOWN_SEC || 60);
const EMAIL_RESEND_MAX_PER_HOUR = Number(process.env.EMAIL_RESEND_MAX_PER_HOUR || 3);
const IMAGE_PROXY_BASE_URL = process.env.IMAGE_PROXY_BASE_URL || '';

module.exports = {
  EXCLUSIVE_NICKNAME,
  PORT,
  MONGODB_URI,
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  JWT_ACCESS_TTL,
  JWT_REFRESH_TTL_DAYS,
  COOKIE_DOMAIN,
  COOKIE_SECURE,
  CORS_ORIGIN,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  EMAIL_CODE_TTL_MIN,
  EMAIL_RESEND_COOLDOWN_SEC,
  EMAIL_RESEND_MAX_PER_HOUR,
  IMAGE_PROXY_BASE_URL
};
