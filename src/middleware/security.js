// middleware/security.js
// Централизованный набор middleware для безопасности Express-приложения. 

const net = require('node:net');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { AppError } = require('../utils/errors');

function rateLimitHandler(message) {
  return (_req, _res, next) => {
    next(new AppError('RATE_LIMIT_EXCEEDED', message, 429));
  };
}

/* ── IP клиента для лимитов (C-2) ─────────────────────────────────────────
 *
 * `trust proxy: 1` значит: единственная запись `x-forwarded-for`, которой можно
 * верить, — последняя, её дописал edge-прокси Render. Всё, что клиент прислал
 * сам, лежит левее и на ключ не влияет. На Render `req.ip` поэтому может
 * оказаться адресом edge-ноды Cloudflare, общим на тысячи людей: лимит
 * 200/мин выжигается чужими запросами. Настоящий адрес Cloudflare пишет в
 * `cf-connecting-ip`, свой reverse-proxy — в `x-real-ip`.
 *
 * Заголовку верим ТОЛЬКО если запрос действительно пришёл от этого прокси —
 * то есть адрес соединения (`req.ip`) лежит в его сетях. Раньше заголовки
 * читались слепо, и любой, кто достучался до origin (onrender.com, health-check,
 * прямой адрес), присылал `cf-connecting-ip: 1.2.3.4` и получал свежее ведро
 * лимита: обходились authLimiter (брутфорс паролей), registerLimiter,
 * ratingLimiter (накрутка), likeLimiter, contactLimiter, globalLimiter и
 * imageLimiter. Подделать адрес соединения клиент не может — его пишет
 * инфраструктура.
 */

// https://www.cloudflare.com/ips/ — диапазоны меняются редко, но при
// добавлении новых сетей Cloudflare список нужно обновить, иначе запросы через
// них снова начнут делить одно ведро по адресу edge-ноды.
const CLOUDFLARE_PROXY_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
];

/* `::ffff:1.2.3.4` — тот же IPv4, но в записи IPv6 (так его отдаёт Node на
   dual-stack сокете). Приводим к обычному виду, иначе проверка сетей промахнётся. */
function normalizeIp(value) {
  if (typeof value !== 'string') return '';
  const ip = value.trim();
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return mapped ? mapped[1] : ip;
}

function toBlockList(cidrs) {
  const list = new net.BlockList();
  const maxPrefix = { 4: 32, 6: 128 };

  for (const raw of cidrs) {
    const [address, prefixRaw] = String(raw).trim().split('/');
    const family = net.isIP(address);
    const prefix = Number(prefixRaw);
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix[family]) {
      console.warn(`[security] пропускаю некорректную сеть прокси: ${raw}`);
      continue;
    }
    try {
      list.addSubnet(address, prefix, family === 6 ? 'ipv6' : 'ipv4');
    } catch (error) {
      console.warn(`[security] не удалось добавить сеть прокси ${raw}: ${error.message}`);
    }
  }

  return list;
}

function isInList(list, ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

function headerIp(req, header) {
  const value = req.headers?.[header];
  const raw = Array.isArray(value) ? value[0] : value;
  const ip = normalizeIp(raw);
  return net.isIP(ip) ? ip : '';
}

/* `TRUSTED_PROXY_CIDRS` — сети СВОИХ прокси (свой nginx), от которых принимаем
   `x-real-ip`. По умолчанию пусто: заголовок не доверяем никому. */
function configuredProxyCidrs() {
  return String(process.env.TRUSTED_PROXY_CIDRS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

const cloudflareProxies = toBlockList(CLOUDFLARE_PROXY_CIDRS);

function createClientIp({ trustedProxyCidrs = configuredProxyCidrs() } = {}) {
  const ownProxies = toBlockList(trustedProxyCidrs);

  return function clientIp(req) {
    const peer = normalizeIp(req.ip || '');

    // Cloudflare перед нами: настоящий адрес — в cf-connecting-ip.
    if (isInList(cloudflareProxies, peer)) {
      const forwarded = headerIp(req, 'cf-connecting-ip');
      if (forwarded) return ipKeyGenerator(forwarded);
    }

    // Свой reverse-proxy перед нами: адрес — в x-real-ip.
    if (isInList(ownProxies, peer)) {
      const forwarded = headerIp(req, 'x-real-ip');
      if (forwarded) return ipKeyGenerator(forwarded);
    }

    // Во всех остальных случаях ключ — адрес соединения: его клиент подделать
    // не может, поэтому лимит не обходится заголовками.
    return peer ? ipKeyGenerator(peer) : 'unknown';
  };
}

const clientIp = createClientIp();

/* 1. Helmet */
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false
});

/* 2. Общий rate limiter */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIp,
  handler: rateLimitHandler('Слишком много запросов, попробуйте позже')
});

