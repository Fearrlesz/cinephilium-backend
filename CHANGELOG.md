# Changelog — Cinephilium 5.1

**Дата и время среза: 29.10.2026 (Europe/Moscow, UTC+03:00)**

## 5.1 — B2: агрегаты фильма по двум осям

**Дата: 29.10.2026.**

### Смысл

Vibe и полная оценка — две разные оси, и агрегаты этого больше не путают. Средний
вайб считается по всем оценкам: vibe есть у обоих типов. Технический и комбинированный
— только по `completeness: 'full'`: у vibe-оценки там `0`, это маркер «не вычислено»
(DECISION 2A), а не результат. Раньше `$avg` складывал маркер с баллами, и фильм с
тремя полными по 75 и одной vibe показывал средний технический 56.

Ноль остаётся маркером и не превращается в `null`: если полных оценок нет, средний
технический и комбинированный равны `0`, и фронт показывает «пока никто не разобрал
подробно». В списках и топах, наоборот, отсутствующее число отдаётся `null` — там
старый фронт рисует `null` как «—», а `0` нарисовал бы красное «0.0», что читается
как «плохо», а не «не оценено».

### Что изменилось

| Эндпоинт | Изменения |
|---|---|
| `GET /api/films/:id` | `averageVibe` — по всем оценкам; `averageTechnical` и `averageCombined` — только по полным; полных нет → `0`. Новые `vibesCount` (только vibe) и `fullCount`; `votesCount` = все. `averageRating` — алиас `averageTechnical`. |
| `GET /api/films` | те же три средних и счётчики; отсутствующее среднее — `null`; каталог по-прежнему показывает **все** фильмы, неоценённые идут в конце; `sort=new` — по дате добавления. |
| `GET /api/films/top` | в топе только участники оси: по техническому/комбинированному — фильмы с полной оценкой, по вайбу — с любой. Новые `total` (считает участников, а не всю базу) и `fallback` для пустого топа. |
| `GET /api/films/:id/ratings`, `/:id/users` | без изменений: `completeness` отдаётся с B1. |

`weight: { $ne: 0 }` остаётся: оценки с нулевым весом не входят ни в одно среднее,
ни в один счётчик и ни в один топ.

### Округление

Все три средних округляются до десятых одной функцией `roundTenth` — одинаково на
странице фильма, в каталоге и в топе. Раньше каталог и топ отдавали сырое `$avg`.

### Зафиксированные решения

- **B2/1A** — `averageRating` остаётся алиасом `averageTechnical` (им он и был).
  Удаление — вместе с F1, когда новый фронт перестанет его читать.
- **B2/2B** — `sort=new` в `/films` как точка входа для свежих импортов. Nice-to-have:
  решение 6A делает такие фильмы видимыми и без него, поэтому снять `sort=new` можно
  без дыры в контракте.
- **B2/3C** — пустой топ отдаётся пустым (`films: []`, `total: 0`) плюс
  `fallback: { sort: 'vibe', available }`; молчаливой подмены на vibe-топ нет.
- **B2/4A** — `votesCount` = все оценки (vibe + full); разделение — `vibesCount` и
  `fullCount`.
- **B2/5B** — профиль и лента вне B2: бэкенд уже отдаёт `completeness`, «ноль как балл»
  — дефект отрисовки, задача F1. `0` на `null` там не меняем: это отменило бы 2A.
- **B2/6A** — каталог показывает все фильмы, фильтр «есть число по оси» действует только
  в топах; `total` честен относительно фильтра своего эндпоинта.
- **B2/6.1** — отличие намеренное: страница фильма отдаёт `0`, списки и топы — `null`.

### Код и тесты

- `src/utils/filmAggregates.js` — одна цепочка стадий на все три эндпоинта, чтобы
  средние не разъезжались между страницей, каталогом и топом.
- `tests/film-aggregates.test.js` — 14 тестов: смешанный набор, только vibe, только
  full, пусто, `weight: 0`, участники топа по каждой оси, `total` по фильтру,
  округление, алиас `averageRating`, `sort=new`, пустой топ с подсказкой.
  Запуск: `npm run test:aggregates`.
- `tests/poster.test.js` — 4 теста переведены со стаба `Film.findById` на
  `Film.aggregate`: страница фильма теперь читает документ и средние одним запросом.
- Итого **140 тестов**, все зелёные.

### Миграция

Не нужна: после P1 (29.10.2026) данные в правильной форме, агрегаты считаются на лету.

## 5.0 — P1: двухступенчатая оценка (vibe → full)

**Дата: 29.10.2026.**

### Модель

