# Контекст проекта для следующего агента

**Дата среза:** 29.10.2026  
**Ветка:** `feature/p1-vibe-ratings`  
**Репозиторий:** https://github.com/Fearrlesz/cinephilium-backend  
**Фронтенд:** https://github.com/Fearrlesz/cinephilium-frontend

Этот файл — не changelog и не README. Это рабочая карта: что за проект, как он устроен,
что уже сделано в P1/B1, какие решения зафиксированы и что нельзя сломать. Если ты
пришёл сюда без контекста — читай сверху вниз, затем README и CHANGELOG.

---

## 1. Что это за проект

**Cinephilium** — сайт, где фильмы оценивают не одной цифрой, а 15 критериями в 5 блоках
плюс субъективный «вайб». Из критериев считается `technicalScore` (10–100), из него и
вайба — `combinedScore` (10–100).

- Бэкенд: Node.js + Express 5 + MongoDB (Mongoose 9), JWT, bcrypt, TMDB.
- Фронтенд: отдельный репозиторий, React 18 (CRA 5), Vercel.
- Прод: Render (API), MongoDB Atlas, Vercel (фронт).
- Документация версии: backend `README.md` / `CHANGELOG.md` (сейчас 5.8).

### Ключевые продуктовые правила

- Регистрация только по инвайт-коду (режим `invite`), без почты и SMTP.
- Оценки, рецензии и комментарии привязаны к пользователю; рецензии/комментарии
  проходят модерацию (`pending` → `approved` / `rejected`).
- Есть анти-накрутка: IP-лимиты, `weight` голоса, детектор ферм.
- Геймификация: баллы, достижения, топ пользователей.

---

## 2. Текущее состояние (что уже произошло)

1. **P1/B1 — двухступенчатая оценка — реализован в этой ветке.**
   - vibe-оценка (одна цифра) → позже апгрейд до полной (15 критериев) на той же записи.
2. **Миграция P1 применена на проде 29.10.2026 (успешно).**
   - Старым `Rating` проставлен `completeness: 'full'`.
   - Всем `User` проставлен `counters.vibes: 0` (если поля не было).
   - Повторно запускать не нужно; скрипт идемпотентен, но смысла нет.
3. **Фронтенд ещё не обновлён под vibe/full.** Это следующая задача (F1).
4. **B2 — агрегаты фильмов — реализован в этой ветке.**
   - Средний вайб считается по **всем** оценкам; `averageTechnical` и `averageCombined` —
     только по `completeness: 'full'`. Vibe-ноль больше не «отравляет» техническое среднее.
   - Три счётчика: `votesCount` (vibe + full), `vibesCount`, `fullCount`.
   - В топах участвуют только те, у кого есть число по оси; `total` в топе считает
     участников. Каталог `/films` по-прежнему показывает все фильмы, `sort=new` — по дате.
   - Отличие намеренное: страница фильма отдаёт `0` как маркер (язык B1), списки и топы —
     `null`, чтобы старый фронт рисовал «—», а не красное «0.0» (DECISION B2/6.1).
5. **B3 — гейтинг комментариев — реализован в этой ветке.**
   - `POST /api/comments` (и корневой комментарий, и ответ) требует оценки фильма —
     любой, vibe или full. Нет оценки → `403 RATING_REQUIRED_FOR_COMMENT`.
   - Проверка стоит до валидации тела и до модерации; лайки не гейтятся.
   - `weight: 0` считается оценкой (гейтинг про «смотрел ли»); админ не исключение.
   - Отдельного `can-post` нет: фронт смотрит на `userRating` в `GET /films/:id`.
   - Legacy-комментарии не тронуты и не помечены, миграции нет (`DECISION B3/1A`).
   - Хелпер `src/utils/ratingGate.js` параметризован по `completeness` — B4 попросит `'full'`.
6. **B4 — гейтинг рецензий — реализован в этой ветке.**
   - `POST /api/reviews` требует `completeness: 'full'`; иначе
     `403 FULL_RATING_REQUIRED_FOR_REVIEW`. Гейт до валидации тела и до модерации.
   - `ratingId` из тела **игнорируется**: сервер берёт `_id` своей оценки (B4/1A).
     Проверка «чужая оценка» удалена как невозможная.
   - `isSpoiler` — новый флаг в `Review`, `default: false`, отдаётся везде, включая
     профиль (там поля перечисляются руками!). Фильтра `?spoiler` на бэке нет (B4/4).
   - В админ-очереди спойлер отдаётся полным текстом (B4/5).
   - Минимум текста **остался 350**: понижение до 10 отклонено заказчиком (B4/2).
   - Миграция не нужна (B4/migration).
7. **B5 — дневник просмотров (Watch) — реализован в этой ветке.**
   - Новая коллекция `watch`, НЕ поле в `Rating`: записей на фильм может быть много
     (пересмотры). Не «упрощать» обратно в `Rating.watchedAt` — это откат идеи.
   - `POST /api/watches` не гейтится; `watchedAt` в прошлом — норма, в будущем — 400;
     `isRewatch` ручной; теги без модерации (лимиты в роуте).
   - `counters.watches` (создание/удаление) + `User.diaryPrivate`; миграция
     `scripts/migrate-b5-watches.js` **нужна** (в отличие от B4).
   - Публичный дневник по умолчанию, закрывается через `PATCH /api/watches/settings`;
     `watchesCount` на фильме считает все записи, включая `weight: 0` (B5/6).
   - Связь с оценкой/рецензией — только явный `watchId` (B5/2); автосоздания записи
     при оценке НЕТ (B5/8); события в ленту нет (B5/5).
8. **B-PRIVACY — приватность профиля и ленты — реализован в этой ветке.**
   - Два независимых флага: `User.privacy.hideProfile` и `hideFromFeed`.
     Управление — `GET/PUT /api/users/me/privacy`, лог в `PrivacyChangeLog` (TTL 180 дней).
   - Скрываются только личные разделы: дневник, оценки, достижения. Рецензии
     и комментарии остаются видимыми (C2), оценки скрытого — в агрегатах (F1).
   - `GET /api/users/:id` и `/nickname/:nickname` отдают заглушку
     `{ id, nickname, avatar, isHidden: true }`; `/achievements` и `/:id/watches` — 404.
   - `GET /api/events` фильтрует по `Event.userId` (вариант A), `GET /api/top/users`
     исключает скрытых.
   - Retro-fit B5: публичный дневник гейтится `canViewProfile` (404), но
     `POST/DELETE`, `GET /api/watches/me` и `GET /api/watches/:filmId/count` — нет.
   - Миграции: `scripts/add-privacy-fields.js` и `scripts/add-event-userid.js` —
     **обе нужны** до деплоя.
