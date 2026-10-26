# Cinephilium Backend

API кино-каталога: фильмы из TMDB, оценки по 15 критериям в 5 блоках, рецензии,
комментарии, модерация и геймификация (баллы, достижения, рейтинг пользователей).

Версия 3.5. Подробный список изменений этой итерации — в [CHANGELOG.md](./CHANGELOG.md).

---

## 1. Стек и требования

| | |
|---|---|
| Runtime | Node.js >= 20.19 |
| HTTP | Express 5 |
| БД | MongoDB + Mongoose 9 |
| Авторизация | JWT (access 15 мин + refresh 30 дней в HttpOnly cookie), bcrypt |
| Регистрация | никнейм + пароль по инвайт-коду, без почты и SMTP |
| Валидация | express-validator + ручные проверки в роутах |
| Безопасность | helmet, express-rate-limit, NoSQL-санитайзер, CORS по списку |

Локально нужен запущенный MongoDB (`mongodb://127.0.0.1:27017`).

---

## 2. Быстрый старт

```bash
cp .env.example .env      # заполнить секреты
npm ci
npm test                  # нужен MongoDB на 127.0.0.1:27017
npm start                 # http://localhost:3000/api/health
```

`npm start` запускает `src/server.js`: он читает env, подключается к Mongo и только после
успешного подключения поднимает HTTP-сервер (при ошибке — `exit 1`).

---

## 3. Переменные окружения

Полный список — в [.env.example](./.env.example).

### Обязательные

| Переменная | Зачем |
|---|---|
| `MONGODB_URI` | строка подключения |
| `JWT_ACCESS_SECRET` | подпись access-токенов |
| `JWT_REFRESH_SECRET` | подпись refresh-токенов (обязан отличаться от access) |
| `TMDB_API_KEY` | импорт фильмов и поиск |
| `ADMIN_SECRET_KEY` | активация админа через `/api/admin/make` |

`src/config/env.js` падает на старте, если чего-то нет, и отдельно проверяет,
что access- и refresh-секреты не совпадают.

### Важные необязательные

| Переменная | По умолчанию | Комментарий |
|---|---|---|
| `PORT` | 3000 | |
| `CORS_ORIGIN` | `CLIENT_URL` или `http://localhost:3000` | список origin через запятую |
| `CLIENT_URL` | — | база для ссылки сброса пароля, должна указывать на фронт |
| `JWT_ACCESS_TTL` | `15m` | |
| `JWT_REFRESH_TTL_DAYS` | `30` | |
| `COOKIE_DOMAIN` | не задан | host-only cookie; задавать только при необходимости |
| `COOKIE_SECURE` | `NODE_ENV === 'production'` | в проде обязательно `true` (HTTPS) |
| `IMAGE_PROXY_BASE_URL` | — | адрес **бэкенда** для ссылок на `/api/tmdb-image`; пусто — берётся origin входящего запроса. Домен фронтенда сюда попасть не должен (если попал и фронт на другом домене — сервер сам подставит origin запроса) |
| `REGISTRATION_MODE` | `invite` | `invite` — только по коду от админа, `open` — свободная регистрация |
| `INVITE_TTL_DAYS` | `0` | срок жизни выданного инвайта в днях; 0 — бессрочно |
| `PASSWORD_RESET_TTL_MIN` | `30` | сколько живёт ссылка сброса пароля от админа |
| `ADMIN_TELEGRAMS` | — | телеграмы для страницы связи, через запятую (`fearrlez,asduna_piu`) |

---

## 4. Архитектура

```
src/server.js          точка входа: env → Mongo → listen
src/app.js             сборка Express: cors → helmet → постеры → limiter → json → cookie → sanitizer → роуты → 404 → ошибки
src/config/            env.js (конфиг), cors.js, scoring.js (формулы)
src/middleware/        auth.js, security.js, errorHandler.js, validate.js
src/models/            User, Invite, Film, Rating, Review, Comment, Event, Action, Session
src/routes/            по одному файлу на домен
src/utils/             jwt, cookies, tokens, counters, poster, errors, achievements, validate, asyncHandler
api/tmdb-image.js      прокси постеров (Vercel + Express)
scripts/               миграции и обслуживание данных
tests/                 node:test, у каждого файла своя БД
```

