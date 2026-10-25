# Cinephilium Backend

API кино-каталога: фильмы из TMDB, оценки по 15 критериям в 5 блоках, рецензии,
комментарии, модерация и геймификация (баллы, достижения, рейтинг пользователей).

Версия 3.0. Подробный список изменений этой итерации — в [CHANGELOG.md](./CHANGELOG.md).

---

## 1. Стек и требования

| | |
|---|---|
| Runtime | Node.js >= 20.19 |
| HTTP | Express 5 |
| БД | MongoDB + Mongoose 9 |
| Авторизация | JWT (access 15 мин + refresh 30 дней в HttpOnly cookie), bcrypt |
| Валидация | express-validator + ручные проверки в роутах |
| Безопасность | helmet, express-rate-limit, NoSQL-санитайзер, CORS по списку |
| Почта | nodemailer (SMTP) |

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
| `IMAGE_PROXY_BASE_URL` | — | если задан, постеры идут через `/api/tmdb-image` |
| `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` | — | без них письма не уходят |
| `EMAIL_CODE_TTL_MIN` | 10 | срок жизни кода подтверждения |
| `EMAIL_RESEND_COOLDOWN_SEC` | 60 | пауза между отправками |
| `EMAIL_RESEND_MAX_PER_HOUR` | 3 | лимит отправок в час |

---

## 4. Архитектура

```
src/server.js          точка входа: env → Mongo → listen
src/app.js             сборка Express: cors → helmet → limiter → json → cookie → sanitizer → роуты → 404 → ошибки
src/config/            env.js (конфиг), cors.js, scoring.js (формулы)
src/middleware/        auth.js, security.js, errorHandler.js, validate.js
src/models/            User, Film, Rating, Review, Comment, Event, Action, Session
src/routes/            по одному файлу на домен
src/services/mailer.js SMTP-письма
src/utils/             jwt, cookies, counters, poster, errors, achievements, validate, asyncHandler
api/tmdb-image.js      прокси постеров (Vercel + Express)
scripts/               миграции и обслуживание данных
tests/                 node:test, у каждого файла своя БД
```

### Порядок middleware (важен)

1. `cors` — до всего, чтобы ошибки тоже получали CORS-заголовки;
2. `helmet` — заголовки безопасности;
3. `globalLimiter` — 200 запросов/мин на IP;
4. `express.json({ limit: '100kb' })`;
5. `cookieParser()` — нужен для refresh;
6. `noSqlSanitizer` — **после** парсинга: рекурсивно вырезает ключи, начинающиеся с `$`,
   и ключи с точкой (защита от `$ne`, `$where`, `a.b`-инъекций);
7. роуты;
8. `notFoundHandler` → JSON 404;
9. `errorHandler` → единый формат ошибок.

`app.set('trust proxy', 1)` — приложение живёт за одним прокси (Render), поэтому `req.ip`
берётся из `X-Forwarded-For`, а rate-limit считает по реальному клиенту.

### Поток запроса на примере оценки

1. `POST /api/ratings` → `writeLimiter` (30/мин) → `ratingLimiter` (40/час) →
   `authenticate` (достаёт Bearer, проверяет подпись и `type: 'access'`, грузит пользователя) →
   `requireVerified` (403, если email не подтверждён).
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

### Подтверждение email

`register` → код (6 цифр, в БД только SHA-256, TTL 10 мин, 5 попыток) → `verify-email`.
Повторная отправка: cooldown 60 с, не больше 3 в час. До подтверждения логин отвечает
403 `EMAIL_NOT_VERIFIED`, а запись (оценки, рецензии, комментарии) — 403 через `requireVerified`.

### Сброс пароля

`forgot-password` → случайный 32-байтный токен, в БД только SHA-256, TTL 30 минут,
письмо со ссылкой `${CLIENT_URL}/reset-password?token=…`. Ответ всегда одинаковый,
существует email или нет. `reset-password` проверяет срок и одноразовость, меняет пароль
и **удаляет все сессии** пользователя.

**Когда письмо реально приходит:** только если настроены `SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS`, `SMTP_FROM`. В dev без SMTP ссылка печатается в консоль
(`[DEV] password reset link …`), в production без SMTP будет ошибка `EMAIL_SEND_FAILED`
в логах и пользователь письма не получит.

---

## 7. Модель данных

| Коллекция | Ключевые поля | Индексы |
|---|---|---|
| `users` | email*, password (bcrypt), nickname*, avatar, isAdmin, emailVerified, emailVerification, passwordReset, totalPoints, counters, achievements, consent, registeredIp, trustWeight, flagged | `email` unique, `nickname` unique, `{registeredIp, registeredAt}`, `flagged` |
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
| Регистрация | 10 аккаунтов/час с одного IP (считаются и успешные), обязательное подтверждение email |
| Оценки | 40/час с одного IP, одна оценка на пару user+film |
| Вес голоса | `Rating.weight` (0..1) копируется из `User.trustWeight` |
| Агрегаты | `$lookup` фильтрует `weight: { $ne: 0 }`, значит помеченные оценки не влияют на средние, топ фильмов и «votesCount» |
| Рейтинг | `/api/top/users` исключает `flagged: true` |
| Детектор | `scripts/flag-sybil-accounts.js`: кластеры `>= 5` аккаунтов за час с одного IP → `trustWeight = 0`, `weight = 0` |

Детектор запускается вручную (cron/руками), есть `--dry-run` и `--unflag`.
Порог консервативный, чтобы не задеть семью или офис с общим IP.