9. **B6 — watchlist («хочу посмотреть») — реализован в этой ветке.**
   - Отдельная коллекция `watchlistitem`: **одна** запись на пару user+film (unique),
     не массив в `User` — иначе ломаются пагинация, populate и лимиты.
   - `POST` идемпотентен (первое — 201, повтор — 200), `DELETE` идемпотентен (всегда
     200 `{ inWatchlist: false }`, без `{ deleted }` и без 404 на «уже удалено»).
   - Публичный список `GET /api/users/:id/watchlist` гейтится `canViewProfile` → 404;
     свои эндпоинты и `check` — нет.
   - Не влияет на достижения (2A) и не создаёт событие; создание `Watch` не удаляет
     фильм из watchlist (3B).
   - Лимитер `watchlistLimiter`: 200/час **на аккаунт** (ключ `userId`, после authenticate).
   - `counters.watchlist` считается в `counterMaintenance` (иначе reconcile обнулит!).
   - Миграция `scripts/add-watchlist-counters.js` — нужна до деплоя.
10. **B7 — сердечко фильма — реализован в этой ветке.**
   - Коллекция `filmlike`: **одна** запись на пару user+film, `weight` — снимок
     `trustWeight` на момент лайка (тот же паттерн, что `Rating.weight`).
   - `POST /api/films/:id/like` = «поставить», `DELETE` = «снять»; оба идемпотентны.
     Это не toggle: иначе два одновременных `POST` давали бы разный результат в
     зависимости от планировщика (см. DECISION B7/1A).
   - **Два разных числа:** `Film.likesCount` (публичный агрегат, только `weight > 0`)
     и `User.counters.filmLikes` (личный счётчик, включая `weight: 0`). Не путать.
   - `GET /api/users/:id/likes` гейтится `canViewProfile` → 404; `/me/likes` — нет.
   - `likeLimiter`: 200/час на IP; событие не создаётся; достижения не затрагиваются.
   - `flag-sybil-accounts.js` теперь трогает 4 места и **пересчитывает** `likesCount`
     затронутых фильмов (не инкремент) — идемпотентно.
   - Миграции `add-film-likes-fields` и `reconcile-film-likes` — до деплоя.
11. **B8 — полиморфные комментарии (фильм | рецензия) — реализован в этой ветке.**
   - `Comment.targetType` (`film`/`review`) + `targetId`; `filmId` остаётся legacy-полем
     и заполняется сервером (у review — из рецензии). Не удалять: по нему работают
     старый роут, профиль и агрегаты.
   - POST без `targetType` считается `film` (совместимость со старым фронтом).
   - Гейтинг B3 — **только** для `targetType: 'film'`; комментарий к рецензии оценки
     не требует. Премодерация `pending` — для обоих типов.
   - Черновик/отклонённая рецензия: посторонним `404`, автору и админу
     `403 REVIEW_NOT_PUBLISHED`.
   - Старый `GET /api/comments/:filmId` — только комментарии к фильму (иначе треды
     рецензий протекают: у них `filmId` тоже заполнен).
   - Чтение терпит немигрированные документы: отсутствующий `targetType` = `film`.
   - `parentId`: тот же target, родитель `approved`, один уровень вложенности.
   - Событие в ленту — только для комментариев к фильму (B8/7B).
   - Миграция `scripts/migrate-comment-target.js` — до деплоя.
12. **277 тестов, все зелёные** (см. §8).

> Важно: миграция уже прошла. Не запускай её на проде «на всякий случай». Для проверки
> достаточно `countDocuments` из §7.

---

## 3. Стек и запуск

| Слой | Что используется |
|---|---|
| Runtime | Node.js >= 20.19 |
| HTTP | Express 5.3 |
| БД | MongoDB + Mongoose 9 |
| Авторизация | JWT HS256: access 15 мин + refresh 30 дней в HttpOnly cookie |
| Пароли | bcryptjs |
| Валидация | express-validator + ручные проверки |
| Безопасность | helmet, express-rate-limit, NoSQL-санитайзер, CORS |
| Сжатие | `compression` (gzip JSON) |
| Внешние API | TMDB (поиск/импорт), прокси постеров |
| Тесты | `node:test`; B1-тесты — `mongodb-memory-server` |

Локальный запуск:

```bash
npm ci
cp .env.example .env      # заполнить секреты
npm start                 # http://localhost:3000/api/health
npm test                  # нужен MongoDB на 127.0.0.1:27017
npm run test:vibe         # только B1, поднимает in-memory MongoDB
```

Обязательные env: `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`TMDB_API_KEY`, `ADMIN_SECRET_KEY`. Полный список — `.env.example`.

Деплой: Render, Build `npm ci --omit=dev` (иначе поставится dev-зависимость
`mongodb-memory-server`), Start `npm start`. Env для прода: `NODE_ENV=production`,
`COOKIE_SECURE=true`, `CORS_ORIGIN=https://<фронт>`, `CLIENT_URL=https://<фронт>`.

---

## 4. Архитектура бэкенда

```
src/server.js          env → Mongo.connect → app.listen, при ошибке exit 1
src/app.js             сборка Express
src/config/            env.js, cors.js, scoring.js
src/middleware/        auth.js, security.js, errorHandler.js, validate.js
src/models/            User, Invite, ContactRequest, Film, Rating, Review, Comment,
                       Event, Action, Session
src/routes/            auth, films, comments, reviews, ratings, users, admin,
                       tmdb, events, top, contact
src/utils/             jwt, cookies, tokens, counters, poster, errors, achievements,
                       validate, helpers, points, telegram, counterMaintenance,
                       asyncHandler
api/tmdb-image.js      прокси постеров (Express + Vercel)
scripts/               миграции и обслуживание
tests/                 node:test
```