### Порядок middleware (важен)

1. `cors` — до всего, чтобы ошибки тоже получали CORS-заголовки;
2. `helmet` — заголовки безопасности;
3. прокси постеров `/api/tmdb-image` и `/api/poster/:size/*` — **до** общего лимита,
   со своим `imageLimiter` (1200/мин): на страницу уходит 20–40 картинок, и общий лимит
   они выжигают за пару экранов;
4. `globalLimiter` — 200 запросов/мин на IP;
5. `express.json({ limit: '100kb' })`;
6. `cookieParser()` — нужен для refresh;
7. `noSqlSanitizer` — **после** парсинга: рекурсивно вырезает ключи, начинающиеся с `$`,
   и ключи с точкой (защита от `$ne`, `$where`, `a.b`-инъекций);
8. роуты;
9. `notFoundHandler` → JSON 404;
10. `errorHandler` → единый формат ошибок.

`app.set('trust proxy', 1)` — приложение живёт за одним прокси (Render), а `req.ip` на
Render/Cloudflare оказывается адресом edge-ноды Cloudflare, общим на тысячи людей.
Поэтому все лимиты считают по `clientIp()`: сначала `cf-connecting-ip` (Cloudflare),
потом `x-real-ip` (свой nginx), и только если их нет — `req.ip`.
Если бэкенд когда-нибудь окажется открыт в интернет **без** прокси, эти заголовки нужно
вырезать на входе (иначе клиент подделает IP и обойдёт лимиты).

### Поток запроса на примере оценки

1. `POST /api/ratings` → `writeLimiter` (30/мин) → `ratingLimiter` (40/час) →
   `authenticate` (достаёт Bearer, проверяет подпись и `type: 'access'`, грузит пользователя).
2. Роут валидирует `filmId`, все 15 оценок (1..10), `vibe` (1..10), веса блоков (сумма строго 100)
   и длину `textReview` (<= 2000).
3. Считается `technicalScore` и `combinedScore` (см. §5).
4. `Rating.findOneAndUpdate({ userId, filmId }, …, { upsert: true })` — одна оценка на пару
   (защищено уникальным индексом `{ userId, filmId }`). При обновлении баллы не начисляются повторно.
5. Для новой оценки: `incCounter(userId, 'ratings', 1)`, `addPoints(+10, админ +20)`,
   событие `rating` в ленту, пересчёт достижений.

---

## 5. Скоринг

15 критериев в 5 блоках (`src/config/scoring.js`):

| Блок | Критерии |
|---|---|
| `scenario` | plot, ideas, dialogue |
| `characters` | depth, chemistry, functionality |
| `visual` | composition, cinematography, pacing, tone |
| `sound` | music, design, narrative |
| `style` | originality, boldness |

1. Среднее по каждому блоку (1..10).
2. Взвешенная сумма по весам блоков (сумма 100). Веса берутся из жанрового пресета
   (`drama`, `action`, `comedy`, `horror`, `scifi_block`, `scifi_author`, `musical`, `biopic`),
   кастомных весов или дефолта `[30, 25, 20, 15, 10]`.
3. `technicalScore = roundTenth(взвешенное_среднее * 10)` → 10..100.
4. `combinedScore = roundTenth(technicalScore * 0.7 + vibe * 3)` → 10..100.

Средние по фильму считаются в MongoDB (`$lookup` + `$avg`), а не в Node —
поэтому в списке и топе они всегда согласованы с деталями.

---

## 6. Аутентификация

### Токены

| | access | refresh |
|---|---|---|
| срок | `JWT_ACCESS_TTL` (15 мин) | `JWT_REFRESH_TTL_DAYS` (30 дней) |
| где хранится | `localStorage` на фронте | HttpOnly cookie `refresh_token` |
| что внутри | `{ userId, type: 'access' }` | `{ userId, sessionId, type: 'refresh', jti }` |
| проверка | `verifyAccessToken` (HS256 + type) | `verifyRefreshToken` + сверка хеша с сессией |

### Сессии