- `Rating.completeness`: `'vibe' | 'full'`, по умолчанию `'full'` для обратной совместимости.
- `Rating.scores` больше не `required` на уровне схемы: полноту по-прежнему проверяет
  роут, а pre-validate не даёт сохранить full без 15 критериев.
- `technicalScore` и `combinedScore`: `min: 0`; `0` — маркер «не вычислено»
  (`// DECISION: 2A`).
- `Rating.vibeCreatedAt` + индекс `{userId, vibeCreatedAt}` для дневного капа.
- `User.counters.vibes`; служебное `User.vibeWindow` (не отдаётся наружу).
- `Event.type` расширен значением `'vibe'`.

### API

- `POST /api/ratings` принимает два вида payload:
  - `{ filmId, vibe }` — vibe-оценка (`technicalScore = 0`, `combinedScore = 0`,
    `scores` отсутствует);
  - полный payload, как раньше; старый фронт работает без изменений.
- Апгрейд vibe → full — та же запись (`_id`, `createdAt`, уникальность `(userId, filmId)`);
  `completeness` меняется на `'full'`.
- `// DECISION: 1A` — даунгрейда нет: vibe-запрос к full-оценке → `400 ALREADY_FULL_RATING`.
- `// DECISION: 3A` — `vibe` можно изменить при апгрейде; если поле не пришло,
  берётся вайб из существующей записи.
- `weight` при апгрейде сохраняется из существующей записи (включая `0`),
  `ip` обновляется, `createdAt` не меняется.
- Дневной кап: 50 новых vibe за скользящие 24 часа, проверяется атомарной
  pipeline-операцией по `User.vibeWindow` до создания; 51-й → `429 VIBE_LIMIT_REACHED`
  с `details: { limit, window: '24h', retryAt }`. Апгрейд капом не ограничен.
- `completeness` отдаётся везде, где API возвращает рейтинг: создание/обновление,
  `userRating`, `/ratings/user`, `/films/:id/ratings`, `/films/:id/users`,
  `/ratings/:id/details`, профиль пользователя.

### Геймификация

- Vibe: **+2** балла, `counters.vibes +1`, событие `type: 'vibe'`
  (`score: null`, `metadata: { vibe, completeness: 'vibe' }`), достижения не пересчитываются.
- Full: **+8** при апгрейде (суммарно 10), `counters.ratings +1`, `counters.vibes −1`,
  событие `'rating'`, `updateAchievements`. Новая полная оценка — как раньше: +10 (+20 админу).
- Прогресс достижений: `effective = counters.ratings + counters.vibes / 5`;
  пороги 20 / 50 / 100 / 200 (константы `RATING_20`, `RATING_50`, `RATING_100`, `RATING_200`).
- Новая ачивка `FIRST_VIBE` («Первое впечатление»); `FIRST_RATING` — только за первую
  полную; `FIRST_FRAME` — первые 100 зарегистрированных **и** хотя бы одна полная.
- Существующие достижения не отбираются: `updateAchievements` только добавляет новые.

### Миграция

- `scripts/migrate-p1-vibe-ratings.js`: `Rating` без `completeness` → `'full'`,
  `User` без `counters.vibes` → `0`. Идемпотентно, есть `--dry-run`.
- Запускать до деплоя; порядок и ожидаемый вывод — в README, §11.

### Тесты

- Добавлен `tests/vibe-rating.test.js` (14 тестов) на `mongodb-memory-server`:
  лайт, full, повторный лайт, апгрейд с сохранением `weight`/обновлением `ip`,
  запрет даунгрейда, строгий лайт, кап 50/24ч (включая границу 49/50 и скользящее окно),
  достижения, выдача `completeness`, повторная full без двойных баллов, миграция.
- Всего 126 тестов; старый набор (112) проходит на in-memory MongoDB.

## 4.3 — рецензии, свои черновики и вес голосов

**Дата: 28.10.2026.**

- Минимальная длина рецензии снижена с 450 до 350 символов — в модели `Review`,
  валидаторе `POST /api/reviews` и тестах.
- `POST /api/reviews` проверяет, что `ratingId` принадлежит тому же фильму: раньше
  можно было приложить оценку другого фильма.
- Автор видит свой `pending` в `GET /api/reviews/:filmId` и `GET /api/comments/:filmId`;
  чужие черновики по-прежнему скрыты.
- `GET /api/films/:id/ratings` и `GET /api/films/:id/users` не показывают оценки
  с `weight: 0`, как и агрегаты.
- Подключён `compression`: JSON-ответы API уходят gzip, картинки не пережимаются.
- Тесты: +5 регрессий (граница 350 символов, чужой `ratingId`, видимость своих
  черновиков рецензии и комментария, `weight: 0` в списках), всего 112.

## 4.2 — постеры в результатах поиска