Порядок middleware в `src/app.js` (важен):

1. `cors` — до всего;
2. `helmet`;
3. `compression` — gzip JSON, картинки не трогает;
4. прокси постеров `/api/tmdb-image` и алиас `/api/poster/:size/*` — до общего лимита,
   со своим `imageLimiter` (1200/мин);
5. `globalLimiter` (200/мин на IP);
6. `express.json({ limit: '100kb' })`;
7. `cookieParser()`;
8. `noSqlSanitizer` — после парсинга;
9. роуты;
10. health (`/api/health`) и корень `/`;
11. `notFoundHandler` → `errorHandler`.

`app.set('trust proxy', 1)`; лимиты считают IP через `clientIp()`:
`cf-connecting-ip` → `x-real-ip` → `req.ip`.

### Формат ошибок

`{ "error": { "code", "message", "details?" } }`. Исключение — прокси постеров:
`{ "error": "строка" }`.

---

## 5. Модель данных (самое важное)

### User

- `nickname` (unique), `password` (bcrypt), `email` (optional, legacy), `telegram`,
  `avatar`, `isAdmin`, `invitedBy`, `passwordReset`, `totalPoints`,
  `counters`, `privacy`, `achievements`, `consent`, `registeredIp`, `trustWeight`, `flagged`,
  `diaryPrivate` (B5: закрытый дневник), `vibeWindow` (служебное, `select: false`).
- `privacy` (B-PRIVACY): `hideProfile` и `hideFromFeed` — независимые флаги, default false.
- `counters`: `ratings`, `vibes`, `reviews`, `reviewsApproved`, `comments`,
  `commentsApproved`, `filmLikes`, `watches`, `watchlist`, `followers`, `following`,
  `likesReceived`.
- `counters.ratings` — **только полные** оценки; `counters.vibes` — **только текущие**
  vibe-оценки (при апгрейде уменьшается); `counters.watches` — **все** записи дневника,
  включая пересмотры.

### Rating (главный объект P1)

| Поле | Смысл |
|---|---|
| `userId`, `filmId` | пара уникальна (`{userId, filmId}` unique) |
| `completeness` | `'vibe'` или `'full'`, default `'full'` |
| `vibe` | 1..10, обязателен всегда |
| `scores` | 15 критериев; у vibe отсутствует |
| `genrePreset`, `blockWeights` | только у full |
| `technicalScore`, `combinedScore` | 10..100 у full; `0` у vibe |
| `textReview` | короткий текст к оценке (<=2000), только full |
| `weight` | 0..1, анти-накрутка |
| `ip` | IP последнего сохранения |
| `vibeCreatedAt` | когда создана vibe (для капа), `select: false` |

Правила:

- `completeness: 'vibe'`: `technicalScore = 0`, `combinedScore = 0`, `scores` нет.
- `completeness: 'full'`: 15 критериев + vibe, баллы 10–100.
- Одна запись на пару user+film; апгрейд не создаёт новую.
- `weight` при апгрейде берётся из существующей записи (включая `0`),
  `ip` — текущий, `createdAt` не меняется.
- Даунгрейда нет.

### Остальные коллекции

- `Invite`: `codeHash` (SHA-256), `codePrefix`, `note`, `createdBy`, `usedBy`,
  `usedAt`, `revokedAt`, `expiresAt`.
- `Film`: `tmdbId`, `title`, `year`, `posterPath`, `poster` (legacy), `description`,
  `genres`, `director`, `actors`, `trailer`, `createdBy`.
- `Review`: `text` 350..15000, `ratingId` — своя оценка **того же** фильма,
  `isSpoiler` (default `false`).
- `Watch` (B5): `userId`, `filmId`, `watchedAt` (не в будущем), `isRewatch` (ручной),
  `tags` (1–30 символов, до 10, без модерации), `ratingId`/`reviewId` (опциональные
  ссылки, ставятся только по явному `watchId` при создании оценки/рецензии).
  **Много записей на пару user+film** — это пересмотры, а не дубликаты.
- `Comment` (B8 — полиморфный): `targetType` (`film`/`review`) + `targetId`, `text` <=1000,
  `parentId` — один уровень ответов, `filmId` — legacy-поле, всегда заполнено
  (у review — из рецензии). Индексы: `{filmId, createdAt}` и `{targetType, targetId, createdAt}`.
- `Event`: типы `rating`, `vibe`, `review`, `comment`, `film_add`, `achievement`;
  `userId` — автор (B-PRIVACY, вариант A), `user` — ник для отображения.
  Создаётся **только** через `createEvent`: он требует `userId` и без него событие
  не пишет. Прямых `Event.create` в роутах быть не должно.
- `PrivacyChangeLog` (B-PRIVACY): `userId`, `field`, `oldValue`, `newValue`, `changedAt`, `ip`;
  TTL 180 дней. Пишется только при фактическом изменении флага.
- `WatchlistItem` (B6): `userId`, `filmId`, `addedAt`; **одна** запись на пару
  user+film (`{userId, filmId}` unique). Это состояние, а не история: «пересмотров»
  в watchlist не бывает.
- `FilmLike` (B7): `userId`, `filmId`, `weight` (снимок `trustWeight`), `addedAt`;
  **одна** запись на пару (`unique`). `Film.likesCount` — публичный агрегат по
  `weight > 0`; `User.counters.filmLikes` — личный счётчик по всем лайкам. Это разные
  числа, путать нельзя.
- `Action`: типы `rating`, `review`, `comment`, `like`, `import`, `admin_bonus`.
- `Session`: `tokenHash`, TTL по `expiresAt`.

---

## 6. P1/B1: как работает двухступенчатая оценка

### API

`POST /api/ratings`:

**Vibe (лайт):**

```json
{ "filmId": "...", "vibe": 8 }
```

→ `201`, в ответе `completeness: "vibe"`, `technicalScore: 0`, `combinedScore: 0`,
`scores: null`, `blockWeights: null`, `genrePreset: null`.

**Full (как раньше):**