`Session` хранит `tokenHash` (SHA-256), `userAgent`, `ip`, `expiresAt` (TTL-индекс).
Refresh — это **ротация**: при обновлении старый хеш атомарно заменяется новым.
Повторное использование старой cookie даёт 401 (`SESSION_REVOKED`), потому что
`updateOne` по старому `tokenHash` не находит документ.

### Cookie

`httpOnly`, `secure` в проде, `sameSite: 'none'` при `secure` (иначе браузер не отправит
cookie с vercel.app на onrender.com), `path: '/api/auth'`.
`COOKIE_DOMAIN` по умолчанию не задан — host-only cookie работает и локально, и в проде.

### Регистрация по инвайту

Почта не запрашивается: `register` принимает `nickname`, `password`, `inviteCode` и `consent`,
сразу создаёт аккаунт и выдаёт `accessToken` + refresh-cookie. Код одноразовый: в базе лежит
только его SHA-256, а сам код показывается один раз в ответе на создание. В списке инвайтов
виден только префикс, статус и срок. Код можно отозвать, использованный повторно не срабатывает
(`INVITE_USED`), просроченный — `INVITE_EXPIRED`. Без кода в режиме `invite` — 403
`INVITE_REQUIRED`, мусорный код — 400 `INVITE_INVALID`.

Первый пользователь пустой базы создаётся без кода и сразу становится админом: иначе на свежей
установке некому выдать первый инвайт. `GET /api/auth/config` сообщает фронту, нужен ли код.

### Сброс пароля

Писем нет. Админ генерирует одноразовую ссылку (`POST /api/admin/users/:id/reset-link`),
в БД попадает только SHA-256 токена, TTL — `PASSWORD_RESET_TTL_MIN` (30 минут). Админ передаёт
ссылку вручную; `reset-password` проверяет срок и одноразовость, меняет пароль и **удаляет все
сессии** пользователя. Потерянную ссылку админ просто выдаёт заново.

---

## 7. Модель данных

| Коллекция | Ключевые поля | Индексы |
|---|---|---|
| `users` | nickname*, password (bcrypt), email (необязательный контакт), telegram, avatar, isAdmin, invitedBy, passwordReset, totalPoints, counters, achievements, consent, registeredIp, trustWeight, flagged | `nickname` unique, `email` unique + sparse, `{registeredIp, registeredAt}`, `flagged` |
| `invites` | codeHash*, codePrefix, note, createdBy, usedBy, usedAt, revokedAt, expiresAt | `codeHash` unique |
| `contactrequests` | nickname, contact, message, status (`new`/`approved`/`rejected`), ip, inviteId, reviewedBy, reviewedAt | `{status, createdAt}`, `{ip, createdAt}` |
| `films` | tmdbId*, title, year, posterPath, poster (legacy), description, genres, director, actors, trailer, createdBy | `tmdbId` unique |
| `ratings` | userId, filmId, genrePreset, blockWeights, scores (15 полей), vibe, technicalScore, combinedScore, textReview, likes, weight, ip | `{userId, filmId}` unique, `filmId`, `userId` |
| `reviews` | userId, filmId, ratingId, title, text (450..15000), likes, status | `{filmId, createdAt}`, `{userId, filmId}` unique |
| `comments` | userId, filmId, text (<=1000), likes, parentId, status | `{filmId, createdAt}` |
| `events` | type, user, film, filmId, score, contentId, metadata | `createdAt` |
| `actions` | userId, actorId, type, points, refId | `{userId, actorId, refId, type}` |
| `sessions` | userId, tokenHash*, userAgent, ip, expiresAt (TTL) | `tokenHash` unique, `userId` |

Все пользовательские тексты (рецензии, комментарии) уходят на модерацию (`pending`)
и видны публично только после `approved`.

---

## 8. Анти-накрутка

| Слой | Механика |
|---|---|
| Регистрация | 10 аккаунтов/час с одного IP (считаются и успешные) + одноразовый инвайт-код на аккаунт |
| Оценки | 40/час с одного IP, одна оценка на пару user+film |
| Вес голоса | `Rating.weight` (0..1) копируется из `User.trustWeight` |
| Агрегаты | `$lookup` фильтрует `weight: { $ne: 0 }`, значит помеченные оценки не влияют на средние, топ фильмов и «votesCount» |
| Рейтинг | `/api/top/users` исключает `flagged: true` |
| Детектор | `scripts/flag-sybil-accounts.js`: кластеры `>= 5` аккаунтов за час с одного IP → `trustWeight = 0`, `weight = 0` |

