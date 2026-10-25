const cors = require('cors');
const { CORS_ORIGIN } = require('./env');

// CORS_ORIGIN может содержать несколько источников через запятую.
// Важно передавать массив, а не строку: строка в cors() означает
// «всегда отдавать этот Access-Control-Allow-Origin», без сверки с запросом.
const allowedOrigins = String(CORS_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

console.log('✅ Разрешённые CORS-источники:', allowedOrigins);

const corsMiddleware = cors({
  origin: allowedOrigins,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
});

module.exports = corsMiddleware;