**Дата: 27.10.2026.** После перевода всех картинок на прокси заглушки остались только
в результатах поиска по TMDB. Причина: фронтенд для сетки поиска просит
`/api/tmdb-image?size=w200`, а в белом списке размеров прокси был `w185`, `w300`, но не
`w200`. Прокси отвечал `400 {"error":"Invalid size"}`, `<img onError>` подменял картинку
заглушкой. Остальные страницы используют `w500` и работали.

- `api/tmdb-image.js`: `w200` добавлен в `ALLOWED_SIZES` (CDN TMDB отдаёт этот размер,
  проверено: `200 image/jpeg`).
- `tests/poster.test.js`: два регрессионных теста — прямой `w200` и алиас
  `/api/poster/w200/...`.
- Проверено на проде: `w200` отдавал `400`, `w500` — `200`; после фикса оба размера
  отдают `200 image/jpeg`.

---

## 4.1 — постеры перестают быть заглушками

**Дата: 26.10.2026.** Симптом: у пользователей из России вместо постеров заглушка, хотя
прокси на бэкенде «настроен». Разбор показал три независимые причины — каждой хватило бы
для пустых карточек.

### Что было не так

| Причина | Как проявлялась |
|---|---|
| В проде `IMAGE_PROXY_BASE_URL=https://cinephilium-frontendnew.vercel.app` (домен фронтенда) | `posterUrl` вёл на `/api/tmdb-image` **Vercel**, где такого маршрута нет: SPA отвечает `200 text/html`, браузер не получает картинку |
| Легаси-поле `poster` хранило прямой `https://image.tmdb.org/...` | Старый клиент (и любой потребитель API) рендерил его напрямую; в РФ `image.tmdb.org` отдаёт обрыв соединения |
| Прокси постеров стоял **после** `globalLimiter` (200/мин), а ключом лимита был `req.ip` = IP edge-ноды Cloudflare | Один лимит на тысячи людей: 20–40 картинок на страницу выжигали квоту, и постеры получали `429` вместе с API. Проверка: `remaining` в заголовке `ratelimit` менялся от запроса к запросу при одном и том же клиенте |

### Что сделано

- `src/utils/poster.js`: база прокси нормализуется (хвостовой `/`, случайный `/api`); если
  `IMAGE_PROXY_BASE_URL` не задан — берётся origin входящего запроса (всегда бэкенд), а если
  в переменной оказался домен фронтенда и запрос пришёл с другого домена — тоже origin запроса.
  Легаси-`poster` с прямой ссылкой TMDB конвертируется в прокси-адрес, `posterPath`
  восстанавливается на лету.
- `src/config/env.js`: значение проверяется и нормализуется на старте, при совпадении с
  доменом фронтенда в логах появляется предупреждение.
- `src/middleware/security.js`: `clientIp()` для всех лимитов — `cf-connecting-ip` →
  `x-real-ip` → `req.ip`; добавлен отдельный `imageLimiter` (1200/мин).
- `src/app.js`: прокси постеров (`/api/tmdb-image`, `/api/poster/:size/*`) монтируется
  **до** `globalLimiter` и общий лимит не выжигает.
- `api/tmdb-image.js`: LRU-кэш байтов в памяти инстанса (48 МБ), склейка одновременных
  запросов одной картинки, `ETag` + `If-None-Match` → `304`, `Content-Length`.
  Повторный постер отдаётся за миллисекунды и не идёт в TMDB.
- `tests/poster.test.js`: 15 тестов — нормализация базы, конвертация легаси-постера,
  origin из запроса, домен фронтенда в переменной, кэш/`304`, 210 запросов к прокси без `429`.
- Логи: `GET /` теперь отвечает `200` (Render и мониторинги дёргают корень, раньше каждый
  health-check писал 404 со стеком), а ожидаемые `4xx` (истёкший токен, битый id, лимит)
  пишутся компактным `[WARN]` без стека. `5xx` по-прежнему `[ERROR]` со стеком.

### Проверено

- `image.tmdb.org` из РФ (ноды check-host ru1–ru3, kz1): `Connection refused`;
  тот же постер через `https://<бэкенд>/api/tmdb-image` — `200 image/jpeg` из ru1–ru3.
- Локально: `200 image/jpeg`, повторный запрос `304`, `ratelimit: limit=1200`.
- Лимит по-прежнему режет злоупотребления: 201-й запрос с одного `cf-connecting-ip`
  к API получает `429`, соседний IP — `200`.

### Что сделать на проде