Детектор запускается вручную (cron/руками), есть `--dry-run` и `--unflag`.
Порог консервативный, чтобы не задеть семью или офис с общим IP.

**Ограничение:** распределённая ферма (много IP и много инвайтов) так не ловится.
Следующие шаги при необходимости: CAPTCHA (Turnstile/hCaptcha) на регистрацию, выдача инвайтов
только после активности, правило «голоса аккаунтов младше 24 часов не входят в средние».

---

## 9. API

Все ответы — JSON. Ошибки: `{ "error": { "code", "message", "details?" } }`.

### Авторизация

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| GET | `/api/auth/config` | — | нужен ли инвайт-код для регистрации |
| POST | `/api/auth/register` | — | создать аккаунт по инвайту (нужны `consent`), сразу `accessToken` + cookie |
| POST | `/api/auth/login` | — | вход по никнейму (старые аккаунты — по почте) |
| POST | `/api/auth/refresh` | cookie | ротация refresh, новый `accessToken` |
| POST | `/api/auth/logout` | cookie | завершить текущую сессию |
| POST | `/api/auth/logout-all` | access | завершить все сессии |
| POST | `/api/auth/reset-password` | — | сменить пароль по ссылке от админа |
| GET | `/api/auth/me` | access | текущий пользователь |

### Связь с админами

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| GET | `/api/contact/admins` | — | телеграмы админов (из базы + `ADMIN_TELEGRAMS`) |
| POST | `/api/contact/request` | — (5/час с IP) | заявка «хочу доступ»: ник, контакт, сообщение |

Заявка не отправляет писем: она попадает в очередь админки. Скрытое поле `website` —
ловушка для ботов: если заполнено, сервер отвечает «успехом», но ничего не сохраняет.

### Фильмы

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| GET | `/api/films` | — | `page`, `limit` (<=100), `sort=technical|combined|vibe` |
| GET | `/api/films/top` | — | `sort`, `limit` (<=20), только фильмы с оценками |
| GET | `/api/films/search-by-title` | — | `title`, регистронезависимый поиск |
| GET | `/api/films/:id` | — | детали + средние + `userRating` (если есть токен) |
| GET | `/api/films/:id/ratings` | — | оценки фильма с авторами |
| GET | `/api/films/:id/users` | — | кто оценивал |
| POST | `/api/films/import` | access | импорт из TMDB, +2 балла (+5 админу) |

### Контент

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| POST | `/api/ratings` | access | поставить/обновить оценку |
| GET | `/api/ratings/user` | access | свои оценки |
| GET | `/api/ratings/:id/details` | — | детали оценки |
| POST | `/api/reviews` | access | рецензия (450..15000 символов) |
| GET | `/api/reviews/:filmId` | — | одобренные рецензии (админ видит все) |
| GET | `/api/reviews/details/:id` | — | одобренную — всем, черновик — автору/админу |
| GET | `/api/reviews/user` | access | свои рецензии |
| POST | `/api/reviews/:id/like` | access | лайк, +5 автору |
| POST | `/api/comments` | access | комментарий или ответ |
| GET | `/api/comments/:filmId` | — | комментарии с ответами |
| POST | `/api/comments/:id/like` | access | лайк, +1 автору |

### Пользователи, топ, события, админ

