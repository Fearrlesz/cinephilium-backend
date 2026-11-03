# Cinephilium Backend

API кино-каталога: фильмы из TMDB, оценки по 15 критериям в 5 блоках, рецензии,
комментарии, модерация и геймификация (баллы, достижения, рейтинг пользователей).

Версия 5.9. Подробный список изменений этой итерации — в [CHANGELOG.md](./CHANGELOG.md).

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
| Сжатие | `compression` (gzip) для JSON-ответов |

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
| `JWT_ACCESS_SECRET` | подпись access-токенов (старое имя `JWT_SECRET` тоже принимается) |
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
src/models/            User, Invite, ContactRequest, Film, Rating, Review, Comment, Event, Action, Session
src/routes/            по одному файлу на домен
src/utils/             jwt, cookies, tokens, counters, poster, errors, achievements, validate, helpers, points, telegram, counterMaintenance, privacy, paging, profileTabsQuery, asyncHandler
api/tmdb-image.js      прокси постеров (Vercel + Express)
scripts/               миграции и обслуживание данных
tests/                 node:test, у каждого файла своя БД
```

### Порядок middleware (важен)

1. `cors` — до всего, чтобы ошибки тоже получали CORS-заголовки;
2. `helmet` — заголовки безопасности, сразу за ним `compression` — gzip для JSON
   (картинки `compression` не трогает: `image/*` несжимаем);
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
   кастомных весов или дефолта `[30, 25, 20, 15, 10]`. `hybrid` — не пресет с числами,
   а режим «свои веса»: при нём сервер использует присланный `blockWeights`.
3. `technicalScore = roundTenth(взвешенное_среднее * 10)` → 10..100.
4. `combinedScore = roundTenth(technicalScore * 0.7 + vibe * 3)` → 10..100.

Средние по фильму считаются в MongoDB (`$lookup` + `$avg`), а не в Node —
поэтому в списке и топе они всегда согласованы с деталями.

### Средние по фильму: две оси (B2)

Vibe и полная оценка — разные оси, и агрегаты их не смешивают:

| Поле | По каким оценкам | Если считать не из чего |
|---|---|---|
| `averageVibe` | по всем (vibe + full): вайб есть у обоих типов | `0` на странице, `null` в списке |
| `averageTechnical` | только по `completeness: 'full'` | `0` на странице, `null` в списке |
| `averageCombined` | только по `completeness: 'full'` | `0` на странице, `null` в списке |
| `averageRating` | алиас `averageTechnical` (легаси-поле, DECISION B2/1A) | как у `averageTechnical` |
| `votesCount` | все оценки, `weight != 0` (DECISION B2/4A) | `0` |
| `vibesCount` | только vibe-оценки | `0` |
| `fullCount` | только полные оценки | `0` |

Ноль — маркер «не вычислено» (DECISION 2A), а не «плохо». На странице фильма он
отдаётся честно, чтобы фронт показал «пока никто не разобрал подробно». В списках и
топах отсутствующее число отдаётся `null`: старый фронт рисует его как «—», а `0`
нарисовал бы красное «0.0». Это отличие намеренное (DECISION B2/6.1).

Топы ранжируют только участников оси: по `technical`/`combined` — фильмы хотя бы с
одной полной оценкой, по `vibe` — хотя бы с одной любой. `total` в топе считает
участников, а каталог `/api/films` показывает все фильмы, и его `total` — все фильмы
(DECISION B2/6A). Все три средних округляются до десятых.

Оценки с `weight: 0` не участвуют ни в одном среднем, ни в одном счётчике и ни в одном
топе — фильтр `weight: { $ne: 0 }` стоит в `$lookup`.

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
| `users` | nickname*, password (bcrypt), email (необязательный контакт), telegram, avatar, isAdmin, invitedBy, passwordReset, totalPoints, counters (ratings, vibes, watches, …), privacy (hideProfile, hideFromFeed), diaryPrivate, achievements, pinnedAchievement (строка из achievements, B9), consent, registeredIp, trustWeight, flagged, vibeWindow (служебное) | `nickname` unique, `email` unique + sparse, `{registeredIp, registeredAt}`, `flagged` |
| `invites` | codeHash*, codePrefix, note, createdBy, usedBy, usedAt, revokedAt, expiresAt | `codeHash` unique, `{usedAt, revokedAt, expiresAt}` |
| `contactrequests` | nickname, contact, message, status (`new`/`approved`/`rejected`), ip, inviteId, reviewedBy, reviewedAt | `{status, createdAt}`, `{ip, createdAt}` |
| `films` | tmdbId*, title, year, posterPath, poster (legacy), description, genres, director, actors, trailer, createdBy, likesCount (публичный агрегат, weight > 0) | `tmdbId` unique |
| `ratings` | userId, filmId, completeness (`vibe`/`full`), genrePreset, blockWeights, scores (15 полей), vibe, technicalScore, combinedScore (0 = не вычислено), textReview, likes, weight, ip, vibeCreatedAt | `{userId, filmId}` unique, `filmId`, `userId`, `{userId, vibeCreatedAt}` |
| `reviews` | userId, filmId, ratingId, title, text (350..15000), isSpoiler, likes, status | `{filmId, createdAt}`, `{userId, filmId}` unique |
| `watches` | userId, filmId, watchedAt, isRewatch, tags (1–30 символов, до 10), ratingId, reviewId | `{userId, watchedAt}`, `{filmId}`, `{userId, filmId}` |
| `watchlistitems` | userId, filmId, addedAt | `{userId, filmId}` unique, `{userId, addedAt}`, `{filmId}` |
| `filmlikes` | userId, filmId, weight (снимок trustWeight), addedAt | `{userId, filmId}` unique, `{userId, addedAt}`, `{filmId, weight}` |
| `comments` | userId, filmId (legacy, всегда заполнен), targetType (`film`/`review`), targetId, text (<=1000), likes, parentId, status | `{filmId, createdAt}`, `{targetType, targetId, createdAt}` |
| `events` | type, user, userId (автор, B-PRIVACY), film, filmId, score, contentId, metadata | `createdAt`, `{userId, createdAt}` |
| `privacychangelogs` | userId, field (hideProfile/hideFromFeed), oldValue, newValue, changedAt, ip | TTL 180 дней, `{userId, changedAt}` |
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
| Vibe-оценки | 50 за скользящие 24 часа на пользователя; лимит проверяется атомарно до создания (`429 VIBE_LIMIT_REACHED`). Апгрейд vibe → full капом не ограничен |
| Вес голоса | `Rating.weight` (0..1) копируется из `User.trustWeight` при создании; при апгрейде сохраняется вес существующей записи (включая `0`) |
| Агрегаты | `$lookup` фильтрует `weight: { $ne: 0 }`, значит помеченные оценки не влияют на средние, топ фильмов и «votesCount» |
| Рейтинг | `/api/top/users` исключает `flagged: true` |
| Детектор | `scripts/flag-sybil-accounts.js`: кластеры `>= 5` аккаунтов за час с одного IP → `trustWeight = 0`, `weight = 0` |

Детектор запускается вручную (cron/руками), есть `--dry-run` и `--unflag`.
Порог консервативный, чтобы не задеть семью или офис с общим IP.

Списки `/api/films/:id/ratings` и `/api/films/:id/users` тоже фильтруют `weight: 0`,
поэтому помеченные оценки не видны и в карточке фильма, а не только в средних.

**Гейтинг комментариев (B3):** писать может только тот, кто оценил фильм —
`403 RATING_REQUIRED_FOR_COMMENT` до валидации тела и до модерации. Лайки не гейтятся.
Гейтинг не заменяет премодерацию, а работает до неё.

**Гейтинг рецензий (B4):** строже — нужна полная оценка (15 критериев), иначе
`403 FULL_RATING_REQUIRED_FOR_REVIEW`. `ratingId` ставит сервер, `isSpoiler` — флаг
без влияния на модерацию.

### Достижения

- Вес прогресса: `effective = counters.ratings + counters.vibes / 5` (пять vibe = одна
  полная). Пороги: 20 / 50 / 100 / 200.
- `FIRST_RATING` — только за первую полную оценку; `FIRST_VIBE` — за первую vibe.
- `FIRST_FRAME` — первые 100 зарегистрированных **и** хотя бы одна полная оценка.
- Уже выданные достижения не отбираются: `updateAchievements` только добавляет новые.
- На vibe `updateAchievements` не вызывается; пересчёт происходит на полной оценке.

**Ограничение:** распределённая ферма (много IP и много инвайтов) так не ловится.
Следующие шаги при необходимости: CAPTCHA (Turnstile/hCaptcha) на регистрацию, выдача инвайтов
только после активности, правило «голоса аккаунтов младше 24 часов не входят в средние».

---

## 9. API

Все ответы API — JSON, кроме прокси постеров: он отдаёт бинарь. Ошибки:
`{ "error": { "code", "message", "details?" } }`; исключение — прокси, у него
`{ "error": "строка" }`.

### Служебное

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| GET | `/api/health` | — | `{ status: 'ok', timestamp }` |
| GET | `/` | — | ответ для health-check Render: `{ service, status, health }` |

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
| GET | `/api/films` | — | `page`, `limit` (<=100), `sort=technical\|combined\|vibe\|new`; все фильмы + средние и три счётчика |
| GET | `/api/films/top` | — | `sort`, `limit` (<=20); только участники оси, плюс `total` и `fallback` |
| GET | `/api/films/search-by-title` | — | `title`, регистронезависимый поиск |
| GET | `/api/films/:id` | — | детали + средние + `watchesCount` + `userRating` (если есть токен) |
| GET | `/api/films/:id/ratings` | — | оценки фильма с авторами |
| GET | `/api/films/:id/users` | — | кто оценивал |
| POST | `/api/films/import` | access | импорт из TMDB, +2 балла (+5 админу) |

`GET /api/films/top` отвечает `{ films, sort, limit, total, fallback }`. `total` — сколько
фильмов участвует в этом топе, а не сколько их в базе. `fallback` — подсказка для пустого
топа: `{ sort: 'vibe', available }`, где `available` истинно, только если vibe-топ есть
чем заполнить. Молчаливой подмены сортировки нет: фронт предлагает перейти по клику.
`sort=new` сортирует по дате добавления и нужен, чтобы только что импортированный фильм
было где увидеть (DECISION B2/2B).

### Контент

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| POST | `/api/ratings` | access | vibe-оценка `{filmId, vibe}` **или** полная `{filmId, vibe, scores, …}`; ответ содержит `completeness` |
| GET | `/api/ratings/user` | access | свои оценки (с `completeness`) |
| GET | `/api/ratings/:id/details` | — | детали оценки (с `completeness`) |
| POST | `/api/reviews` | access + полная оценка | рецензия (350..15000 символов), `isSpoiler`; `ratingId` ставит сервер из своей оценки, без `completeness: 'full'` — `403 FULL_RATING_REQUIRED_FOR_REVIEW` |
| GET | `/api/reviews/:filmId` | — | одобренные рецензии; свой черновик видит автор, всё — админ |
| GET | `/api/reviews/details/:id` | — | одобренную — всем, черновик — автору/админу |
| GET | `/api/reviews/user` | access | свои рецензии |
| POST | `/api/reviews/:id/like` | access | лайк, +5 автору |
| POST | `/api/comments` | access | `{ targetType, targetId, text, parentId? }`; без `targetType` считается `film`; для `film` нужна оценка фильма — `403 RATING_REQUIRED_FOR_COMMENT` |
| GET | `/api/comments?targetType=film\|review&targetId=…` | — | `{ items, pagination }`, корни + ответы; без `targetType` → 400 |
| GET | `/api/comments/:filmId` | — | старый формат (массив), **только** комментарии к фильму |
| POST | `/api/comments/:id/like` | access | лайк, +1 автору (не гейтится) |

Ошибки `POST /api/ratings` для двухступенчатой оценки:

| Код | HTTP | Когда |
|---|---|---|
| `ALREADY_FULL_RATING` | 400 | пришла vibe-оценка, а у пары user+film уже стоит полная |
| `VIBE_LIMIT_REACHED` | 429 | больше 50 новых vibe за 24 часа; `details: { limit, window: '24h', retryAt }` |

### Гейтинг комментариев (B3)

Комментировать может только тот, кто оценил фильм — любой оценкой, vibe или full.
Одна цифра 1–10 уже означает «смотрел, есть мнение». Правило одинаково для корневого
комментария и для ответа: иначе обход «не могу начать тред, зато могу ответить в чужом».
Лайки не гейтятся — это реакция, а не высказывание.

| Код | HTTP | Когда |
|---|---|---|
| `RATING_REQUIRED_FOR_COMMENT` | 403 | у пары user+film нет `Rating` — сначала нужно оценить фильм |

Проверка стоит до валидации тела, поэтому без оценки ответ 403, а не 400 «текст длинный»;
кривой `filmId` остаётся 400. Оценка с `weight: 0` тоже считается входом: гейтинг про
«смотрел ли», а анти-накрутка — про агрегаты; спам в этом случае ловит модерация. Админ
не исключение. Фронт определяет доступность формы по `userRating` в `GET /api/films/:id`,
а 403 — честный fallback при рассинхроне. Оценку и комментарий нужно отправлять
последовательно: сначала `POST /api/ratings`, потом `POST /api/comments`.

### Гейтинг рецензий (B4)

Рецензия — ступень выше комментария: vibe даёт право комментировать, полная оценка —
право писать рецензию. Гейт стоит до валидации тела и до модерации, как в B3.

| Код | HTTP | Когда |
|---|---|---|
| `FULL_RATING_REQUIRED_FOR_REVIEW` | 403 | у пары user+film нет оценки с `completeness: 'full'` |

`ratingId` в теле больше не принимается: сервер берёт `_id` своей оценки, поэтому старый
фронт, который его присылает, продолжает работать — значение игнорируется (DECISION B4/1A).
`isSpoiler` — булево, `default: false`, отдаётся везде, где отдаётся рецензия. Фильтра
`?spoiler` на бэке нет: список отдаётся целиком, скрытие — дело фронта (DECISION B4/4).
В админ-очереди спойлер показывается полным текстом — модератор должен прочитать его
целиком (DECISION B4/5). Минимум текста остаётся 350 символов.

### Комментарии к рецензиям (B8)

Два независимых слоя обсуждения: под фильмом и под рецензией. `Comment` полиморфен —
`targetType: 'film' | 'review'` + `targetId`; `filmId` остаётся legacy-полем (у комментария
к рецензии он заполняется из рецензии, поэтому «все комментарии фильма» возможны).

| Правило | Как работает |
|---|---|
| Гейтинг B3 | только для `targetType: 'film'`; комментарий к рецензии оценки не требует |
| Премодерация | `pending` → `approved`/`rejected` для обоих типов |
| Черновик рецензии | комментировать нельзя: посторонним `404`, автору и админу `403 REVIEW_NOT_PUBLISHED`; `rejected` — так же |
| `filmId` в теле | для `targetType: 'review'` игнорируется: источник истины — `review.filmId` |
| Старый роут | `GET /api/comments/:filmId` — только комментарии к фильму, формат не менялся |
| Ответы | тот же `targetType`/`targetId`, родитель `approved`, один уровень вложенности |
| Лента | событие создаётся только для комментариев к фильму |
| Счётчик под рецензией | не денормализуется: `countDocuments` по индексу |

POST без `targetType` считается комментарием к фильму (`targetId` из `targetId` или
`filmId`) — так задеплоенный фронт продолжает работать до деплоя F-серии.

### Дневник просмотров (B5)

«Просмотрено» ≠ «оценено». Дневник — история просмотров, а не состояние: записей на один
фильм может быть много (пересмотры), поэтому это отдельная коллекция `watch`, а не поле
в `Rating`. Дневник не гейтится ничем: это самое дешёвое действие в системе.

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| POST | `/api/watches` | access | `{ filmId, watchedAt?, isRewatch?, tags? }` → `201` |
| GET | `/api/watches/me` | access | свой дневник: `page`, `limit` (<=100) |
| GET | `/api/watches/user/:userId` | — | публичный дневник; закрытый → `403 DIARY_PRIVATE`, скрытый профиль → `404 PROFILE_HIDDEN` |
| GET | `/api/users/:id/watches` | — | то же, что `/api/watches/user/:id` (алиас для профиля) |
| GET | `/api/watches/:filmId/count` | — | `{ filmId, count }` — «N просмотров», скрытых не фильтрует |
| PATCH | `/api/watches/settings` | access | `{ private: true\|false }` |
| DELETE | `/api/watches/:id` | access | удалить свою запись; чужая → 404 |

Правила:

- `watchedAt` может быть в прошлом (задним числом), но не в будущем: «отметил, что посмотрю
  завтра» — это watchlist, а не дневник. По умолчанию — сейчас.
- `isRewatch` ставит пользователь, автоопределения нет (DECISION B5/4).
- Теги не проходят премодерацию: 1–30 символов, до 10 уникальных, `trim`, дедуп без учёта
  регистра (DECISION B5/1).
- Дневник публичный по умолчанию, владелец может его закрыть (DECISION B5/3); закрытый
  виден только владельцу и админу. `watchesCount` на фильме при этом продолжает считать
  все записи — это агрегат без имён (DECISION B5/3b).
- `counters.watches` меняется при создании и удалении. Событие в ленту не создаётся
  (DECISION B5/5). Создание оценки запись дневника **не** создаёт (DECISION B5/8);
  связать можно только явным `watchId` при создании оценки или рецензии (DECISION B5/2).
- `GET /api/films/:id` отдаёт `watchesCount` — считает все записи, включая пользователей
  с `weight: 0` (DECISION B5/6).

### Watchlist — «хочу посмотреть» (B6)

Третья ось рядом с дневником и оценкой. Состояние, а не история: **одна** запись на пару
user+film (уникальный индекс), в отличие от дневника с пересмотрами. Самое дешёвое
действие: не гейтится ни оценкой, ни модерацией, ни приватностью.

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| POST | `/api/watchlist` | access | `{ filmId }` → `201`; повторное добавление → `200`; ответ `{ inWatchlist: true }` |
| DELETE | `/api/watchlist/:id` | access | своё; уже удалённое/несуществующее → `200 { inWatchlist: false }`; чужое → 404 |
| GET | `/api/watchlist/check/:filmId` | access | `{ inWatchlist: bool }` для кнопки на странице фильма |
| GET | `/api/watchlist/user` | access | свой список, `page`, `limit` (<=100) |
| GET | `/api/users/:id/watchlist` | — | публичный список; скрытый профиль без прав → `404 PROFILE_HIDDEN` |

Правила:

- Двойной клик не наказывается: `POST` идемпотентен, гонка двух запросов разрешается
  уникальным индексом (второй получает `200`, а не `409`).
- Удаление идемпотентно: ответ всегда `{ inWatchlist: false }`, без `{ deleted }` и без
  `404` на «уже удалено» (DECISION B6/1A).
- Watchlist **не влияет на достижения** и **не создаёт событие** в ленте: это намерение,
  а не действие (B6/2A, B6/event).
- Создание записи в дневнике (`POST /api/watches`) **не удаляет** фильм из watchlist;
  автоудаления нет — предложение убрать делает фронт (B6/3B).
- Лимит: 200 добавлений в час **на аккаунт** (не на IP).
- `counters.watchlist` меняется при добавлении и удалении; в заглушке скрытого профиля
  счётчиков нет вообще.

### Сердечко фильма (B7)

Четвёртая ось: «мне нравится» — эмоция, а не суждение, независимая от оценки.
Одна запись на пару user+film.

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| POST | `/api/films/:id/like` | access | поставить (идемпотентно) → `{ liked: true, likesCount }` |
| DELETE | `/api/films/:id/like` | access | снять (идемпотентно) → `{ liked: false, likesCount }` |
| GET | `/api/users/:id/likes` | — | публичные «Понравившиеся»; скрытый профиль без прав → `404 PROFILE_HIDDEN` |
| GET | `/api/users/me/likes` | access | свои «Понравившиеся», без гейтинга |

`GET /api/films/:id` отдаёт `liked` (анониму — `false`) и `likesCount`.

**Два разных числа, не путать:**

| Поле | Что считает | Вес |
|---|---|---|
| `Film.likesCount` | сердечки у фильма (публичный агрегат) | только `weight > 0` |
| `User.counters.filmLikes` | сколько лайков поставил человек | все, включая `weight: 0` |

`POST` и `DELETE` — не toggle: повторный `POST` оставляет лайк, повторный `DELETE`
убирает. Так два одновременных запроса дают одно состояние и один счётчик
(DECISION B7/1A). Лимит — 200 запросов в час на IP. Событие в ленту не создаётся,
достижения не меняются, `Film.likesCount` скрытого пользователя учитывается.

### Приватность профиля и ленты (B-PRIVACY)

Два независимых флага: `hideProfile` — скрыть страницу профиля, `hideFromFeed` — не
показывать события автора в общей ленте. Скрываются только личные разделы: дневник,
оценки, достижения. Рецензии и комментарии остаются видимыми там, где опубликованы,
и оценки скрытого продолжают участвовать в средних фильмов.

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| GET | `/api/users/me/privacy` | access | `{ hideProfile, hideFromFeed }` |
| PUT | `/api/users/me/privacy` | access | partial update, лог только при фактическом изменении |

Правила:

- Скрытый профиль видят владелец, админ и в будущем «друзья» (`canViewProfile`).
  Посторонний получает заглушку `200 { user: { id, nickname, avatar, isHidden: true } }`;
  у `GET /api/users/nickname/:nickname` — та же заглушка без обёртки `user`.
- `GET /api/users/:id/achievements` и `GET /api/users/:id/watches` при скрытом профиле
  отдают `404 PROFILE_HIDDEN`: достижения и дневник — личные разделы, а не «страница».
  Вкладки `ratings`/`reviews`/`comments` ведут себя так же (B9).
- `GET /api/events` исключает события авторов с `hideFromFeed`; фильтрация на чтении —
  снял флаг, события вернулись.
- `GET /api/top/users` исключает скрытые профили.
- `POST /api/watches`, `DELETE /api/watches/:id`, `GET /api/watches/me` и
  `GET /api/watches/:filmId/count` приватностью не гейтятся.
- Лог изменений — коллекция `PrivacyChangeLog`, TTL 180 дней.

### Вкладки профиля и закреплённое достижение (B9)

Карточка профиля компактная. `GET /api/users/:id` отдаёт только
`{ user: { …, counters, pinnedAchievement, achievementsCount } }`; массивов
`ratings`, `reviews`, `comments`, `watches`, `achievements` в ответе больше нет.
**DECISION B9/1B:** это осознанно ломающее изменение — вкладки переехали в отдельные
эндпоинты, а двойной формат («массивы + вкладки») не поддерживается даже на релиз.

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| GET | `/api/users/:id/ratings` | — (скрытый → 404) | `{ items, pagination }`; vibe + full, `completeness` в каждом; `film` популен; сортировка по дате |
| GET | `/api/users/:id/reviews` | — (скрытый → 404) | `{ items, pagination }`; `status: approved` для чужих, всё для владельца/админа |
| GET | `/api/users/:id/comments` | — (скрытый → 404) | `{ items, pagination }`; оба `targetType`, `targetType` в каждом; у review популена цель |
| GET | `/api/users/me/pinned-achievement` | access | `{ pinnedAchievement }` — текущее значение |
| PUT | `/api/users/me/pinned-achievement` | access | `{ achievement: string \| null }`; `null` снимает закрепление |

Правила:

- `:id = me` — свои вкладки (`DECISION B9/7A`). Отдельных `/me/ratings` и т.п. нет:
  `me` разрешается тем же роутом по токену: без токена — `401 UNAUTHORIZED`.
- Пагинация — общая `utils/paging.js`: `page` (с 1), `limit` (1..100, по умолчанию 20),
  ответ `{ items, pagination: { page, limit, total, pages } }`.
- Статус-фильтр: чужой зритель видит только `approved`; владелец и админ — всё,
  включая `pending`/`rejected`.
- Скрытый профиль: все три вкладки отдают `404 PROFILE_HIDDEN` (как дневник, watchlist
  и «Понравившиеся»). Публичные эндпоинты контента (`GET /api/reviews/:filmId`,
  `GET /api/comments?targetType=…`) при этом не меняются: скрыт профиль, а не текст.
- `/ratings` отдаёт **все** оценки (vibe + full). `counters.ratings` считает только
  полные, поэтому он намеренно не равен `pagination.total` этой вкладки; `counters.vibes`
  с числом vibe-записей сходится. Это контракт, а не баг (`DECISION B9/2B+4A`).
- В `/comments` у элемента есть `targetType`, `targetId` (id цели) и `target`:
  для `review` — объект рецензии, для `film` — `null` (сам фильм уже в `film`).
  Так `targetId` остаётся идентификатором независимо от типа цели.
- `pinnedAchievement` — строка из `User.achievements` (например, «🎬 Первый шаг»),
  не ObjectId и не ссылка; без индекса. `PUT` принимает только уже полученное
  достижение, иначе `400 ACHIEVEMENT_NOT_EARNED`. Если запись потеряла достижение,
  чтение отдаёт `null` и пишет `[WARN]`, не падая.
- При скрытом профиле `pinnedAchievement` и `achievementsCount` не отдаются: в заглушке
  только `id`, `nickname`, `avatar`, `isHidden`.

### Пользователи, топ, события, админ

| Метод | Путь | Доступ |
|---|---|---|
| GET | `/api/users/:id` | — (email — только свой) | карточка: `user` + `counters` + `pinnedAchievement` + `achievementsCount`, без массивов |
| GET | `/api/users/nickname/:nickname` | — |
| GET | `/api/users/:id/ratings` / `reviews` / `comments` | — (скрытый → 404) | вкладки профиля, `{ items, pagination }` |
| GET/PUT | `/api/users/me/pinned-achievement` | access | закреплённое достижение |
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
npm test              # весь набор; нужен MongoDB на 127.0.0.1:27017
npm run test:vibe     # только B1, сам поднимает in-memory MongoDB
npm run test:aggregates  # только B2, тоже со своей in-memory MongoDB
npm run test:gating      # только B3, тоже со своей in-memory MongoDB
npm run test:reviews     # только B4, тоже со своей in-memory MongoDB
npm run test:watches     # только B5, тоже со своей in-memory MongoDB
npm run test:privacy     # только B-PRIVACY, тоже со своей in-memory MongoDB
npm run test:watchlist   # только B6, тоже со своей in-memory MongoDB
npm run test:likes       # только B7, тоже со своей in-memory MongoDB
npm run test:targets     # только B8, тоже со своей in-memory MongoDB
npm run test:tabs        # только B9, тоже со своей in-memory MongoDB
```

298 тестов на `node:test`: 112 в основных файлах (нужен MongoDB на `127.0.0.1:27017`),
14 в `vibe-rating.test.js`, 14 в `film-aggregates.test.js`, 15 в `comment-gating.test.js`,
15 в `review-gating.test.js`, 23 в `watch-diary.test.js`, 25 в `privacy.test.js`,
17 в `watchlist.test.js`, 19 в `film-likes.test.js`, 23 в `comment-targets.test.js`
и 21 в `profile-tabs.test.js` — эти десять сами поднимают in-memory MongoDB.
У каждого файла своя БД, поэтому параллельный запуск безопасен.

| Файл | Тестов |
|---|---|
| `tests/auth-invite.test.js` | 14 |
| `tests/auth-refresh.test.js` | 13 |
| `tests/contact.test.js` | 11 |
| `tests/counters.test.js` | 15 |
| `tests/errorHandler.test.js` | 9 |
| `tests/poster.test.js` | 17 |
| `tests/regression.test.js` | 33 |
| `tests/vibe-rating.test.js` | 14 |
| `tests/film-aggregates.test.js` | 14 |
| `tests/comment-gating.test.js` | 15 |
| `tests/review-gating.test.js` | 15 |
| `tests/watch-diary.test.js` | 23 |
| `tests/privacy.test.js` | 25 |
| `tests/watchlist.test.js` | 17 |
| `tests/film-likes.test.js` | 19 |
| `tests/comment-targets.test.js` | 23 |
| `tests/profile-tabs.test.js` | 21 |

`vibe-rating.test.js` не требует внешней Mongo: `npm run test:vibe`.
`film-aggregates.test.js` тоже: `npm run test:aggregates` — смешанные оценки, только
vibe, только full, пустой фильм, `weight: 0`, участники топа по каждой оси, `total`
по фильтру, округление, алиас `averageRating`, `sort=new`, пустой топ с подсказкой.
`comment-gating.test.js`: `npm run test:gating` — гейт комментариев, ответы, свой тред,
админ, `weight: 0`, лайки, legacy, приоритет 403 над 400, гонка.
`watch-diary.test.js`: `npm run test:watches` — дневник, пересмотры, дата в прошлом и
будущем, удаление своё/чужое, публичность и приватность, теги, отсутствие события,
привязка оценки и рецензии, `watchesCount` с `weight: 0`, миграция.
`review-gating.test.js`: `npm run test:reviews` — гейт рецензий, игнор `ratingId`,
границы длины, `isSpoiler` во всех выдачах, полный текст в админ-очереди.
`privacy.test.js`: `npm run test:privacy` — флаги и лог, TTL, заглушки скрытого профиля,
права владельца/админа, 404 на достижения и дневник, публичный контент скрытого,
агрегаты, лента, топ, `Event.userId` и обе миграции.
`watchlist.test.js`: `npm run test:watchlist` — добавление/повтор/удаление и
идемпотентность, чужое удаление, `check`, пагинация с `posterUrl`, приватность,
независимость от достижений, событий и дневника, лимит 201-го запроса, миграция.
`film-likes.test.js`: `npm run test:likes` — два разных счётчика, идемпотентные
`POST`/`DELETE` (включая двойные одновременные), `liked` в карточке фильма,
списки и приватность, `weight: 0`, пометка и снятие пометки фермы, лимит,
сверка и миграция.
`comment-targets.test.js`: `npm run test:targets` — гейтинг только для film,
комментарии к рецензии без оценки, pending/rejected, игнор `filmId`, правила
`parentId`, новый и старый роуты, изоляция слоёв, модерация, миграция.
`profile-tabs.test.js`: `npm run test:tabs` — карточка без legacy-массивов,
пагинация и `completeness` в `/ratings`, сортировка по дате, `counters.ratings`
против `pagination.total`, status-фильтр в `/reviews` и `/comments`, оба
`targetType`, `:id = me`, 404 скрытого профиля для всех вкладок,
pinnedAchievement (установка/снятие/ACHIEVEMENT_NOT_EARNED/потерянное достижение),
порядок роутов, нетронутые разделы, миграция.

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

`--dry-run` поддерживает `backfill-anti-farm.js` (шаг 6) и `flag-sybil-accounts.js`.
Остальные скрипты идемпотентны, но `new-invite.js` при каждом запуске создаёт новые
коды — это его работа, а не ошибка. После миграций перезапустить сервис и проверить
`GET /api/health`, вход старым аккаунтом, и что у фильма появились постеры.

Если что-то пошло не так — восстановление из бэкапа:
`mongorestore --uri="$MONGODB_URI" ./backup-2026-10-25`.

### P1 — двухступенчатая оценка (vibe/full)

Что делает миграция:

- `Rating` без `completeness` → `completeness: 'full'` (все старые оценки — полные);
- `User` без `counters.vibes` → `counters.vibes: 0`.

Скрипт идемпотентен, значения существующих полей не перезаписывает. Запускать **до деплоя**
нового кода, в Render Shell или на машине с доступом к базе.

```bash
# 0. Бэкап. Обязательно.
mongodump --uri="$MONGODB_URI" --out=./backup-$(date +%F)
# ожидаемо: ... done dumping cinephilium.ratings (N documents)

# 1. Сухой прогон: только считает, ничего не пишет.
node scripts/migrate-p1-vibe-ratings.js --dry-run
# ожидаемо: [migrate-p1] dry-run: ratings без completeness=1287, users без counters.vibes=48

# 2. Боевой прогон.
node scripts/migrate-p1-vibe-ratings.js
# ожидаемо: [migrate-p1] обновлено: ratings=1287, users=48

# 3. Повторный сухой прогон — проверка идемпотентности.
node scripts/migrate-p1-vibe-ratings.js --dry-run
# ожидаемо: ratings без completeness=0, users без counters.vibes=0

# 4. Прямая проверка в базе.
mongosh "$MONGODB_URI" --quiet --eval 'db.ratings.countDocuments({ completeness: { $exists: false } })'
# ожидаемо: 0
mongosh "$MONGODB_URI" --quiet --eval 'db.users.countDocuments({ "counters.vibes": { $exists: false } })'
# ожидаемо: 0
```

Только после шага 4 — деплой. Числа в примере условные; важны нули на шагах 3–4.

### B5 — дневник просмотров (Watch)

Что делает миграция:

- `User` без `counters.watches` → `0`;
- затем `counters.watches` выставляется **по факту** — по количеству записей `Watch`
  у пользователя (источник правды — коллекция, а не догадка);
- `User` без `diaryPrivate` → `false` (дневник открыт по умолчанию).

Коллекция `watch` новая, данных для переноса нет — создаются только индексы. Скрипт
идемпотентен, поэтому безопасен и после появления первых записей.

```bash
# 1. Сухой прогон.
node scripts/migrate-b5-watches.js --dry-run
# ожидаемо: [migrate-b5] dry-run: users без counters.watches=N, users без diaryPrivate=N, ...

# 2. Боевой прогон.
node scripts/migrate-b5-watches.js
# ожидаемо: [migrate-b5] обновлено: users=N, counters.watches=0

# 3. Повторный сухой прогон — проверка идемпотентности.
node scripts/migrate-b5-watches.js --dry-run
# ожидаемо: users без counters.watches=0, users без diaryPrivate=0
```

Важно: `counters.watches` считает и `counterMaintenance.js`, иначе ближайший
`migrate-counters.js` / `reconcile-counters.js` (он делает `$set: { counters }` целиком)
затёр бы поле.

### B-PRIVACY — приватность профиля и ленты

Две миграции, обе идемпотентны и поддерживают `--dry-run`. Запускать **до деплоя**.

```bash
# 1. Флаги приватности всем пользователям.
node scripts/add-privacy-fields.js --dry-run
# ожидаемо: [add-privacy] dry-run: users без privacy=N, без hideProfile=N, без hideFromFeed=N
node scripts/add-privacy-fields.js
# ожидаемо: [add-privacy] обновлено users=N

# 2. Автор события отдельным полем (Event.userId), матч по нику.
node scripts/add-event-userid.js --dry-run
# ожидаемо: [add-event-userid] dry-run: events без userId=N, сматчено=N, без пользователя=0
node scripts/add-event-userid.js
# ожидаемо: [add-event-userid] обновлено events=N
```

Правило по несматченным событиям: `0` — норма; ровно `1` — осиротевшее событие
(удалённый пользователь) пропускается с логом; **больше `1` — стоп** с кодом 1 и без
записи: это уже не одиночный случай, нужен разбор. Повторный прогон должен печатать
`events без userId=0`.

Почему это важно: без `Event.userId` старые события нельзя скрыть по `hideFromFeed`,
а без `privacy` у пользователя поле читается как «всё открыто» — миграция делает
состояние явным.

### B6 — watchlist

```bash
node scripts/add-watchlist-counters.js --dry-run
# ожидаемо: [add-watchlist] dry-run: users без counters.watchlist=N, пользователей с записями=0, всего users=N
node scripts/add-watchlist-counters.js
# ожидаемо: [add-watchlist] обновлено users=N, пропущено (значение уже верное)=M
```

Коллекция `watchlistitems` новая — переносить нечего, создаются только индексы.
Счётчик выставляется по факту из коллекции, поэтому повторный прогон печатает
`обновлено users=0`. Важно: `counters.watchlist` считает и `counterMaintenance.js`
(он делает `$set: { counters }` целиком) — без этого reconcile обнулил бы поле.

### B7 — сердечки

```bash
# 1. Поля: Film.likesCount и User.counters.filmLikes.
node scripts/add-film-likes-fields.js --dry-run
# ожидаемо: [add-film-likes] dry-run: films без likesCount=N, users без counters.filmLikes=N
node scripts/add-film-likes-fields.js
# ожидаемо: [add-film-likes] обновлено: films=N, users=N

# 2. Сверка публичного счётчика с фактическими лайками (weight > 0).
node scripts/reconcile-film-likes.js --dry-run
# ожидаемо: [reconcile-film-likes] dry-run: films=N, расхождений=0
node scripts/reconcile-film-likes.js
# ожидаемо: [reconcile-film-likes] apply: films=N, расхождений=0, исправлено=0
```

Коллекция `filmlikes` новая — переносить нечего. После первого прогона
`reconcile-film-likes` должен показывать `расхождений=0`; если нет — значит
`flag-sybil-accounts.js` когда-то пометил ферму на старом коде, и счётчик надо
долечить этим же скриптом (он идемпотентен). `counters.filmLikes` считает и
`counterMaintenance.js` — иначе `$set: { counters }` обнулил бы его.

### B8 — полиморфные комментарии

```bash
node scripts/migrate-comment-target.js --dry-run
# ожидаемо: [migrate-comment-target] dry-run: comments без targetType=N, film-комментариев без targetId=0
node scripts/migrate-comment-target.js
# ожидаемо: [migrate-comment-target] обновлено: targetType+targetId=N, targetId=0
```

Без миграции старые комментарии не имеют `targetType`/`targetId`. Чтение их терпит
(отсутствующий тип считается `film`), но новые выборки по `targetId` и второй индекс
рассчитаны на заполненные поля — поэтому миграция обязательна. Скрипт идемпотентен,
повторный прогон печатает нули.

### B9 — закреплённое достижение

```bash
node scripts/add-pinned-achievement.js --dry-run
# ожидаемо: [add-pinned-achievement] dry-run: users без pinnedAchievement=N, всего users=M
node scripts/add-pinned-achievement.js
# ожидаемо: [add-pinned-achievement] обновлено users=N, пропущено (поле уже есть)=M-N
node scripts/add-pinned-achievement.js --dry-run
# ожидаемо: users без pinnedAchievement=0
```

Скрипт только проставляет `pinnedAchievement: null` тем пользователям, у кого поля
ещё нет. Уже закреплённые достижения и явные `null` не трогает, поэтому повторный
прогон безопасен и даёт нули. Миграция нужна до деплоя B9: Mongoose прочитает
отсутствующее поле как `null` и без неё, но миграция выравнивает документы.

---

## 12. Деплой

**Бэкенд (Render или любой Node-хостинг):**

1. Build: `npm ci --omit=dev`; Start: `npm start`. `mongodb-memory-server` —
   devDependency только для тестов, на проде его ставить не нужно.
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

1. `REACT_APP_API_URL=https://<бэкенд>/api`; при необходимости
   `REACT_APP_BACKEND_URL=https://<бэкенд>` — origin для постеров (если не задан,
   берётся из `REACT_APP_API_URL` без `/api`).
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
node scripts/migrate-p1-vibe-ratings.js   # P1: completeness + counters.vibes
node scripts/migrate-b5-watches.js        # B5: counters.watches + diaryPrivate
node scripts/add-privacy-fields.js        # B-PRIVACY: privacy у всех
node scripts/add-event-userid.js          # B-PRIVACY: Event.userId по нику
node scripts/add-watchlist-counters.js    # B6: counters.watchlist по факту
node scripts/add-film-likes-fields.js     # B7: Film.likesCount + counters.filmLikes
node scripts/reconcile-film-likes.js      # B7: сверка публичного счётчика лайков
node scripts/migrate-comment-target.js    # B8: targetType/targetId у комментариев
node scripts/add-pinned-achievement.js    # B9: pinnedAchievement=null у всех
node scripts/backfill-anti-farm.js        # поля анти-накрутки + индексы
node scripts/flag-sybil-accounts.js --dry-run   # найти фермы
node scripts/flag-sybil-accounts.js             # пометить (weight=0)
node scripts/flag-sybil-accounts.js --unflag    # снять пометки
node scripts/check-secrets.js                   # проверка индекса git на секреты
node scripts/demo-registration.js               # демо-прогон регистрации (локальная база)
```

---

## 14. Ограничения и планы

- Распределённые фермы с перепроданными инвайтами — вне возможностей IP-детектора.
- Нет удаления оценок/рецензий → награды не откатываются.
- `updateAchievements` молча логирует ошибку, если соединение с Mongo не готово.
- Достижения пересчитываются только при действиях, а не по расписанию.
- Во вкладке оценок профиля и в ленте vibe-оценки показываются как `0`: бэкенд уже
  отдаёт `completeness` рядом с баллами, но старый фронт его не учитывает — это задача
  F1, не B2 (DECISION B2/5B). `0` на `null` там не меняем: это отменило бы DECISION 2A.
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
CHANGELOG.md        что изменилось в 5.x и почему
```