```json
{
  "filmId": "...",
  "scores": { "scenario": { "plot": 8, "ideas": 8, "dialogue": 8 }, "...": "..." },
  "vibe": 8,
  "genrePreset": "drama",
  "blockWeights": [25, 20, 20, 15, 20],
  "textReview": "…"
}
```

→ `201`, `completeness: "full"`, баллы 10–100.

**Апгрейд vibe → full:** тот же payload, что full; `_id`/`createdAt` те же,
`completeness` становится `'full'`. Если `vibe` не передан — берётся старый.

**Ошибки:**

- `400 ALREADY_FULL_RATING` — vibe-запрос к уже полной оценке.
- `429 VIBE_LIMIT_REACHED` — больше 50 новых vibe за 24 часа;
  `details: { limit: 50, window: '24h', retryAt: ISO }`.
- `400 VALIDATION_ERROR` — неполный full, лишние поля в лайт-запросе и т.п.

### Зафиксированные решения (ищи `// DECISION` в коде)

- **1A** — даунгрейда нет. Full → vibe нельзя; админского пути тоже нет.
- **2A** — «не вычислено» = `0`, `min: 0`; валидные баллы 10–100.
- **3A** — `vibe` можно изменить при апгрейде; если не пришёл — старый.
- **4C+** — геймификация ниже.
- **5A** — лайт строгий: только `filmId` + `vibe`; `scores`/`textReview`/веса
  без полных 15 критериев → 400.
- **6A** — `completeness` отдаётся везде, где API возвращает рейтинг.

### Кап 50/24ч

- Скользящее окно хранится в `User.vibeWindow` (массив дат, `select: false`).
- Проверка + занятие слота — одна атомарная pipeline-операция
  `User.collection.findOneAndUpdate`: отфильтровать старые даты, проверить размер,
  добавить новую. Mongo сериализует обновления одного документа.
- Кап действует только на **создание** vibe. Повторная правка vibe слот не тратит.
  Апгрейд капом не ограничен.
- Слот занимается до вставки `Rating`. Если вставка упадёт по редкой ошибке БД,
  слот останется израсходованным — транзакций в проекте нет, это сознательный компромисс.
- `Rating.vibeCreatedAt` нужен, чтобы считать созданные vibe, даже если их потом
  апгрейднули; наружу не отдаётся.

### Начисления

| Действие | Баллы | counters | Событие | Достижения |
|---|---|---|---|---|
| Новая vibe | +2 | `vibes +1` | `vibe` (`score: null`) | не пересчитываются |
| Апгрейд vibe → full | +8 (итого 10) | `ratings +1`, `vibes −1` | `rating` | `updateAchievements` |
| Новая full сразу | +10 (+20 админу) | `ratings +1` | `rating` | `updateAchievements` |
| Повторная full / vibe | 0 | 0 | нет | нет |

На апгрейде достижения считаются **до** `vibes −1`, иначе `FIRST_VIBE` не выдался бы
тем, кто сразу апгрейдится.

### Достижения

- `effective = counters.ratings + counters.vibes / 5`.
- Пороги: 20 / 50 / 100 / 200 (`RATING_20`, `RATING_50`, `RATING_100`, `RATING_200`).
- `FIRST_RATING` («Первый шаг») — только за первую полную.
- `FIRST_VIBE` («💭 Первое впечатление») — за первую vibe.
- `FIRST_FRAME` («Первый кадр») — первые 100 зарегистрированных **и** `ratings >= 1`.
- Уже выданные достижения не отбираются: `updateAchievements` только добавляет.
- UI-строки старых ачивок не менялись; `FIRST_RATING` остался «Первый шаг»
  (фронт может показать «Первый глубокий шаг» — это его дело).

---

## 7. Миграция P1 (уже выполнена)

Скрипт: `scripts/migrate-p1-vibe-ratings.js`.

Что делает:

- `Rating` без `completeness` (или `null`) → `'full'`.
- `User` без `counters.vibes` (или `null`) → `0`.
- Идемпотентно; `--dry-run` только считает.

На проде выполнено 29.10.2026. Контрольные запросы (должны быть нули):

```bash
mongosh "$MONGODB_URI" --quiet --eval 'db.ratings.countDocuments({ completeness: { $exists: false } })'
mongosh "$MONGODB_URI" --quiet --eval 'db.users.countDocuments({ "counters.vibes": { $exists: false } })'
```

Если когда-нибудь понадобится повторить (например, восстановление из старого бэкапа) —
порядок: бэкап → `--dry-run` → боевой прогон → повторный `--dry-run` (нули) → проверка
`mongosh` → деплой. Подробности и ожидаемый вывод — README §11.

---

## 8. Тесты

- Всего **277**: 112 в старых файлах + 14 в `tests/vibe-rating.test.js` (B1)
  + 14 в `tests/film-aggregates.test.js` (B2) + 15 в `tests/comment-gating.test.js` (B3)
  + 15 в `tests/review-gating.test.js` (B4) + 23 в `tests/watch-diary.test.js` (B5)
  + 25 в `tests/privacy.test.js` (B-PRIVACY) + 17 в `tests/watchlist.test.js` (B6)
  + 19 в `tests/film-likes.test.js` (B7) + 23 в `tests/comment-targets.test.js` (B8).
- Эти девять файлов используют `mongodb-memory-server` — внешняя Mongo не нужна:

  ```bash
  npm run test:vibe          # 14/14
  npm run test:aggregates    # 14/14
  npm run test:gating        # 15/15
  npm run test:reviews       # 15/15
  npm run test:watches       # 23/23
  npm run test:privacy       # 25/25
  npm run test:watchlist     # 17/17
  npm run test:likes         # 19/19
  npm run test:targets       # 23/23
  ```

- Остальные 112 требуют MongoDB на `127.0.0.1:27017`:

  ```bash
  npm test
  ```

  В среде без Mongo их можно прогнать, подняв `mongodb-memory-server` на порту 27017
  и запустив `node --test tests/<file>.test.js`. Важно: для каждого прогона бери
  **свежий `dbPath`** — иначе остатки старой БД ломают auth-тесты (bootstrap-режим
  и инвайты). В этой сессии так и было: 112/112 на чистой in-memory базе.