**Ограничение:** распределённая ферма (много IP + одноразовые почты) так не ловится.
Следующие шаги при необходимости: CAPTCHA (Turnstile/hCaptcha) на регистрацию, блок-лист
одноразовых доменов, правило «голоса аккаунтов младше 24 часов не входят в средние».

---

## 9. API

Все ответы — JSON. Ошибки: `{ "error": { "code", "message", "details?" } }`.

### Авторизация

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| POST | `/api/auth/register` | — | создать аккаунт (нужны `consent`), отправить код |
| POST | `/api/auth/verify-email` | — | подтвердить код, получить `accessToken` + cookie |
| POST | `/api/auth/resend-verification` | — | повторно отправить код |
| POST | `/api/auth/login` | — | вход (только для подтверждённых) |
| POST | `/api/auth/refresh` | cookie | ротация refresh, новый `accessToken` |
| POST | `/api/auth/logout` | cookie | завершить текущую сессию |
| POST | `/api/auth/logout-all` | access | завершить все сессии |
| POST | `/api/auth/forgot-password` | — | письмо со ссылкой сброса |
| POST | `/api/auth/reset-password` | — | сменить пароль по токену |
| GET | `/api/auth/me` | access | текущий пользователь |

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
| POST | `/api/ratings` | access + verified | поставить/обновить оценку |
| GET | `/api/ratings/user` | access | свои оценки |
| GET | `/api/ratings/:id/details` | — | детали оценки |
| POST | `/api/reviews` | access + verified | рецензия (450..15000 символов) |
| GET | `/api/reviews/:filmId` | — | одобренные рецензии (админ видит все) |
| GET | `/api/reviews/details/:id` | — | одобренную — всем, черновик — автору/админу |
| GET | `/api/reviews/user` | access | свои рецензии |
| POST | `/api/reviews/:id/like` | access | лайк, +5 автору |
| POST | `/api/comments` | access + verified | комментарий или ответ |
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

80 тестов на `node:test`, у каждого файла своя БД (`cinephilium-test-auth-email` и т.д.),
поэтому параллельный запуск безопасен. Нужен MongoDB на `127.0.0.1:27017`.

| Файл | Тестов |
|---|---|
| `tests/auth-email.test.js` | 10 |
| `tests/auth-refresh.test.js` | 13 |
| `tests/counters.test.js` | 15 |
| `tests/errorHandler.test.js` | 7 |
| `tests/poster.test.js` | 9 |
| `tests/regression.test.js` | 26 |

`regression.test.js` включает сквозной сценарий «регистрация → подтверждение → оценка →
рецензия → модерация» и проверки согласий и анти-накрутки.

В песочницах, где нельзя спавнить процессы, используйте
`node --test-isolation=none --test tests/<file>.test.js`.

---

## 11. Миграции (пошагово, простыми словами)

Ситуация: в базе уже есть пользователи и оценки, созданные старой версией. У них нет новых полей
(`consent`, `emailVerified`, `counters`, `weight` и т.д.). Код это переживает, но есть два
момента, которые **обязательно** надо исправить, иначе всё сломается:

1. **Старые пользователи не смогут войти.** Новый логин требует `emailVerified: true`, а у старых
   записей поля нет. Скрипт `backfill-email-verified.js` проставляет его существующим аккаунтам.
2. **Достижения и топ будут по нулям.** Они читают `counters`, которого у старых пользователей нет.
   `migrate-counters.js` пересчитывает счётчики по фактическим документам.

Порядок действий (на сервере, где есть доступ к базе):

```bash
# 0. Бэкап. Обязательно.
mongodump --uri="$MONGODB_URI" --out=./backup-$(date +%F)

# 1. Переменные окружения из продакшена (или .env)
export MONGODB_URI="mongodb+srv://..."
export JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=... TMDB_API_KEY=... ADMIN_SECRET_KEY=...

# 2. Зависимости и тесты (быстрая проверка, что код рабочий)
npm ci && npm test

# 3. Старые аккаунты помечаем подтверждёнными (иначе не войдут)
node scripts/backfill-email-verified.js

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
3. После первого деплоя прогнать миграции из §11.

**Фронтенд (Vercel):**

1. `REACT_APP_API_URL=https://<бэкенд>/api`.
2. Домен фронта должен совпадать с `CORS_ORIGIN` и `CLIENT_URL` на бэкенде, иначе
   CORS заблокирует запросы, а ссылка сброса пароля уйдёт не туда.

**Почта:** без `SMTP_*` письма не отправляются. Подойдёт SMTP Яндекса, SendGrid, Resend,
Mailgun — нужны host/port/user/pass и адрес отправителя в `SMTP_FROM`.

---

## 13. Обслуживание

```bash
node scripts/backfill-email-verified.js   # emailVerified старым аккаунтам
node scripts/migrate-counters.js          # первичный расчёт counters
node scripts/reconcile-counters.js        # сверка counters с документами
node scripts/migrate-posters.js           # poster -> posterPath
node scripts/backfill-anti-farm.js        # поля анти-накрутки + индексы
node scripts/flag-sybil-accounts.js --dry-run   # найти фермы
node scripts/flag-sybil-accounts.js             # пометить (weight=0)
node scripts/flag-sybil-accounts.js --unflag    # снять пометки
```

---

## 14. Ограничения и планы

- Распределённые фермы, одноразовые почты — вне возможностей IP-детектора.
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
CHANGELOG.md        что изменилось в 3.0 и почему
```
