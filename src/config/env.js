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

// ===== РЕГИСТРАЦИЯ БЕЗ ПОЧТЫ =====
// invite — аккаунт создаётся только по одноразовому коду от администратора;
// open   — свободная регистрация (коды не нужны, но и защита слабее).
const REGISTRATION_MODE = process.env.REGISTRATION_MODE === 'open' ? 'open' : 'invite';
// Сколько дней живёт выданный инвайт. 0 или пусто — бессрочно.
const INVITE_TTL_DAYS = Number(process.env.INVITE_TTL_DAYS || 0);
// Срок жизни одноразовой ссылки сброса пароля, которую выдаёт админ.
const PASSWORD_RESET_TTL_MIN = Number(process.env.PASSWORD_RESET_TTL_MIN || 30);
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
  REGISTRATION_MODE,
  INVITE_TTL_DAYS,
  PASSWORD_RESET_TTL_MIN,
  IMAGE_PROXY_BASE_URL
};