- Что покрыто B1-тестами: лайт, full, повторный лайт, апгрейд (id/createdAt/weight/ip),
  апгрейд без vibe, запрет даунгрейда, строгий лайт, кап 50/24ч (49/50, скользящее окно),
  достижения, `completeness` во всех выдачах, отсутствие утечки `vibeWindow`/
  `vibeCreatedAt`, повторная full без двойных баллов, миграция.

- Что покрыто B2-тестами (`film-aggregates.test.js`): смешанные оценки (вайб по всем,
  технический только по full), только vibe, только full, фильм без оценок, `weight: 0`
  не влияет ни на что, участники топа по каждой оси, `total` по фильтру, единое
  округление до десятых, алиас `averageRating`, `sort=new`, пустой топ с `fallback`.

- Что покрыто B3-тестами (`comment-gating.test.js`): нет оценки → 403 (и ничего не
  создаётся), vibe-оценка, полная, ответы на чужой и на свой комментарий без оценки,
  админ без оценки, `weight: 0`, лайк без оценки, видимость legacy-комментария,
  приоритет 403 над 400, кривой `filmId`, несуществующий фильм, согласованность
  с `userRating`, повторный запрос после гонки.

- Что покрыто B4-тестами (`review-gating.test.js`): отказ без оценки и с vibe-only,
  full открывает, админ и `weight: 0` (наследуют B3), приоритет 403 над 400, апгрейд
  vibe → full, игнор `ratingId` из тела (включая чужой), запрос без `ratingId`,
  границы 349/350 и 15000/15001, `isSpoiler` во всех выдачах и в профиле, старая
  рецензия без поля читается как false, полный текст в админ-очереди.

- Что покрыто B5-тестами (`watch-diary.test.js`): запись без оценки, пересмотры
  (много записей на фильм), дата в прошлом и в будущем, теги и лимиты, ручной
  `isRewatch`, удаление своё/чужое, пагинация и сортировка, публичный и закрытый
  дневник, `watchesCount` с `weight: 0`, отсутствие события в ленте, привязка
  оценки и рецензии по `watchId`, отсутствие автосоздания записи, миграция.

- Что покрыто B-PRIVACY-тестами (`privacy.test.js`): флаги и partial update, лог только
  при изменении, TTL-индекс, заглушка профиля и `/nickname`, 404 на достижения и дневник,
  права владельца/админа, публичный контент скрытого, участие в агрегатах, топ, лента,
  `canViewProfile` unit, `Event.userId` через `createEvent`, обе миграции (включая стоп
  при >1 несматченных), retro-fit дневника и счётчик без фильтра.

- Что покрыто B6-тестами (`watchlist.test.js`): добавление/повтор/удаление,
  идемпотентность удаления и счётчика, чужое удаление, `check`, пагинация и `posterUrl`,
  публичный список при открытом и скрытом профиле (404/владелец/админ),
  независимость от достижений, событий и создания `Watch`, лимит 201-го запроса
  (с ротацией IP — доказывает, что ключ на аккаунт), миграция.

- Что покрыто B7-тестами (`film-likes.test.js`): два разных счётчика (фильм 2 —
  у каждого в профиле 1), идемпотентные `POST`/`DELETE` и их двойные одновременные
  вызовы, `liked` в карточке фильма для анонима и авторизованного, списки и
  приватность (404/владелец/админ), `weight: 0`, пометка и снятие пометки фермы,
  отсутствие события и влияния на достижения, лимит 201-го запроса, сверка и миграция.

- Что покрыто B8-тестами (`comment-targets.test.js`): гейтинг только для `film`,
  комментарий к рецензии без оценки, `pending`/`rejected` (404 посторонним,
  403 автору/админу), игнор `filmId` из тела, правила `parentId` (другая цель,
  pending-родитель, второй уровень), новый `GET /api/comments` и старый роут,
  изоляция слоёв (комментарии к рецензиям не протекают в список фильма),
  терпимость к немигрированным, лайк, модерация (событие только для film),
  админ-очередь, видимость ника скрытого автора, миграция.

- Счётчики: `tests/counters.test.js` обновлён под `counters.vibes` и
  `completeness`-фильтры.

---

## 9. Анти-накрутка и модерация (не сломать)

- Регистрация: 10/час с IP + одноразовый инвайт.
- Оценки: 40/час с IP; одна пара user+film.
- Vibe: 50/24ч на пользователя.
- `weight` — из `User.trustWeight` при создании; при апгрейде **сохраняется**
  из существующей записи.
- Агрегаты фильмов (`$lookup`) фильтруют `weight: { $ne: 0 }` — это касается всех трёх
  средних и всех трёх счётчиков. Фильтр не убирать.
- Единственное исключение — `watchesCount` на странице фильма (B5): он считает **все**
  записи дневника, включая `weight: 0`. Это намеренно (DECISION B5/6), а не забытый фильтр.
- Списки `/films/:id/ratings` и `/films/:id/users` тоже фильтруют `weight: 0`.
- `/api/top/users` исключает `flagged: true`.
- Детектор: `scripts/flag-sybil-accounts.js`.
- Рецензии/комментарии: `pending`; публично — `approved`; автор видит свой pending
  в карточке фильма, админ — всё.

---

## 10. Что дальше (roadmap)

### B2 — агрегаты (сделано)

Две оси разведены: `averageVibe` по всем, `averageTechnical`/`averageCombined` только по
`completeness: 'full'`, три счётчика (`votesCount` = vibe + full, `vibesCount`, `fullCount`).
Топы ранжируют только участников оси и считают `total` по фильтру. Каталог показывает все
фильмы, `sort=new` — по дате. `averageRating` — алиас `averageTechnical` (DECISION B2/1A).
Подробности и список решений — CHANGELOG 5.1.

Следующему агенту важно: `0` на странице фильма и `null` в списках/топах — это **намеренно**
(DECISION B2/6.1), не баг и не «недоделка».

### B3 — гейтинг комментариев (сделано)