| Метод | Путь | Доступ |
|---|---|---|
| GET | `/api/users/:id` | — (email — только свой) |
| GET | `/api/users/nickname/:nickname` | — |
| GET | `/api/users/:id/achievements` | — |
| GET | `/api/users/me/achievements` | access |
| GET | `/api/top/users` | — (`{ items, pagination }`, без `flagged`) |
| GET | `/api/events` | — (последние 50) |
| POST | `/api/admin/make` | access + `secretKey` |
| GET/POST | `/api/admin/invites` | admin — список (без кодов) и выдача новых |
| DELETE | `/api/admin/invites/:id` | admin — отозвать неиспользованный код |
| GET | `/api/admin/users?query=` | admin — поиск по никнейму |
| POST | `/api/admin/users/:id/admin` | admin — выдать/снять права (`{ "isAdmin": true|false }`) |
| POST | `/api/admin/users/:id/telegram` | admin — телеграм пользователя (виден на странице связи) |
| GET | `/api/admin/contact-requests?status=new` | admin — очередь заявок |
| POST | `/api/admin/contact-requests/:id/approve` | admin — выдать инвайт по заявке (код в ответе) |
| POST | `/api/admin/contact-requests/:id/reject` | admin — отклонить заявку |
| POST | `/api/admin/users/:id/reset-link` | admin — одноразовая ссылка сброса |
| GET | `/api/admin/pending/comments` / `reviews` | admin |
| PUT | `/api/admin/comments/:id/approve` / `reject` | admin |
| PUT | `/api/admin/reviews/:id/approve` / `reject` | admin |
| GET | `/api/tmdb/search` | — |
| GET | `/api/tmdb-image` | — (алиас `/api/poster/:size/*`) |

---

## 10. Тесты

```bash
npm test
```

105 тестов на `node:test`, у каждого файла своя БД (`cinephilium-test-auth-invite` и т.д.),
поэтому параллельный запуск безопасен. Нужен MongoDB на `127.0.0.1:27017`.

| Файл | Тестов |
|---|---|
| `tests/auth-invite.test.js` | 14 |
| `tests/auth-refresh.test.js` | 13 |
| `tests/contact.test.js` | 11 |
| `tests/counters.test.js` | 15 |
| `tests/errorHandler.test.js` | 9 |
| `tests/poster.test.js` | 15 |
| `tests/regression.test.js` | 28 |

`auth-invite.test.js` проверяет регистрацию по коду, отзыв/просрочку/повторное использование,
вход по никнейму, ограничения админских роутов и одноразовую ссылку сброса пароля.
`regression.test.js` включает сквозной сценарий «регистрация по инвайту → оценка → рецензия →
модерация» и проверки согласий и анти-накрутки.

В песочницах, где нельзя спавнить процессы, используйте
`node --test-isolation=none --test tests/<file>.test.js`.

---

## 11. Миграции (пошагово, простыми словами)

Ситуация: в базе уже есть пользователи и оценки, созданные старой версией. У них нет новых полей
(`consent`, `counters`, `weight` и т.д.). Код это переживает, но есть три момента:

1. **Почта больше не нужна, но старые аккаунты не теряются.** Вход принимает никнейм, а если
   человек помнит только почту — она тоже подходит. Подтверждение почты не требуется, отдельная
   миграция пользователей не нужна: старые записи просто входят под своим ником.
2. **Достижения и топ будут по нулям.** Они читают `counters`, которого у старых пользователей нет.
   `migrate-counters.js` пересчитывает счётчики по фактическим документам.
3. **Новым пользователям нужен инвайт.** Если на проде ещё нет ни одного админа — либо выдай код
   из терминала (`scripts/new-invite.js`), либо разреши бутстрап: на пустой базе первый
   зарегистрировавшийся становится админом автоматически.

Порядок действий (на сервере, где есть доступ к базе):

```bash
# 0. Бэкап. Обязательно.
mongodump --uri="$MONGODB_URI" --out=./backup-$(date +%F)

# 1. Переменные окружения из продакшена (или .env)
export MONGODB_URI="mongodb+srv://..."
export JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=... TMDB_API_KEY=... ADMIN_SECRET_KEY=...

# 2. Зависимости и тесты (быстрая проверка, что код рабочий)
npm ci && npm test

# 3. Инвайт для первого нового пользователя (на пустой базе не нужен)
node scripts/new-invite.js 1

# 4. Счётчики: оценки, рецензии, комментарии, лайки
node scripts/migrate-counters.js

# 5. Постеры: poster -> posterPath (чтобы включился прокси)
node scripts/migrate-posters.js

# 6. Новые поля анти-накрутки + индексы
node scripts/backfill-anti-farm.js --dry-run   # посмотреть, сколько записей затронется
node scripts/backfill-anti-farm.js

# 7. Сверка счётчиков с реальными документами
node scripts/reconcile-counters.js
```

