const cors = require('cors');

const allowedOrigins = [
  process.env.CLIENT_URL,
  'https://cinephilium-frontendnew.vercel.app',
  'http://localhost:3000'
].filter(Boolean);

console.log('✅ Разрешённые CORS-источники:', allowedOrigins);

const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn('❌ CORS заблокировал запрос с origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
});

module.exports = corsMiddleware;