Комментарий к фильму пишет только тот, кто его оценил — любой оценкой. Проверка стоит
в `POST /api/comments` до валидации тела и до модерации (`403 RATING_REQUIRED_FOR_COMMENT`),
одинаково для корневых комментариев и ответов. Лайки не гейтятся. `weight: 0` считается,
админ не исключение. Legacy-комментарии не помечены и не скрыты, миграции нет.
Подробности — CHANGELOG 5.2.

### B4 — гейтинг рецензий (сделано)

Рецензию пишет только тот, кто прошёл 15 критериев: `403 FULL_RATING_REQUIRED_FOR_REVIEW`,
гейт до валидации тела и до модерации. `ratingId` ставит сервер из своей оценки, из тела
он игнорируется (B4/1A) — поэтому проверка «чужая оценка» удалена. `isSpoiler` —
`default: false`, отдаётся везде, включая профиль (там поля перечислены руками).
Минимум текста **остался 350** — понижение до 10 отклонено заказчиком, не «забыли».
Фильтра `?spoiler` на бэке нет, в админ-очереди текст полный. Подробности — CHANGELOG 5.3.

### B5 — дневник просмотров (сделано)

Отдельная коллекция `watch`, не поле в `Rating`: записей на фильм может быть много
(пересмотры). Создание не гейтится, `watchedAt` в будущем → 400, `isRewatch` ручной,
теги без модерации. Публичный по умолчанию, закрывается через `PATCH /api/watches/settings`
(`User.diaryPrivate`); закрытый отдаётся владельцу и админу, остальным `403 DIARY_PRIVATE`.
`counters.watches` + миграция `scripts/migrate-b5-watches.js`. Связь с оценкой/рецензией —
только явный `watchId`; автосоздания записи при оценке нет. Подробности — CHANGELOG 5.4.

Следующему агенту важно: `watchesCount` на фильме **сознательно** считает записи
пользователей с `weight: 0` (DECISION B5/6) — это не забытый фильтр.

### B-PRIVACY — приватность профиля и ленты (сделано, retro-fit B5 выполнен)

Два независимых флага `User.privacy`: `hideProfile` и `hideFromFeed`. Скрываются только
личные разделы (дневник, оценки, достижения); рецензии и комментарии остаются видимыми,
оценки скрытого участвуют в агрегатах. `canViewProfile(viewer, target)` в
`src/utils/privacy.js` — с веткой-заглушкой под «друзей» (`// TODO: B-SOCIAL`), её же
должен использовать будущий B6/watchlist.

`Event.userId` (вариант A): `createEvent` требует `userId` и без него событие не пишет;
лента фильтруется по `userId`, а не по нику. Миграции `add-privacy-fields` и
`add-event-userid` — обе нужны до деплоя.

Публичный дневник (B5) теперь гейтится: `GET /api/users/:id/watches` и
`GET /api/watches/user/:id` при скрытом профиле отдают `404 PROFILE_HIDDEN`. Свои
эндпоинты дневника и счётчик по фильму не гейтятся. Подробности — CHANGELOG 5.5.

### B6 — watchlist (сделано)

Отдельная коллекция `watchlistitem`, одна запись на пару user+film. `POST` и `DELETE`
идемпотентны (`{ inWatchlist }` в ответе, без `{ deleted }`), `check` для кнопки,
свой список и публичный `GET /api/users/:id/watchlist` с `canViewProfile` → 404.
Не влияет на достижения и не создаёт события; создание `Watch` фильм не убирает (3B).
Лимит добавлений — 200/час на аккаунт. Подробности — CHANGELOG 5.6.

### B7 — лайк фильма (сделано)

Коллекция `filmlike`, одна запись на пару user+film. `POST` = «поставить»,
`DELETE` = «снять», оба идемпотентны — это **не** toggle (DECISION B7/1A: иначе
два одновременных POST дают разный результат в зависимости от планировщика).
`counters.filmLikes` убран из `unsupportedCounters` и считается по `FilmLike`.
`flag-sybil-accounts.js` трогает четыре места и пересчитывает `likesCount`
затронутых фильмов. Списки: `/api/users/:id/likes` (canViewProfile → 404) и
`/api/users/me/likes`. Лимит — 200/час на IP. Подробности — CHANGELOG 5.7.

Следующему агенту важно: `Film.likesCount` (публичный, только `weight > 0`) и
`User.counters.filmLikes` (личный, все лайки) — **разные числа**. Тест, где у одного
из двух пользователей `filmLikes: 2`, означал бы баг.

### B8 — полиморфные комментарии (сделано)

`Comment` полиморфен: `targetType` (`film`/`review`) + `targetId`, `filmId` остаётся
legacy-полем и заполняется сервером (у review — из рецензии). Гейтинг B3 — только для
`film`; премодерация для обоих типов. Комментировать можно только `approved`-рецензию
(посторонним 404, автору/админу 403 `REVIEW_NOT_PUBLISHED`; `rejected` — так же).
Старый `GET /api/comments/:filmId` отдаёт только комментарии к фильму — иначе треды
рецензий протекают. Событие в ленту — только для film. Подробности — CHANGELOG 5.8.

### B9 — вкладки профиля (следующая задача)

**Проверено по коду: не реализовано.** `GET /api/users/:id` отдаёт всё одним ответом
(`user`, `ratings`, `reviews`, `comments`), раздельных `/:id/{ratings,reviews,comments}`
нет. B8 от B9 не зависит, но F1 может захотеть вкладки. При реализации понадобится
`canViewProfile` (личные разделы) и `targetType` у комментариев — он уже отдаётся
в профиле, чтобы фронт отличал комментарий к фильму от ответа под рецензией.

### F1 — фронтенд

- Лайт-форма: один слайдер vibe.
- Полная форма: vibe предзаполнен из лайта.
- Показывать «только vibe» и «полная», не рисовать 0 как балл: в профиле и ленте фронт
  берёт `rating.combinedScore ?? rating.finalScore` и рисует `0`, хотя `completeness`
  рядом уже приходит (DECISION B2/5B — это F1, а не B2).
- Показать три счётчика на странице фильма (`votesCount` / `vibesCount` / `fullCount`).
- Пустой топ: `films: []`, `total: 0`, `fallback.available` — рисовать сообщение и, если
  есть чем заполнить, кнопку перехода на vibe-топ.