1. В Render **удалить** `IMAGE_PROXY_BASE_URL` (или поставить `https://cinephilium-backend.onrender.com`).
2. Задеплоить бэкенд, затем фронтенд (ссылки на постеры приходят из API).
3. Проверить: `curl -I "https://<бэкенд>/api/tmdb-image?size=w500&path=%2F<файл>.jpg"` → `200 image/jpeg`.
4. `node scripts/migrate-posters.js` не обязателен: `posterPath` теперь чинится на чтении,
   но прогнать его всё равно полезно, чтобы база была в порядке.

---

## 3.5 — вход без почты

Причина: SMTP требует денег и подтверждённого домена, а «подтверждение почтой» всё равно
не мешало заводить аккаунты на выдуманные адреса. Почта убрана из аутентификации целиком.

### Что удалено

| Было | Стало |
|---|---|
| `POST /api/auth/verify-email`, `/resend-verification` | удалены — аккаунт активен сразу |
| `POST /api/auth/forgot-password` | удалён — ссылку сброса выдаёт админ |
| `src/services/mailer.js`, `nodemailer`, `scripts/send-test-email.js` | удалены |
| `scripts/backfill-email-verified.js` | удалён — подтверждать нечего |
| `User.emailVerified`, `User.emailVerification` | удалены |
| `requireVerified` в `/ratings`, `/reviews`, `/comments` | удалён |
| `SMTP_*`, `EMAIL_*` в `.env.example` | заменены на `REGISTRATION_MODE`, `INVITE_TTL_DAYS`, `PASSWORD_RESET_TTL_MIN` |

### Что появилось

- `POST /api/auth/register` принимает `nickname`, `password`, `inviteCode`, `consent` и сразу
  возвращает `accessToken` + refresh-cookie. Ответ `201`, никакого промежуточного экрана.
- `GET /api/auth/config` → `{ registrationMode, inviteRequired }`, чтобы фронт знал, нужен ли код.
- Модель `Invite`: `codeHash` (SHA-256), `codePrefix`, `note`, `usedBy`, `revokedAt`, `expiresAt`.
  Сам код показывается один раз при создании, в списке виден только префикс.
- Админские роуты: `GET/POST /api/admin/invites`, `DELETE /api/admin/invites/:id`,
  `GET /api/admin/users?query=`, `POST /api/admin/users/:id/reset-link`.
- `POST /api/auth/login` принимает `nickname`; почта осталась запасным логином для старых аккаунтов.
- Первый пользователь пустой базы создаётся без инвайта и сразу админом (бутстрап).
- `node scripts/new-invite.js [N] [--note …] [--days …]` — выдача кодов без админки.

### Защита секретов

- `.gitignore`: `.env` + `.env.*` с исключением `.env.example`; добавлены `.tooling/`, `.cache/`,
  `.npm-cache/`.
- `.githooks/pre-commit` → `scripts/check-secrets.js`: блокирует коммит, если в индексе есть
  env-файл или строка вида `mongodb+srv://user:pass@…`, приватный ключ, AWS/GitHub-токен.
  Включается один раз: `npm run hooks:install`.
- История обоих репозиториев проверена — `.env` в ней никогда не было.

### Постеры из России

`image.tmdb.org` в РФ недоступен, поэтому браузер не мог загрузить постеры, даже когда
прокси на бэкенде работал: большинство карточек брали `film.poster` напрямую. Теперь фронтенд
прогоняет любой вариант постера (прямая ссылка TMDB, «голый» путь, локальный адрес из
dev-конфига) через `getPosterUrl()` и грузит картинку только с бэкенда `/api/tmdb-image`.
Проверено на реальном постере: `HTTP 200, image/jpeg`; обход и чужие размеры по-прежнему
отклоняются.

### Связь с админами

- Публичная страница `/contact` на фронтенде: контакты админов в Telegram + форма заявки
  на доступ (ник, контакт, сообщение).
- `GET /api/contact/admins` отдаёт телеграмы из базы и запасные из `ADMIN_TELEGRAMS`.
- `POST /api/contact/request` кладёт заявку в `contactrequests`: без почты, с лимитом
  5 в час на IP и скрытым полем-ловушкой для ботов.
- Админка: очередь заявок с кнопками «Выдать инвайт» (код показывается один раз)
  и «Отклонить», плюс поле для телеграма в поиске пользователей.
- `User.telegram` + `POST /api/admin/users/:id/telegram` + `scripts/set-telegram.js`.

### Тесты

- `tests/auth-email.test.js` заменён на `tests/auth-invite.test.js` (12 тестов): выдача и отзыв
  кодов, отказ без инвайта, повторное использование, вход по никнейму, одноразовая ссылка сброса.
- `tests/regression.test.js` переписан под инвайты (28 тестов), `errorHandler` — под никнейм.
- Итого 97 тестов, все зелёные (добавлен `tests/contact.test.js` на 11 проверок).

