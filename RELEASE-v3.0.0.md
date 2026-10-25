# Release v3.0.0 — Cinephilium

**Дата: 25.10.2026, 14:23 (Europe/Moscow)**

Крупное обновление API и фронтенда: подтверждение email, refresh-сессии, единые ошибки,
счётчики, прокси постеров, согласия на обработку данных и защита от накрутки оценок.

## Backend

- **Auth v3** — access-токен 15 минут + refresh в HttpOnly cookie с ротацией и серверными
  сессиями; `logout` / `logout-all`; cookie корректны для cross-site (`SameSite=None` в проде).
- **Email** — регистрация с подтверждением кодом (6 цифр, хеш в БД, TTL 10 мин, лимиты отправки);
  восстановление пароля по одноразовой ссылке (TTL 30 мин, все сессии сбрасываются).
- **Ошибки** — единый `{ error: { code, message, details? } }`, JSON 404, `CastError` → 400,
  дубликат → 409, битый JSON → 400.
- **Счётчики** — `User.counters`, топ пользователей без `$lookup`.
- **Постеры** — `posterPath` + прокси `/api/tmdb-image` (и алиас `/api/poster/:size/*`),
  legacy-поле `poster` сохранено для совместимости.
- **Согласия** — регистрация без `consent { personalData, cookies }` невозможна, проверка до
  записи в БД, согласия и IP сохраняются.
- **Анти-накрутка** — лимиты регистраций и оценок на IP, вес голоса, детектор ферм
  `scripts/flag-sybil-accounts.js`, агрегаты игнорируют помеченные оценки.
- **Исправлено** — ReDoS/500 в поиске, утечка черновиков, двойные награды при повторном
  одобрении, ответы на комментарии чужого фильма, неограниченный `limit`, CORS, 500 на сломанном JSON.
- **Тесты** — 80 тестов на реальной MongoDB.

## Frontend

- Переход на `accessToken` + автоматический refresh, `withCredentials`.
- Экран подтверждения email при регистрации.
- Страницы `/forgot-password` и `/reset-password`.
- Обязательные чекбоксы согласий и страница `/privacy`.
- Топ пользователей под новый формат `{ items, pagination }`.
- Лента событий только читается (убраны несуществующие `POST/DELETE /events`).
- Обработка нового формата ошибок, `logout` отзывает сессию на сервере.

## Миграции

Перед запуском на данных продакшена обязательно выполнить (подробно — README §11):

```bash
node scripts/backfill-email-verified.js
node scripts/migrate-counters.js
node scripts/migrate-posters.js
node scripts/backfill-anti-farm.js
node scripts/reconcile-counters.js
```

Без первого скрипта старые пользователи не смогут войти (логин требует подтверждённого email).
Без второго достижения и топ будут нулевыми.

## Breaking changes

- Регистрация больше не возвращает токен: нужен `verify-email`.
- `login` возвращает `accessToken` (не `token`) + cookie.
- Ошибки теперь объектом `{ error: { code, message } }`.
- `/api/top/users` возвращает `{ items, pagination }`, а не массив.
- `POST /api/auth/register` требует `consent`.
- `poster` — устаревшее поле, актуальное — `posterUrl`/`posterPath`.