/* 2a. Постеры: их на страницу десятки, и каждая картинка — отдельный запрос.
   В РФ image.tmdb.org недоступен, поэтому постеры идут через этот же сервер.
   Общий лимит в 200/мин они выжигают за пару экранов, поэтому у прокси свой,
   заметно более щедрый лимит (и монтируется он до globalLimiter). */
const imageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIp,
  handler: rateLimitHandler('Слишком много запросов картинок, попробуйте позже')
});

/* 3. Жёсткий лимит для авторизации */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIp,
  skipSuccessfulRequests: true,
  handler: rateLimitHandler('Слишком много попыток входа. Попробуйте через 15 минут')
});

/* 4. Лимит для записи */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIp,
  handler: rateLimitHandler('Слишком много действий, замедлитесь')
});

/* 4a. Лимит на регистрации: считает и успешные запросы,
   иначе с одного IP можно наделать сколько угодно аккаунтов. */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIp,
  handler: rateLimitHandler('Слишком много регистраций с этого адреса. Попробуйте позже')
});

/* 4b. Лимит на оценки с одного IP — тормозит накрутку с одной точки. */
const ratingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIp,
  handler: rateLimitHandler('Слишком много оценок с этого адреса. Попробуйте позже')
});

/* 4c. Лимит на заявки «хочу доступ»: 5 в час с одного IP. */
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIp,
  handler: rateLimitHandler('Слишком много заявок с этого адреса. Напиши админу в Telegram')
});

/* 4d. Лимит на добавление в watchlist: 200 в час на аккаунт (DECISION B6/6B).
   Ключ — userId, поэтому лимитер ставится ПОСЛЕ authenticate: инфраструктура
   это позволяет, переделка на IP-ключ не понадобилась. validate: false — стандартные
   проверки библиотеки рассчитаны на IP-ключ и к этому лимитеру неприменимы. */
const watchlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: req => String(req.userId || 'anonymous'),
  validate: false,
  handler: rateLimitHandler('Слишком много добавлений в «Хочу посмотреть». Попробуйте позже')
});

/* 4e. Лимит на сердечки: 200/час с одного IP (DECISION B7/8B), по аналогии
   с ratingLimiter. Toggle — это запись, поэтому лимит нужен такой же, как у оценок. */
const likeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: clientIp,
  handler: rateLimitHandler('Слишком много лайков с этого адреса. Попробуйте позже')
});

/* 5. Ограничение размера JSON-тела */
const bodyLimit = '100kb';

/* 6. Защита от NoSQL-инъекций */
function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const clean = {};
    for (const key of Object.keys(value)) {
      if (key.startsWith('$') || key.includes('.')) continue;
      clean[key] = sanitizeValue(value[key]);
    }
    return clean;
  }
  return value;
}

function noSqlSanitizer(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }

  for (const prop of ['query', 'params']) {
    if (req[prop] && typeof req[prop] === 'object') {
      const cleaned = sanitizeValue(req[prop]);
      try {
        Object.defineProperty(req, prop, {
          value: cleaned,
          writable: true,
          configurable: true,
          enumerable: true
        });
      } catch (err) {
        console.warn(`⚠️ Не удалось перезаписать req.${prop}:`, err.message);
      }
    }
  }

  next();
}

/* 7. Защита от подделки JWT (alg: none) */
function verifyToken(token) {
  const secret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_ACCESS_SECRET не установлен — генерация и проверка токенов невозможны');
  }
  return jwt.verify(token, secret, { algorithms: ['HS256'] });
}

/* 8. Хелпер: извлечение Bearer-токена */
function extractBearer(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

module.exports = {
  helmetMiddleware,
  globalLimiter,
  imageLimiter,
  authLimiter,
  writeLimiter,
  registerLimiter,
  ratingLimiter,
  contactLimiter,
  watchlistLimiter,
  likeLimiter,
  bodyLimit,
  noSqlSanitizer,
  clientIp,
  createClientIp,
  CLOUDFLARE_PROXY_CIDRS,
  verifyToken,
  extractBearer
};