---

# Changelog — Cinephilium 3.0

**Дата и время среза: 25.10.2026, 14:23 (Europe/Moscow, UTC+03:00)**

Репозитории:

- backend — `Fearrlesz/cinephilium-backend`, ветка `feat/integration-v3` → `main`
- frontend — `Fearrlesz/cinephilium-frontend`, ветка `feat/api-v3-compat` → `main`

Документ описывает **все** изменения, сделанные в этой итерации, с привязкой к реальному коду.
Формат: «было → стало → где именно».

---

## 0. С чего начинали

`main` бэкенда стоял на коммите `c346077` («Update comments.routes.js») и содержал
версию API без подтверждения email, без refresh-токенов, без единого обработчика ошибок
и без тестов. В ветках `codespace-*` лежал незамёрженный слой разработки (~3.5 тыс. строк):
он и стал основой интеграции.

Порядок работ:

1. Ветка `feat/integration-v3` создана от `main`.
2. Влит `codespace-bookish-carnival` (авторизация, счётчики, ошибки, тесты).
3. Из `codespace-curly-acorn` перенесён **только** коммит `468bdcf` (прокси постеров);
   коммит `204bd12` намеренно не брался — он удалял security/CORS/зависимости.
4. Исправлены баги, найденные тестами (см. §2.10).
5. Добавлена совместимость с текущим фронтендом (§2.9).
6. Добавлены согласия и анти-накрутка (§2.7, §2.8).
7. Фронтенд переведён на новый контракт (§3).

---

## 1. Бэкенд

### 1.1 Единый обработчик ошибок

**Было:** ошибки разлетались как попало — 404 от Express в HTML, `CastError` из Mongo давал 500,
`ValidationError` тоже 500, тело ошибки в разных роутах имело разную форму (`{ error: '...' }`,
`{ message: '...' }`).

**Стало:** `src/middleware/errorHandler.js` + `src/utils/errors.js`.

- `AppError` и наследники (`ValidationError`, `UnauthorizedError`, `ForbiddenError`,
  `NotFoundError`, `ConflictError`) несут `statusCode` и машиночитаемый `code`.
- Ответ всегда: `{ "error": { "code", "message", "details?" } }`.
- `CastError` → 400, дубликат `11000` → 409, `JsonWebTokenError` → 401,
  `entity.parse.failed` (битый JSON) → 400 `INVALID_JSON`, `entity.too.large` → 413.
- 404 на неизвестный маршрут — JSON (`notFoundHandler`).

Ключевой фрагмент (`src/middleware/errorHandler.js`):

```js
} else if (err.type === 'entity.parse.failed') {
  statusCode = 400;
  code = 'INVALID_JSON';
  message = 'Некорректный JSON в теле запроса';
}
```

### 1.2 Аутентификация v3: access + refresh + сессии

**Было:** один JWT на 7 дней в `localStorage`, без отзыва, без обновления.

**Стало:**

- `utils/jwt.js` — два разных секрета и два типа токенов:
  `signAccessToken()` (`expiresIn: JWT_ACCESS_TTL`, по умолчанию 15m, `type: 'access'`) и
  `signRefreshToken()` (`JWT_REFRESH_TTL_DAYS`, по умолчанию 30 дней, `type: 'refresh'`, `jti`).
  Оба подписываются `HS256`, `verify*` проверяют `type` — access нельзя подсунуть вместо refresh.
- `models/Session.js` — серверная сессия: `tokenHash` (SHA-256 refresh-токена), `userAgent`, `ip`,
  `expiresAt` с TTL-индексом (`expireAfterSeconds: 0`).
- `routes/auth.routes.js` — `issueTokens()` создаёт сессию, кладёт refresh в HttpOnly cookie
  (`utils/cookies.js`) и возвращает только `accessToken`.
- `POST /api/auth/refresh` — ротация: старый хеш атомарно заменяется новым
  (`Session.updateOne({ _id, tokenHash: old }, { $set: { tokenHash: new } })`), при
  `modifiedCount !== 1` сессия считается отозванной → 401. Повторное использование старой
  cookie не проходит.
- `POST /api/auth/logout` — удаляет сессию и чистит cookie, `POST /api/auth/logout-all` — все сессии.
- Cookie: `httpOnly`, `path=/api/auth`, `SameSite=None` в проде (cross-site vercel → onrender),
  `Secure` при `NODE_ENV=production`. `COOKIE_DOMAIN` больше не хардкодится как `localhost`.

### 1.3 Подтверждение email и сброс пароля

**Было:** регистрация сразу выдавала токен.

**Стало:**