- Форма комментария: доступность по `userRating` из `GET /films/:id`, ловить `403
  RATING_REQUIRED_FOR_COMMENT` и показывать CTA «Оцените фильм». Отправлять оценку и
  комментарий **последовательно** — параллельная отправка даёт ложный 403 (DECISION B3/5A).
- Форма рецензии: `ratingId` больше не отправлять (сервер его игнорирует), галочка
  «спойлер» → `isSpoiler`, ловить `403 FULL_RATING_REQUIRED_FOR_REVIEW` и показывать CTA
  «Оцените фильм полностью». На публичной странице спойлер скрывать плашкой «Показать» —
  скрытие делает **только** фронт, бэк отдаёт текст целиком (DECISION B4/4, B4/5).
- Дневник (B5): кнопка «отметить просмотр» (дата в прошлом разрешена, «пересмотр», теги),
  страница «мой дневник» (`GET /api/watches/me`), блок в профиле
  (`GET /api/watches/user/:id`), тумблер приватности (`PATCH /api/watches/settings`),
  плашка «дневник закрыт» на `403 DIARY_PRIVATE`, «N просмотров» из `watchesCount`.
  При создании оценки/рецензии — опционально отправлять `watchId`, если человек пришёл
  из записи дневника.
- Приватность (B-PRIVACY): тумблеры `hideProfile`/`hideFromFeed` через
  `GET/PUT /api/users/me/privacy`; профиль рисует заглушку при `user.isHidden` (ник +
  аватар + «профиль скрыт»); на `404 PROFILE_HIDDEN` у достижений/дневника и
  `403 DIARY_PRIVATE` — свои состояния, а не пустой экран.
- Событие `vibe` в `ActivityFeed` сейчас падает в fallback-текст («сделал что-то»);
  нужен нормальный текст/иконка.
- README фронтенда/CHANGELOG обновить.

### Прочее

- «Слетели стили табов сортировки» — отдельный баг фронта, ещё не разбирали.
- Админский апгрейд сейчас даёт +8 (как в спецификации P1), а новая full — +20.
  Если для админов нужно +16 — это отдельное решение.
- Нет удаления оценок/рецензий; награды не откатываются.

---

## 11. Соглашения и правила работы

- Код — CommonJS (`require`), без TypeScript.
- Ошибки — через `AppError`/`ValidationError`/`NotFoundError` и т.п., формат
  `{ error: { code, message, details? } }`.
- Комментарии объясняют «почему», особенно анти-накрутку, гонки и cookie.
- Продуктовые решения фиксируются `// DECISION: <вариант>, потому что <...>`.
- Документация: README/CHANGELOG на русском; версия в шапке.
- Тесты — до/вместе с кодом; новые поведения покрывать.
- Не менять формулы `technicalScore`/`combinedScore` без отдельного решения.
- Не трогать `weight`, `trustWeight`, `flag-sybil-accounts.js` без причины.
- Секреты — только в `.env` (в git не попадают; pre-commit проверяет).
- Ветки: `feature/...`; main не пушить напрямую без просьбы.

---

## 12. Карта файлов P1, B2, B3, B4, B5, B-PRIVACY, B6, B7, B8

