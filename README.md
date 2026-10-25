# Cinephilium Backend

API кино-каталога с оценками по 15 критериям, рецензиями, комментариями и геймификацией (баллы, достижения).

## Стек

Node.js >= 20.19, Express 5, MongoDB + Mongoose 9, JWT (access + refresh в HttpOnly cookie), bcrypt, express-validator, helmet, express-rate-limit.

## Быстрый старт

```bash
cp .env.example .env     # заполнить значения
npm install
npm start
```

Сервер слушает `PORT` (по умолчанию 3000), healthcheck — `GET /api/health`.

## Переменные окружения

Обязательные: `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `TMDB_API_KEY`, `ADMIN_SECRET_KEY`
(секреты access/refresh обязаны различаться).

Основные необязательные: `PORT`, `CORS_ORIGIN` (список origin через запятую), `CLIENT_URL`,
`JWT_ACCESS_TTL` (15m), `JWT_REFRESH_TTL_DAYS` (30), `COOKIE_DOMAIN`, `COOKIE_SECURE`,
`IMAGE_PROXY_BASE_URL`, `SMTP_*`, `EMAIL_*`.

Полный список — в `.env.example`.

## Тесты

Нужен запущенный MongoDB на `127.0.0.1:27017` (у каждого файла тестов своя база, поэтому
параллельный запуск безопасен).

```bash
npm test
```

Покрыто: регистрация и подтверждение email, сброс пароля, refresh-ротация сессий,
счётчики, модерация, прокси постеров, централизованные ошибки и регрессии по багам.

В окружениях, где нельзя спавнить процессы (например, строгая песочница), используйте
`node --test-isolation=none --test tests/<file>.test.js`.

## Служебные скрипты

```bash
node scripts/migrate-posters.js      # перенос poster -> posterPath
node scripts/migrate-counters.js     # первичный расчёт counters
node scripts/reconcile-counters.js   # сверка counters с реальными документами
node scripts/backfill-email-verified.js
```

## Структура

```
src/app.js            сборка Express-приложения
src/server.js         подключение к Mongo и запуск
src/config/           env, cors, формула скоринга
src/middleware/       auth, security, errorHandler, validate
src/models/           User, Film, Rating, Review, Comment, Event, Action, Session
src/routes/           роуты API
src/services/mailer.js
src/utils/            jwt, cookies, counters, poster, errors, achievements
api/tmdb-image.js     прокси постеров TMDB (также смонтирован в Express)
tests/                node:test
```

## API

- `/api/auth` — register, verify-email, resend-verification, login, refresh, logout,
  logout-all, forgot-password, reset-password, me
- `/api/films` — список, детали, top, поиск, импорт из TMDB
- `/api/ratings`, `/api/reviews`, `/api/comments` — оценки, рецензии, комментарии
- `/api/users` — профиль по id (`/users/:id`) или никнейму (`/users/nickname/:nickname`),
  достижения (`/users/:id/achievements`, `/users/me/achievements`)
- `/api/top` — рейтинги
- `/api/admin` — активация админа и модерация
- `/api/events` — лента событий
- `/api/tmdb-image` — прокси изображений TMDB (алиас `/api/poster/:size/*` для старых ссылок)

Авторизация: `Authorization: Bearer <accessToken>`; refresh-токен приходит в HttpOnly cookie
`refresh_token` (path `/api/auth`) и обновляется через `POST /api/auth/refresh`.

Ошибки отдаются единообразно: `{ "error": { "code": "...", "message": "...", "details": [...] } }`.

Постеры: в ответах есть `posterPath` и готовый `posterUrl`; поле `poster` устарело.