- `POST /api/auth/register` создаёт пользователя с `emailVerified: false` и отправляет
  6-значный код (`updateVerification()` → `mailer.sendVerificationCode`). В БД лежит только
  `hashToken(code)` (SHA-256), TTL `EMAIL_CODE_TTL_MIN` (10 минут), 5 попыток ввода,
  повторная отправка с cooldown `EMAIL_RESEND_COOLDOWN_SEC` (60 с) и лимитом
  `EMAIL_RESEND_MAX_PER_HOUR` (3 в час).
- `POST /api/auth/verify-email` сверяет хеш кода и выдаёт пару токенов.
- `POST /api/auth/resend-verification` — повторная отправка с теми же лимитами.
- `POST /api/auth/forgot-password` — генерирует 32-байтный токен, хранит только его SHA-256,
  TTL 30 минут, письмо со ссылкой `${CLIENT_URL}/reset-password?token=...`.
  Ответ всегда одинаковый (`Если email существует, письмо отправлено`) — нет user enumeration.
- `POST /api/auth/reset-password` — принимает `token` + `newPassword`, проверяет срок и
  одноразовость, меняет пароль и **удаляет все сессии** (`Session.deleteMany`).
- `middleware/auth.js`: `requireVerified` пускает к записи только `emailVerified: true`.

Письма отправляет `src/services/mailer.js` (nodemailer). Если SMTP не настроен:
в dev ссылка/код печатаются в консоль (`[DEV] password reset link ...`), в production
бросается `EMAIL_SEND_FAILED` и ошибка уходит в лог.

### 1.4 Модерация

Требования к правам переехали в middleware (`authenticate` + `isAdmin`). Исправлены две дыры:

- `GET /api/reviews/details/:id` отдавал рецензию на модерации любому, кто знал id
  (`src/routes/reviews.routes.js`). Теперь `status !== 'approved'` виден только автору и админу,
  остальным — 404.
- `GET /api/users/:id` отдавал чужие черновики рецензий и комментариев. Теперь
  `statusFilter = isOwnProfile || isAdmin ? {} : { status: 'approved' }`
  (`src/routes/users.routes.js`).

Повторное одобрение больше не фармит награды: в `src/routes/admin.routes.js` побочные эффекты
(очки, событие, достижения, счётчик) выполняются только при переходе статуса
`before.status !== 'approved'`.

### 1.5 Счётчики

**Было:** количество оценок/рецензий считалось `countDocuments` в каждом запросе, топ пользователей
делал три `$lookup` на каждый профиль.

**Стало:** денормализованные счётчики `User.counters` (`ratings`, `reviews`, `reviewsApproved`,
`comments`, `commentsApproved`, `likesReceived`, …), инкремент через `utils/counters.js`:

```js
const path = `counters.${field}`;
if (delta < 0) {
  return User.updateOne(
    { _id: userId, [path]: { $gte: Math.abs(delta) } },   // не уходим в минус
    { $inc: { [path]: delta } }
  );
}
```

Топ пользователей (`src/routes/top.routes.js`) больше не делает `$lookup` — читает `counters`.

### 1.6 Постеры

**Было:** в БД хранился полный URL `poster` на `image.tmdb.org`.

**Стало:** хранится `posterPath` (например `/abc.jpg`), URL собирается на чтении
(`src/utils/poster.js`):

```js
const base = process.env.IMAGE_PROXY_BASE_URL;
if (!base) return `https://image.tmdb.org/t/p/${size}${posterPath}`;
return `${base}/api/tmdb-image?size=${size}&path=${encodeURIComponent(posterPath)}`;
```

- `api/tmdb-image.js` — прокси с белым списком размеров, проверкой `path`
  (запрет `..`, `//`, не-ASCII), таймаутом 10 с и лимитом 5 МБ.
- Прокси смонтирован и в Express (`src/app.js`), и как Vercel-функция.
- Для старого фронта оставлено legacy-поле `poster` — оно заполняется тем же URL.
- `scripts/migrate-posters.js` переносит старые записи `poster` → `posterPath`.

### 1.7 Согласия при регистрации

**Требование:** данные не должны попадать в БД до согласия на обработку персональных данных и cookie.

**Реализация:**

- `src/models/User.js` — вложенная схема `consent` (`personalData`, `cookies`, `version`,
  `acceptedAt`, `ip`) и поле `registeredIp`.
- `src/routes/auth.routes.js` — проверка стоит **до** первого обращения к БД:

```js
const consent = req.body.consent;
if (!consent || consent.personalData !== true || consent.cookies !== true) {
  throw new ValidationError('Нужно согласие на обработку персональных данных и использование cookie');
}
const { email, password, nickname } = req.body;
const existingEmail = await User.findOne({ email });   // только после проверки
```