| Файл | Что важно |
|---|---|
| `src/models/Rating.js` | `completeness`, `vibeCreatedAt`, `min: 0`, pre-validate full |
| `src/models/Review.js` | `isSpoiler` (default false), `text` 350..15000, `ratingId` ставит сервер |
| `src/models/Comment.js` | B8: `targetType`/`targetId`, `filmId` legacy (всегда заполнен), pre-validate, два индекса |
| `src/models/Film.js` | `likesCount` — публичный агрегат сердечек (weight > 0), `min: 0` |
| `src/models/Watch.js` | B5: дневник; много записей на user+film, `tags`, `ratingId`/`reviewId`, три индекса |
| `src/models/WatchlistItem.js` | B6: «хочу посмотреть»; одна запись на user+film (`unique`), три индекса |
| `src/models/FilmLike.js` | B7: сердечко; одна запись на user+film (`unique`), `weight` — снимок trustWeight |
| `src/models/User.js` | `counters.vibes`, `counters.watches`, `counters.watchlist`, `counters.filmLikes`, `privacy`, `diaryPrivate`, `vibeWindow` |
| `src/models/Event.js` | `userId` автора (B-PRIVACY) + `{userId, createdAt}`; тип `watch` НЕ добавлялся (B5/5) |
| `src/models/PrivacyChangeLog.js` | лог флагов, TTL 180 дней |
| `src/routes/ratings.routes.js` | лайт/full, кап, апгрейд, начисления; необязательный `watchId` (B5/2) |
| `src/utils/filmAggregates.js` | B2: одна цепочка стадий на страницу, каталог и топ; `weight: { $ne: 0 }`, оси, три счётчика, `null` в списках |
| `src/utils/ratingGate.js` | B3/B4: `hasRatingForFilm()`, `findRatingForFilm()`, middleware `requireRatingForFilm({ completeness, code, message, attachAs })` |
| `src/utils/watchLink.js` | B5: `findOwnWatch()`, `setWatchLink()` — привязка по явному `watchId` |
| `src/utils/privacy.js` | B-PRIVACY: `canViewProfile()` (ветка «друзья» — TODO B-SOCIAL), `privacyOf()`, `hiddenProfileStub()` |
| `src/utils/diaryQuery.js` | общая выдача дневника для `/watches/me`, `/watches/user/:id`, `/users/:id/watches` |
| `src/utils/watchlistQuery.js` | B6: общая выдача watchlist (`/watchlist/user`, `/users/:id/watchlist`) |
| `src/utils/filmLikesQuery.js` | B7: общая выдача «Понравившихся» (`/users/me/likes`, `/users/:id/likes`); `weight` наружу не отдаётся |
| `src/utils/paging.js` | общая пагинация списков (дневник, watchlist) |
| `src/routes/films.routes.js` | B2: `/films`, `/films/top`, `/:id` (0 как маркер, `averageRating`, `watchesCount`); B7: `POST`/`DELETE /:id/like`, `liked` и `likesCount` в карточке |
| `src/routes/watches.routes.js` | B5: создание/удаление/списки, `DIARY_PRIVATE`, `/:filmId/count`, гейт скрытого профиля |
| `src/routes/watchlist.routes.js` | B6: идемпотентные `POST`/`DELETE`, `check`, свой список; `watchlistLimiter` |
| `src/routes/reviews.routes.js` | B4: гейт по full, `ratingId` серверный, `isSpoiler`; необязательный `watchId` |
| `src/routes/events.routes.js` | B-PRIVACY: фильтр `hideFromFeed` по `userId` |
| `src/routes/top.routes.js` | B-PRIVACY: скрытые профили исключены |
| `src/routes/admin.routes.js` | B4/5: спойлер в очереди не скрывается; B8: `targetType` в очереди, событие approve только для film |
| `src/routes/comments.routes.js` | B8: нормализация цели, гейт B3 только для film, `GET /api/comments` с пагинацией, старый `/:filmId` только film, проверки `parentId` |
| `src/routes/users.routes.js` | профиль (заглушка/полный), `/me/privacy`, `/nickname`, достижения 404, `/users/:id/watches` и `/watchlist`, B7: `/me/likes` и `/:id/likes`, B8: `targetType` у комментариев профиля |
| `src/utils/achievements.js` | `effective`, пороги, `FIRST_VIBE`, `FIRST_FRAME` |
| `src/utils/counterMaintenance.js` | `ratings` = full, `vibes` = vibe, `watches` = Watch, `watchlist` = WatchlistItem, `filmLikes` = FilmLike |
| `src/utils/counters.js` | поля `vibes`, `watches`, `filmLikes` в допустимых счётчиках |
| `src/utils/helpers.js` | `createEvent(type, { userId, ... })` — без `userId` событие не пишется |
| `scripts/migrate-p1-vibe-ratings.js` | миграция P1 (выполнена) |
| `scripts/migrate-b5-watches.js` | миграция B5: `counters.watches` по факту + `diaryPrivate` |
| `scripts/add-privacy-fields.js` | B-PRIVACY: `privacy` всем пользователям |
| `scripts/add-event-userid.js` | B-PRIVACY: `Event.userId` по нику; >1 несматченных — стоп |
| `scripts/add-watchlist-counters.js` | B6: `counters.watchlist` по факту |
| `scripts/add-film-likes-fields.js` | B7: `Film.likesCount` + `counters.filmLikes` |
| `scripts/reconcile-film-likes.js` | B7: сверка `Film.likesCount` с `FilmLike` (weight > 0) |
| `scripts/flag-sybil-accounts.js` | помечает фермы: `trustWeight`, `Rating.weight`, `FilmLike.weight` + пересчёт `likesCount` |
| `scripts/migrate-comment-target.js` | B8: `targetType: 'film'` + `targetId = filmId` у старых комментариев |
| `tests/vibe-rating.test.js` | 14 тестов B1 |
| `tests/film-aggregates.test.js` | 14 тестов B2 (in-memory MongoDB) |
| `tests/comment-gating.test.js` | 15 тестов B3 (in-memory MongoDB) |
| `tests/review-gating.test.js` | 15 тестов B4 (in-memory MongoDB) |
| `tests/watch-diary.test.js` | 23 теста B5 (in-memory MongoDB) |
| `tests/privacy.test.js` | 25 тестов B-PRIVACY (in-memory MongoDB) |
| `tests/watchlist.test.js` | 17 тестов B6 (in-memory MongoDB) |
| `tests/film-likes.test.js` | 19 тестов B7 (in-memory MongoDB) |
| `tests/comment-targets.test.js` | 23 теста B8 (in-memory MongoDB) |
| `tests/counters.test.js` | `vibes`/`watches`/`watchlist`/`filmLikes` в ожиданиях; мокает `Rating.exists` (B3) |
| `tests/poster.test.js` | заглушка `Watch.countDocuments`: файл работает без Mongo |
| `README.md`, `CHANGELOG.md` | документация 5.8 |

---

## 13. Быстрый чек-лист перед изменениями

1. `git status` — не в чужой ли ветке; ожидаем `feature/p1-vibe-ratings`.
2. `npm run test:vibe` (14/14), `npm run test:aggregates` (14/14),
   `npm run test:gating` (15/15), `npm run test:reviews` (15/15),
   `npm run test:watches` (23/23), `npm run test:privacy` (25/25),
   `npm run test:watchlist` (17/17), `npm run test:likes` (19/19) и
   `npm run test:targets` (23/23) — внешняя Mongo не нужна.
3. Если есть Mongo — `npm test` — 277/277; если нет — см. §8.
4. Прочитать `// DECISION` в `Rating.js`, `ratings.routes.js`, `filmAggregates.js`,
   `films.routes.js`, `ratingGate.js`, `comments.routes.js`, `Comment.js`,
   `reviews.routes.js`, `admin.routes.js`, `Watch.js`, `watches.routes.js`,
   `WatchlistItem.js`, `watchlist.routes.js`, `FilmLike.js`, `privacy.js`
   и `users.routes.js`, чтобы не отменить закрытые решения.
5. Помнить: миграции P1 и B5 уже прошли, B-PRIVACY-, B6-, B7- и B8-миграции выполняются
   при деплое; B2–B8 и B-PRIVACY закрыты; фронт ещё не знает про vibe/full;
   `0` на странице фильма и `null` в списках — это намеренная разница (6.1), не баг;
   комментарий к фильму без оценки даёт 403 до валидации тела — это намеренно,
   а комментарий к рецензии гейтингом НЕ облагается (B8);
   минимум рецензии 350 — решение заказчика, а не забытый порог;
   `watchesCount` считает и `weight: 0` — тоже намеренно (B5/6);
   событие создаётся только через `createEvent` с `userId`, иначе его не скрыть (B-PRIVACY);
   `counters.watchlist` и `counters.filmLikes` — реальные счётчики, а не `unsupportedCounters`
   (иначе reconcile обнулит: он делает `$set: { counters }` целиком);
   `Film.likesCount` ≠ `User.counters.filmLikes` (публичный агрегат vs личные действия);
   старый `GET /api/comments/:filmId` обязан фильтровать `targetType: 'film'` (B8).
