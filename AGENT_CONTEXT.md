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
- Документация версии: backend `README.md` / `CHANGELOG.md` (сейчас 5.3).

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
7. **170 тестов, все зелёные** (см. §8).

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
  `counters`, `achievements`, `consent`, `registeredIp`, `trustWeight`, `flagged`,
  `vibeWindow` (служебное, `select: false`).
- `counters`: `ratings`, `vibes`, `reviews`, `reviewsApproved`, `comments`,
  `commentsApproved`, `filmLikes`, `watchlist`, `followers`, `following`, `likesReceived`.
- `counters.ratings` — **только полные** оценки; `counters.vibes` — **только текущие**
  vibe-оценки (при апгрейде уменьшается).

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
- `Review`: `text` 350..15000, `ratingId` — своя оценка **того же** фильма.
- `Comment`: `text` <=1000, `parentId` — один уровень ответов.
- `Event`: типы `rating`, `vibe`, `review`, `comment`, `film_add`, `achievement`.
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

- Всего **170**: 112 в старых файлах + 14 в `tests/vibe-rating.test.js` (B1)
  + 14 в `tests/film-aggregates.test.js` (B2) + 15 в `tests/comment-gating.test.js` (B3)
  + 15 в `tests/review-gating.test.js` (B4).
- Эти четыре файла используют `mongodb-memory-server` — внешняя Mongo не нужна:

  ```bash
  npm run test:vibe          # 14/14
  npm run test:aggregates    # 14/14
  npm run test:gating        # 15/15
  npm run test:reviews       # 15/15
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

### B5 — дневник (следующая задача)

Не реализовано. Смысл: оценка (любая) автоматически означает «просмотрено» и добавляет
фильм в лист пользователя. **Важно:** в коде этого нет вообще — существует только
числовой счётчик `counters.watchlist` и `User.watchlist`, никакой привязки watch к `Rating`.
То есть B5 начинается с нуля: нужна новая сущность (дневник/лист), геймификация и
развилки про автопривязку. В B4 это сознательно не трогали (DECISION B5/out-of-scope).

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

## 12. Карта файлов P1, B2, B3, B4

| Файл | Что важно |
|---|---|
| `src/models/Rating.js` | `completeness`, `vibeCreatedAt`, `min: 0`, pre-validate full |
| `src/models/Review.js` | `isSpoiler` (default false), `text` 350..15000, `ratingId` ставит сервер |
| `src/models/User.js` | `counters.vibes`, `vibeWindow` |
| `src/models/Event.js` | тип `vibe` |
| `src/routes/ratings.routes.js` | лайт/full, кап, апгрейд, начисления |
| `src/utils/filmAggregates.js` | B2: одна цепочка стадий на страницу, каталог и топ; `weight: { $ne: 0 }`, оси, три счётчика, `null` в списках |
| `src/utils/ratingGate.js` | B3/B4: `hasRatingForFilm()`, `findRatingForFilm()`, middleware `requireRatingForFilm({ completeness, code, message, attachAs })` |
| `src/routes/films.routes.js` | B2: `/films` (все фильмы, `sort=new`), `/films/top` (участники оси + `total`/`fallback`), `/:id` (0 как маркер, алиас `averageRating`) |
| `src/routes/reviews.routes.js` | B4: гейт по full, `ratingId` серверный, `isSpoiler` |
| `src/routes/admin.routes.js` | B4/5: в очереди рецензий спойлер не скрывается |
| `src/routes/users.routes.js` | `completeness` в профиле, `isSpoiler` в рецензиях профиля; профиль/лента — вне B2 (5B) |
| `src/utils/achievements.js` | `effective`, пороги, `FIRST_VIBE`, `FIRST_FRAME` |
| `src/utils/counterMaintenance.js` | `counters.ratings` = full, `counters.vibes` = vibe |
| `src/utils/counters.js` | поле `vibes` в допустимых счётчиках |
| `src/utils/helpers.js` | передача `counters` в достижения |
| `scripts/migrate-p1-vibe-ratings.js` | миграция (выполнена) |
| `tests/vibe-rating.test.js` | 14 тестов B1 |
| `tests/film-aggregates.test.js` | 14 тестов B2 (in-memory MongoDB) |
| `tests/comment-gating.test.js` | 15 тестов B3 (in-memory MongoDB) |
| `tests/review-gating.test.js` | 15 тестов B4 (in-memory MongoDB) |
| `tests/counters.test.js` | обновлён под `vibes`; мокает `Rating.exists` из-за B3 |
| `README.md`, `CHANGELOG.md` | документация 5.3 |

---

## 13. Быстрый чек-лист перед изменениями

1. `git status` — не в чужой ли ветке; ожидаем `feature/p1-vibe-ratings`.
2. `npm run test:vibe` (14/14), `npm run test:aggregates` (14/14),
   `npm run test:gating` (15/15) и `npm run test:reviews` (15/15) — внешняя Mongo не нужна.
3. Если есть Mongo — `npm test` — 170/170; если нет — см. §8.
4. Прочитать `// DECISION` в `Rating.js`, `ratings.routes.js`, `filmAggregates.js`,
   `films.routes.js`, `ratingGate.js`, `comments.routes.js`, `reviews.routes.js`
   и `admin.routes.js`, чтобы не отменить закрытые решения.
5. Помнить: миграция уже на проде; B2, B3 и B4 закрыты; фронт ещё не знает про vibe/full;
   `0` на странице фильма и `null` в списках — это намеренная разница (6.1), не баг;
   комментарий без оценки даёт 403 до валидации тела — это тоже намеренно;
   минимум рецензии 350 — решение заказчика, а не забытый порог.