Тест `tests/regression.test.js` проверяет не только 400, но и что документ не создан
(`User.countDocuments(...) === 0`).

### 1.8 Анти-накрутка оценок

**Проблема:** ферма аккаунтов могла раздуть среднюю оценку. Воспроизведение до фикса: 10 аккаунтов
с одного IP → средняя 100, фильм №1 в топе.

Причины:

1. `authLimiter` имел `skipSuccessfulRequests: true` — успешные регистрации вообще не считались,
   лимит видел только ошибки.
2. На оценки не было лимита по IP.
3. Все голоса были равны, никакой «подозрительности» не существовало.

Что сделано:

- `middleware/security.js` — `registerLimiter` (10 регистраций/час на IP, считает и успешные)
  и `ratingLimiter` (40 оценок/час на IP).
- `models/User.js` — `trustWeight` (0..1, по умолчанию 1), `flagged`, `registeredIp`
  + индексы `{ registeredIp, registeredAt }` и `{ flagged }`.
- `models/Rating.js` — `weight` (0..1) и `ip`. Вес копируется из аккаунта при сохранении:

```js
weight: typeof req.user?.trustWeight === 'number' ? req.user.trustWeight : 1,
ip: req.ip || ''
```

- Агрегаты игнорируют помеченные голоса. В `src/routes/films.routes.js` `$lookup` переписан на
  пайплайн с фильтром:

```js
{
  $lookup: {
    from: 'ratings',
    let: { filmId: '$_id' },
    pipeline: [
      { $match: { $expr: { $eq: ['$filmId', '$$filmId'] }, weight: { $ne: 0 } } },
      { $project: { technicalScore: 1, vibe: 1, combinedScore: 1, weight: 1 } }
    ],
    as: 'ratings'
  }
}
```

То же для деталей фильма (`$match: { filmId, weight: { $ne: 0 } }`) и для топа пользователей
(`$match: { flagged: { $ne: true } }`).

- `scripts/flag-sybil-accounts.js` — детектор: группирует пользователей по `registeredIp` за окно
  времени, при `count >= 5` за час ставит `trustWeight = 0` и `Rating.weight = 0`.
  Есть `--dry-run` и `--unflag`.

Проверка в тестах: после пометки у фильма `votesCount: 0`, он исчезает из топа, ферма — из топа
пользователей.

### 1.9 Совместимость с текущим фронтендом

Фронт ожидал контракт, части которого в API не существовало. Добавлено без ломки старого:

| Что | Где |
|---|---|
| `GET /api/users/nickname/:nickname` — компактный lookup `{ _id, id, nickname, avatar }` | `src/routes/users.routes.js` |
| `GET /api/users/me/achievements` — `{ earned, possible, totalPoints, progress }` | там же |
| `counters` в ответе профиля | там же |
| legacy-поле `poster` = готовый URL | `src/utils/poster.js` |
| алиас `/api/poster/:size/*` для старой схемы ссылок | `src/app.js` |
| `SameSite=None` при `Secure` для cross-site cookie | `src/utils/cookies.js` |

### 1.10 Исправленные баги (найдены тестами)

1. Поиск по названию собирал `RegExp` из пользовательского ввода: `?title=[` → 500, а `(a+)+$` — ReDoS.
   Теперь `escapeRegex()`.
2. Сбой TMDB в импорте давал 500; теперь 404 «фильм не найден» и 502 «сервис недоступен».
3. `textReview` длиннее 2000 символов → 500 от валидатора Mongoose; теперь 400.
4. Ответ на комментарий можно было привязать к комментарию другого фильма; теперь сверяется `filmId`.
5. `limit` в `/api/films` не был ограничен; теперь максимум 100, `page` чинится от отрицательных.
6. `likesReceived` в топе считался и тут же удалялся `$project` — поля не было в ответе.
   Теперь оно живёт в `counters` и отдаётся.
7. CORS: `origin: 'строка'` не сверялся с запросом (заголовок отдавался всем). Теперь список
   `CORS_ORIGIN` через запятую.
8. `/api/tmdb-image` был только Vercel-функцией, в Express — 404. Смонтирован.
9. Кривой id в админ-роутах (`/admin/comments/not-an-id/approve`) → 500; теперь 400 благодаря
   `CastError` в обработчике.

---

## 2. Фронтенд

### 2.1 HTTP-клиент и обновление токена

`src/api/client.js` переписан:

- `baseURL` из `REACT_APP_API_URL`, `withCredentials: true` (нужно для refresh-cookie).
- access-токен в `accessToken` (+ дублируется в старый ключ `token`, чтобы не править 20 мест
  в компонентах).
- при 401 — single-flight refresh и один ретрай исходного запроса; если refresh не удался,
  сессия чистится и пользователь уходит на `/login`.
