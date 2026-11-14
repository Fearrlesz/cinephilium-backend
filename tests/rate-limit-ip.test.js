// C-2: per-IP лимитеры не должны обходиться подделкой заголовков.
//
// Раньше `clientIp()` слепо доверял `cf-connecting-ip` и `x-real-ip`. Любой, кто
// достучался до origin, присылал произвольный адрес в заголовке и получал свежее
// ведро лимита: брутфорс паролей (authLimiter 10/15 мин), регистрации (10/час),
// накрутка оценок (40/час), лайки, заявки и общий лимит.
//
// Теперь заголовок принимается только от проверенного прокси — адрес соединения
// (`req.ip`) должен попадать в сети Cloudflare (`cf-connecting-ip`) или в
// `TRUSTED_PROXY_CIDRS` (свой nginx, `x-real-ip`).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const {
  clientIp,
  createClientIp,
  CLOUDFLARE_PROXY_CIDRS
} = require('../src/middleware/security');

const key = ip => ipKeyGenerator(ip);
const fakeReq = (ip, headers = {}) => ({ ip, headers });

test('clientIp: поддельный cf-connecting-ip от чужого адреса игнорируется', () => {
  const req = fakeReq('198.51.100.7', { 'cf-connecting-ip': '203.0.113.1' });
  assert.equal(clientIp(req), key('198.51.100.7'));
});

test('clientIp: поддельные cf-connecting-ip и x-real-ip игнорируются оба', () => {
  const req = fakeReq('198.51.100.8', {
    'cf-connecting-ip': '203.0.113.2',
    'x-real-ip': '203.0.113.3'
  });
  assert.equal(clientIp(req), key('198.51.100.8'));
});

test('clientIp: запрос через Cloudflare — ключ из cf-connecting-ip', () => {
  const req = fakeReq('173.245.48.10', { 'cf-connecting-ip': '203.0.113.9' });
  assert.equal(clientIp(req), key('203.0.113.9'));
});

test('clientIp: от Cloudflare уважаем cf-connecting-ip, а не x-real-ip', () => {
  const req = fakeReq('173.245.48.10', {
    'cf-connecting-ip': '203.0.113.9',
    'x-real-ip': '203.0.113.77'
  });
  assert.equal(clientIp(req), key('203.0.113.9'));
});

test('clientIp: мусор в cf-connecting-ip не ломает ключ — падаем на адрес соединения', () => {
  const req = fakeReq('173.245.48.10', { 'cf-connecting-ip': 'not-an-ip' });
  assert.equal(clientIp(req), key('173.245.48.10'));
});

test('clientIp: ::ffff:-адрес соединения приводится к IPv4', () => {
  const req = fakeReq('::ffff:198.51.100.9');
  assert.equal(clientIp(req), key('198.51.100.9'));
});

test('clientIp: IPv6-запрос через Cloudflare', () => {
  const req = fakeReq('2606:4700::1', { 'cf-connecting-ip': '2001:db8::1' });
  assert.equal(clientIp(req), key('2001:db8::1'));
});

test('clientIp: отсутствие адреса — ключ unknown', () => {
  assert.equal(clientIp(fakeReq('')), 'unknown');
});

test('createClientIp: x-real-ip принимается только из TRUSTED_PROXY_CIDRS', () => {
  const own = createClientIp({ trustedProxyCidrs: ['10.0.0.0/8'] });

  assert.equal(
    own(fakeReq('10.1.2.3', { 'x-real-ip': '203.0.113.20' })),
    key('203.0.113.20'),
    'своего прокси слушаем'
  );
  assert.equal(
    own(fakeReq('198.51.100.10', { 'x-real-ip': '203.0.113.21' })),
    key('198.51.100.10'),
    'чужой адрес с тем же заголовком — не прокси'
  );
  assert.equal(
    own(fakeReq('173.245.48.10', { 'x-real-ip': '203.0.113.22' })),
    key('173.245.48.10'),
    'Cloudflare не является своим прокси: x-real-ip от него не доверяем'
  );
});

test('clientIp: по умолчанию TRUSTED_PROXY_CIDRS пуст — x-real-ip не доверяем никому', () => {
  const req = fakeReq('10.1.2.3', { 'x-real-ip': '203.0.113.30' });
  assert.equal(clientIp(req), key('10.1.2.3'));
});

test('CLOUDFLARE_PROXY_CIDRS: список непустой и покрывает ожидаемые сети', () => {
  assert.ok(CLOUDFLARE_PROXY_CIDRS.length >= 15);
  const probe = createClientIp({ trustedProxyCidrs: [] });
  assert.equal(
    probe(fakeReq('104.16.5.5', { 'cf-connecting-ip': '203.0.113.40' })),
    key('203.0.113.40')
  );
});

test('createClientIp: мусор в TRUSTED_PROXY_CIDRS не ломает приложение', () => {
  const own = createClientIp({
    trustedProxyCidrs: ['не-сеть', '10.0.0.0/99', '10.0.0.0/8']
  });
  assert.equal(
    own(fakeReq('10.1.2.3', { 'x-real-ip': '203.0.113.23' })),
    key('203.0.113.23'),
    'валидная сеть из списка продолжает работать'
  );
});

/* ── Интеграция: настоящий express-rate-limit за trust proxy ────────────── */

async function withLimitedApp(limiterOptions, run) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED' }),
      ...limiterOptions
    })
  );
  app.get('/ping', (_req, res) => res.json({ ok: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const hit = (base, headers) => fetch(`${base}/ping`, { headers });

test('лимит: ротация cf-connecting-ip с одного адреса не даёт новых вёдер', async () => {
  await withLimitedApp({ limit: 3, keyGenerator: clientIp }, async base => {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await hit(base, {
        'x-forwarded-for': '198.51.100.20',
        'cf-connecting-ip': `203.0.113.${i + 1}`
      });
      statuses.push(response.status);
    }

    assert.deepEqual(statuses, [200, 200, 200, 429], 'подделка заголовка обходит лимит');

    const fresh = await hit(base, {
      'x-forwarded-for': '198.51.100.21',
      'cf-connecting-ip': '203.0.113.99'
    });
    assert.equal(fresh.status, 200, 'другой реальный адрес — своё ведро');
  });
});

test('лимит: за Cloudflare каждый посетитель считается по cf-connecting-ip', async () => {
  await withLimitedApp({ limit: 2, keyGenerator: clientIp }, async base => {
    const cfEdge = '173.245.48.10';
    const first = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await hit(base, {
        'x-forwarded-for': cfEdge,
        'cf-connecting-ip': '203.0.113.50'
      });
      first.push(response.status);
    }
    assert.deepEqual(first, [200, 200, 429]);

    const neighbour = await hit(base, {
      'x-forwarded-for': cfEdge,
      'cf-connecting-ip': '203.0.113.51'
    });
    assert.equal(neighbour.status, 200, 'сосед за тем же edge не страдает от чужого лимита');
  });
});

test('лимит: подделка x-forwarded-for не меняет ключ (trust proxy: 1)', async () => {
  await withLimitedApp({ limit: 2, keyGenerator: clientIp }, async base => {
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await hit(base, {
        'x-forwarded-for': `203.0.113.${100 + i}, 198.51.100.30`
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 429], 'правую запись XFF дописал edge');
  });
});
