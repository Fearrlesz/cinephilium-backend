const cors = require('cors');
const { CORS_ORIGIN } = require('./env');

console.log('✅ Разрешённый CORS-источник:', CORS_ORIGIN);

const corsMiddleware = cors({
  origin: CORS_ORIGIN,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
});

module.exports = corsMiddleware;