- ошибки нормализуются: `{ error: { message } }` превращается в строку, поэтому старые
  `err.response?.data?.error` продолжают показывать текст, а не `[object Object]`.
- `logout()` отзывает сессию на сервере, а не только чистит `localStorage`.

### 2.2 Вход и регистрация

`src/pages/LoginPage.jsx`: три состояния — `login`, `register`, `verify`.

- логин сохраняет `accessToken`;
- регистрация больше не ждёт токен: показывается экран ввода 6-значного кода из письма,
  с кнопкой «Отправить код ещё раз»;
- пароль — минимум 8 символов (как на сервере).

### 2.3 Сброс пароля

- `src/pages/ForgotPasswordPage.jsx` (`/forgot-password`) — email → `POST /api/auth/forgot-password`,
  нейтральное сообщение об отправке.
- `src/pages/ResetPasswordPage.jsx` (`/reset-password?token=…`) — новый пароль + подтверждение,
  проверка длины и совпадения, обработка битой ссылки.
- Ссылка «Забыли пароль?» на странице входа.

### 2.4 Согласия и политика

- В форме регистрации два обязательных чекбокса (персональные данные, cookie) — без них кнопка
  не отправляет запрос; согласия уходят в API (`consent: { personalData, cookies, version }`).
- `src/pages/PrivacyPage.jsx` (`/privacy`) — описание обрабатываемых данных и cookie
  (шаблон, требует юридической вычитки).

### 2.5 Остальное

- `TopUsersPage` — формат `{ items, pagination }` и статистика из `counters`.
- `useActivityEvents` — лента только читается; фронт больше не дублирует события через
  несуществующий `POST /events`.
- `ProfilePage` — достижения из `earned`, выход через серверный `logout`.
- `poster`/`posterUrl` — работают оба, потому что бэкенд заполняет legacy-поле.

---

## 3. Тесты и проверки

Бэкенд, 80 тестов на реальной MongoDB 7.0.14 (`npm test`):

| Файл | Тестов | Что покрывает |
|---|---|---|
| `tests/auth-email.test.js` | 10 | регистрация, коды, сброс пароля |
| `tests/auth-refresh.test.js` | 13 | сессии, ротация, logout, CORS preflight |
| `tests/counters.test.js` | 15 | счётчики, модерация, топ без $lookup |
| `tests/errorHandler.test.js` | 7 | коды ошибок, 404, 409 |
| `tests/poster.test.js` | 9 | buildPosterUrl, миграция, прокси |
| `tests/regression.test.js` | 26 | все фиксы + сквозной сценарий + согласия + анти-накрутка |

У каждого файла своя база (`cinephilium-test-*`), поэтому `npm test` можно запускать параллельно.

Фронтенд: `npm run build` → `Compiled successfully` (CRA 5, React 18).

---

## 4. Миграции

Код переживает отсутствие новых полей (проверки через `$ne`/`$exists`), но для корректных отчётов
и работы детектора данные надо привести к новой форме. Порядок — в README, раздел «Миграции».
Коротко:

1. `node scripts/backfill-email-verified.js` — иначе **старые пользователи не смогут войти**
   (логин требует `emailVerified: true`, а у старых записей этого поля нет).
2. `node scripts/migrate-counters.js` — заполнить `counters`, иначе достижения и топ покажут нули.
3. `node scripts/migrate-posters.js` — перенести `poster` → `posterPath`.
4. `node scripts/backfill-anti-farm.js` — `weight`, `ip`, `trustWeight`, `flagged`, `registeredIp`,
   `consent` + индексы.
5. `node scripts/reconcile-counters.js` — сверка счётчиков с фактическими документами.

Все скрипты идемпотентны, у новых есть `--dry-run`.

---

## 5. Известные ограничения

- Распределённая ферма (много IP, одноразовые почты) детектором по IP не ловится — нужны CAPTCHA
  и репутация домена.
- Баллы помеченных аккаунтов не обнуляются (они просто исчезают из рейтинга).
- Нет удаления оценок/рецензий, поэтому награды не откатываются.
- `updateAchievements` тихо логирует ошибку, если соединение с Mongo ещё не готово.
- `useCriticData` на фронте завязан на захардкоженный никнейм и мок-данные.
- У фронтенда нет автотестов, только сборка.

---

## 6. Откат

```bash
git revert -m 1 <merge-commit>   # откат слияния целиком
# или
git reset --hard <предыдущий-коммит>   # локально, до пуша
```

Cookie-формат и API-контракт несовместимы со старой версией: при откате бэкенда нужно
одновременно откатывать фронтенд (он ждёт `accessToken` и подтверждение email).