Все скрипты идемпотентны: повторный запуск ничего не портит. `--dry-run` есть у 3 и 6.
После миграций перезапустить сервис и проверить `GET /api/health`, вход старым аккаунтом,
и что у фильма появились постеры.

Если что-то пошло не так — восстановление из бэкапа:
`mongorestore --uri="$MONGODB_URI" ./backup-2026-10-25`.

---

## 12. Деплой

**Бэкенд (Render или любой Node-хостинг):**

1. Build: `npm ci`; Start: `npm start`.
2. Env: все обязательные + `NODE_ENV=production`, `COOKIE_SECURE=true`,
   `CORS_ORIGIN=https://<фронт>`, `CLIENT_URL=https://<фронт>`, `COOKIE_DOMAIN` не задавать.
   `IMAGE_PROXY_BASE_URL` можно не задавать вовсе — тогда постеры ссылаются на origin
   входящего запроса, то есть на этот же бэкенд.
3. После первого деплоя прогнать миграции из §11.

**Если постеры показывают заглушку:**

1. `image.tmdb.org` в РФ недоступен — браузер обязан ходить через `/api/tmdb-image`.
   Проверьте, что `film.posterUrl` в ответе API указывает на **домен бэкенда**:
   `curl -s https://<бэкенд>/api/films?limit=1 | grep posterUrl`.
2. Если там домен фронтенда (`*.vercel.app`) — в `IMAGE_PROXY_BASE_URL` записан не тот
   адрес. Удалите переменную или укажите бэкенд: при старте сервер предупредит
   («IMAGE_PROXY_BASE_URL совпадает с доменом фронтенда»), а при запросе с другого
   домена сам подставит origin бэкенда.
3. Проверьте сам прокси: `curl -I "https://<бэкенд>/api/tmdb-image?size=w500&path=%2F<файл>.jpg"`
   должен вернуть `200 image/jpeg`, а не `404/502/HTML`.
4. `429` в ответах прокси — сработал лимит; на постеры он отдельный (1200/мин на IP),
   общий API-лимит в 200/мин их больше не считает.

**Фронтенд (Vercel):**

1. `REACT_APP_API_URL=https://<бэкенд>/api`.
2. Домен фронта должен совпадать с `CORS_ORIGIN` и `CLIENT_URL` на бэкенде, иначе
   CORS заблокирует запросы, а ссылка сброса пароля уйдёт не туда.

**Регистрация:** почта и SMTP не используются. По умолчанию `REGISTRATION_MODE=invite` —
после деплоя войди под админом и выдай коды (`POST /api/admin/invites` или
`node scripts/new-invite.js`), ссылку сброса пароля также выдаёт админ.

---

## 13. Обслуживание

```bash
node scripts/new-invite.js 5                # выдать 5 инвайт-кодов
node scripts/make-admin.js <никнейм>        # выдать права админа (--revoke снять)
node scripts/set-telegram.js <никнейм> @tg  # телеграм для страницы связи
node scripts/migrate-counters.js          # первичный расчёт counters
node scripts/reconcile-counters.js        # сверка counters с документами
node scripts/migrate-posters.js           # poster -> posterPath
node scripts/backfill-anti-farm.js        # поля анти-накрутки + индексы
node scripts/flag-sybil-accounts.js --dry-run   # найти фермы
node scripts/flag-sybil-accounts.js             # пометить (weight=0)
node scripts/flag-sybil-accounts.js --unflag    # снять пометки
node scripts/check-secrets.js                   # проверка индекса git на секреты
```

---

## 14. Ограничения и планы

- Распределённые фермы с перепроданными инвайтами — вне возможностей IP-детектора.
- Нет удаления оценок/рецензий → награды не откатываются.
- `updateAchievements` молча логирует ошибку, если соединение с Mongo не готово.
- Достижения пересчитываются только при действиях, а не по расписанию.
- Нет OpenAPI-схемы; контракт описан здесь и в тестах.

---

## 15. Структура репозитория

```
api/                Vercel-функция прокси постеров
scripts/            миграции и обслуживание
src/                приложение (см. §4)
tests/              node:test
.env.example        шаблон окружения
.githooks/          pre-commit: не пускает секреты в git
CHANGELOG.md        что изменилось в 4.0 и почему
```
