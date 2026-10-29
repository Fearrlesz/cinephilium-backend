const express = require('express');
const mongoose = require('mongoose');
const User    = require('../models/User');
const PrivacyChangeLog = require('../models/PrivacyChangeLog');
const { authenticate } = require('../middleware/auth');
const { validateObjectId } = require('../middleware/validate');
const { writeLimiter, extractBearer } = require('../middleware/security');
const { verifyAccessToken } = require('../utils/jwt');
const { EXCLUSIVE_NICKNAME } = require('../config/env');
const { getUserAchievements } = require('../utils/achievements');
const { HIDDEN_FIELDS, privacyOf, canViewProfile, hiddenProfileStub } = require('../utils/privacy');
const { listDiary } = require('../utils/diaryQuery');
const { listWatchlist } = require('../utils/watchlistQuery');
const { listLikes } = require('../utils/filmLikesQuery');
const { listRatings, listReviews, listComments } = require('../utils/profileTabsQuery');

const asyncHandler = require('../utils/asyncHandler');
const {
  NotFoundError, ValidationError, AppError, UnauthorizedError
} = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

/**
 * Зритель из токена: `null` для анонима.
 * @returns {Promise<{userId: string, isAdmin: boolean}|null>}
 */
async function resolveViewer(req) {
  const token = extractBearer(req);
  if (!token) return null;

  try {
    const decoded = verifyAccessToken(token);
    const viewer = await User.findById(decoded.userId).select('isAdmin');
    return { userId: decoded.userId, isAdmin: viewer?.isAdmin || false };
  } catch {
    return null;
  }
}

/**
 * Закреплённое достижение с проверкой, что оно всё ещё получено.
 *
 * DECISION: B9/pinned-lost — если pinnedAchievement нет в achievements (такого
 * быть не должно, но данные могут разъехаться), отдаём null и пишем [WARN],
 * а не падаем и не показываем чужую «витрину».
 */
function resolvePinnedAchievement(user) {
  const pinned = user?.pinnedAchievement || null;
  if (!pinned) return null;

  const earned = Array.isArray(user.achievements) ? user.achievements : [];
  if (!earned.includes(pinned)) {
    console.warn(
      `[WARN] pinnedAchievement "${pinned}" отсутствует в achievements пользователя ${user?._id}`
    );
    return null;
  }
  return pinned;
}

/**
 * Общий контекст вкладок профиля (B9): зритель, цель, приватность и
 * статус-фильтр. Вызывается только из /:id/{ratings,reviews,comments}.
 *
 * DECISION: B9/7A — `:id = me` означает свои вкладки. Отдельные /me/ratings
 * и т.п. не заводим: роут один, а зритель для `me` берётся из токена.
 * DECISION: B9/status — чужие видят только approved; владелец и админ — всё,
 * включая pending/rejected. Это тот же фильтр, что был в карточке профиля.
 */
async function loadTabContext(req) {
  const requested = String(req.params.id || '');
  const viewer = await resolveViewer(req);

  if (requested === 'me' && !viewer) {
    throw new UnauthorizedError('Требуется авторизация');
  }

  const userId = requested === 'me' ? viewer.userId : requested;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new ValidationError('Неверный ID');
  }

  const target = await User.findById(userId).select('privacy');
  if (!target) throw new NotFoundError('Пользователь не найден');

  // DECISION: B9/privacy — все вкладки профиля (включая рецензии и комментарии)
  // при скрытом профиле и зрителе без прав отдают 404 PROFILE_HIDDEN — так же,
  // как дневник (retro-fit B5), watchlist (B6) и «Понравившиеся» (B7).
  // Публичные эндпоинты контента (GET /api/reviews/:filmId, GET /api/comments)
  // не меняются: скрыт профиль, а не опубликованный текст.
  if (!canViewProfile(viewer, target)) {
    throw new AppError('PROFILE_HIDDEN', 'Профиль скрыт', 404);
  }

  const isOwnProfile = Boolean(viewer) && String(viewer.userId) === String(target._id);
  const isAdmin = Boolean(viewer?.isAdmin);

  return {
    target,
    viewer,
    statusFilter: isOwnProfile || isAdmin ? {} : { status: 'approved' }
  };
}

async function sendProfile(req, res, userId) {
  const user = await User.findById(userId).select('-password');
  if (!user) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);

  // DECISION: B-PRIVACY/A2 — при скрытом профиле посторонний видит только
  // заглушку (E2): ник и аватар. Ни counters, ни достижений, ни оценок,
  // ни дневника в ответе нет — это личные разделы. Рецензии и комментарии
  // продолжают жить там, где опубликованы (C2), но их вкладки в профиле
  // закрыты по B9/privacy.
  if (!canViewProfile(viewer, user)) {
    return res.json({ user: hiddenProfileStub(user) });
  }

  const isOwnProfile = Boolean(viewer) && String(viewer.userId) === String(user._id);

  // DECISION: B9/1B — карточка профиля больше не отдаёт массивы ratings,
  // reviews, comments, watches, achievements. Это осознанно ломающее изменение:
  // вкладки переехали в отдельные пагинированные эндпоинты, а двойной формат
  // («массивы + вкладки») не оставляем ни на релиз, ни под feature-flag.
  // Фронт 3.9 сломается — так и задумано, чтобы обновление нельзя было забыть.
  // Достижения остаются числом + закреплённым; полный список — в /:id/achievements.
  res.json({
    user: {
      id: user._id,
      nickname: user.nickname,
      avatar: user.avatar,
      registeredAt: user.registeredAt,
      isAdmin: user.isAdmin,
      totalPoints: user.totalPoints,
      counters: user.counters || {},
      // B5: фронт должен знать, что дневник закрыт, иначе покажет пустоту
      // вместо «дневник закрыт». Само значение не секрет — это настройка видимости.
      diaryPrivate: user.diaryPrivate === true,
      pinnedAchievement: resolvePinnedAchievement(user),
      achievementsCount: (user.achievements || []).length,
      email: isOwnProfile ? user.email : undefined,
      isExclusive: user.nickname === EXCLUSIVE_NICKNAME
    }
  });
}

async function sendAchievements(res, userId) {
  const userObjectId = new mongoose.Types.ObjectId(String(userId));
  const user = await User.findById(userId).select('achievements nickname counters totalPoints');
  if (!user) throw new NotFoundError('Пользователь не найден');

  const ratingsCount  = user.counters?.ratings || 0;
  const vibesCount    = user.counters?.vibes || 0;
  const reviewsCount  = user.counters?.reviewsApproved || 0;
  const commentsCount = user.counters?.commentsApproved || 0;

  const allPossible = await getUserAchievements(
    userObjectId,
    mongoose.connection.db,
    { ratings: ratingsCount, vibes: vibesCount },
    reviewsCount,
    commentsCount
  );

  res.json({
    nickname: user.nickname,
    earned: user.achievements || [],
    possible: allPossible,
    totalPoints: user.totalPoints || 0,
    progress: {
      ratings: ratingsCount,
      vibes: vibesCount,
      reviews: reviewsCount,
      comments: commentsCount
    }
  });
}

// GET /api/users/me/achievements — должно быть объявлено ДО /:id/achievements,
// иначе "me" попадёт в :id и не пройдёт валидацию ObjectId.
router.get('/me/achievements', authenticate, asyncHandler(async (req, res) => {
  await sendAchievements(res, req.userId);
}));

// GET /api/users/me/privacy — текущее состояние флагов.
router.get('/me/privacy', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('privacy');
  if (!user) throw new NotFoundError('Пользователь не найден');
  res.json(privacyOf(user));
}));

// PUT /api/users/me/privacy — partial update { hideProfile?, hideFromFeed? }.
// DECISION: B-PRIVACY/D1 — флаги независимы: непереданный остаётся как был.
// DECISION: B-PRIVACY/G2 — лог пишется только при фактическом изменении значения.
router.put('/me/privacy', authenticate, writeLimiter, asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('privacy');
  if (!user) throw new NotFoundError('Пользователь не найден');

  const current = privacyOf(user);
  const next = { ...current };

  for (const field of HIDDEN_FIELDS) {
    const value = req.body?.[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw new ValidationError(`${field} должен быть true или false`);
    }
    next[field] = value;
  }

  const changed = HIDDEN_FIELDS.filter(field => current[field] !== next[field]);

  if (changed.length > 0) {
    const set = {};
    for (const field of changed) set[`privacy.${field}`] = next[field];
    await User.updateOne({ _id: req.userId }, { $set: set });

    await PrivacyChangeLog.insertMany(changed.map(field => ({
      userId: req.userId,
      field,
      oldValue: current[field],
      newValue: next[field],
      ip: req.ip || ''
    })));
  }

  res.json(next);
}));

// GET /api/users/me/likes — свой список «Понравившихся».
// DECISION: B7/not-gated — всегда доступен владельцу, приватность профиля его
// не гейтит: скрывается чужой взгляд, а не свой список.
// Объявлен ДО /:id/likes, иначе "me" попадёт в :id и не пройдёт валидацию ObjectId.
router.get('/me/likes', authenticate, asyncHandler(async (req, res) => {
  res.json(await listLikes(req.userId, req.query, req));
}));

// GET /api/users/me/pinned-achievement — текущее закреплённое достижение.
// Объявлено ДО /:id/..., иначе "me" попадёт в :id и не пройдёт валидацию.
router.get('/me/pinned-achievement', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('achievements pinnedAchievement');
  if (!user) throw new NotFoundError('Пользователь не найден');
  res.json({ pinnedAchievement: resolvePinnedAchievement(user) });
}));

// PUT /api/users/me/pinned-achievement — { achievement: string | null }.
// DECISION: B9/achievement-validation — строка должна ТОЧНО совпадать с одним из
// User.achievements, иначе 400 ACHIEVEMENT_NOT_EARNED: закрепить можно только
// полученное достижение. null снимает закрепление.
// Свой профиль доступен владельцу всегда, поэтому hideProfile здесь не гейтит.
router.put('/me/pinned-achievement', authenticate, writeLimiter, asyncHandler(async (req, res) => {
  const achievement = req.body?.achievement;

  if (achievement !== null && (typeof achievement !== 'string' || !achievement.trim())) {
    throw new ValidationError('achievement должен быть непустой строкой или null');
  }

  const user = await User.findById(req.userId).select('achievements');
  if (!user) throw new NotFoundError('Пользователь не найден');

  if (achievement !== null && !(user.achievements || []).includes(achievement)) {
    throw new AppError('ACHIEVEMENT_NOT_EARNED', 'Достижение не получено', 400);
  }

  await User.updateOne({ _id: req.userId }, { $set: { pinnedAchievement: achievement } });
  res.json({ pinnedAchievement: achievement });
}));

// GET /api/users/nickname/:nickname — поиск профиля по никнейму (страница критика).
// Отдаём компактный lookup: фронтенд использует его только чтобы получить _id.
router.get('/nickname/:nickname', asyncHandler(async (req, res) => {
  const nickname = String(req.params.nickname || '').trim();
  if (!nickname) throw new NotFoundError('Пользователь не найден');

  const found = await User.findOne({ nickname }).select('_id nickname avatar privacy');
  if (!found) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);
  // E2: скрытый профиль отдаёт только ник и аватар — их и так видно в рецензиях.
  if (!canViewProfile(viewer, found)) return res.json(hiddenProfileStub(found));

  res.json({
    _id: found._id,
    id: found._id,
    nickname: found.nickname,
    avatar: found.avatar
  });
}));

// GET /api/users/:id/watches — публичный дневник пользователя (алиас B5-роута
// GET /api/watches/user/:userId, см. DECISION B-PRIVACY/alias).
// DECISION: B-PRIVACY/retro-fit — дневник относится к личным разделам (A2),
// поэтому при скрытом профиле без прав отдаём 404, а не заглушку.
router.get('/:id/watches', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const target = await User.findById(req.params.id).select('privacy diaryPrivate');
  if (!target) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);
  if (!canViewProfile(viewer, target)) {
    throw new AppError('PROFILE_HIDDEN', 'Профиль скрыт', 404);
  }

  const result = await listDiary(target._id, req.query, req);
  res.json({ ...result, private: target.diaryPrivate === true });
}));

// GET /api/users/:id/watchlist — публичный список «хочу посмотреть».
// DECISION: B6/4=404 — при скрытом профиле и зрителе без прав 404, как у дневника
// (B-PRIVACY/retro-fit), а не заглушка: watchlist — личный раздел (A2), а 404 —
// язык личных разделов; страница профиля при этом отдаёт заглушку.
// Проверка — через canViewProfile из utils/privacy.js, без дублирования логики.
router.get('/:id/watchlist', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const target = await User.findById(req.params.id).select('privacy');
  if (!target) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);
  if (!canViewProfile(viewer, target)) {
    throw new AppError('PROFILE_HIDDEN', 'Профиль скрыт', 404);
  }

  res.json(await listWatchlist(target._id, req.query, req));
}));

// GET /api/users/:id/likes — публичный список «Понравившихся».
// DECISION: B7/6=404 — при скрытом профиле и зрителе без прав 404, как дневник
// (B-PRIVACY/retro-fit) и watchlist (B6/4=404): «Понравившиеся» — личный раздел.
// Проверка через canViewProfile, без копии логики; ветка «друзья» появится там же.
router.get('/:id/likes', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const target = await User.findById(req.params.id).select('privacy');
  if (!target) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);
  if (!canViewProfile(viewer, target)) {
    throw new AppError('PROFILE_HIDDEN', 'Профиль скрыт', 404);
  }

  res.json(await listLikes(target._id, req.query, req));
}));

// ─────────────────────────── ВКЛАДКИ ПРОФИЛЯ (B9) ───────────────────────────
//
// Один роут на вкладку: `:id` — ObjectId или `me` (DECISION B9/7A). Специфичные
// /me/* объявлены выше, а здесь `me` обрабатывает loadTabContext, поэтому
// отдельные /me/ratings, /me/reviews, /me/comments не нужны.
//
// DECISION: B9/1B — массивы из GET /api/users/:id удалены, вкладки живут только
// здесь. Формат — { items, pagination }, пагинация — utils/paging.js.
// DECISION: B9/2B+4A — /ratings отдаёт всё (vibe + full) с completeness;
// counters.ratings (только full) намеренно не равен pagination.total.

// GET /api/users/:id/ratings
// Сортировка зафиксирована по дате (B9/3A), параметра ?sort= нет.
router.get('/:id/ratings', asyncHandler(async (req, res) => {
  const { target } = await loadTabContext(req);
  res.json(await listRatings(target._id, req.query, req));
}));

// GET /api/users/:id/reviews — status = approved для чужих, всё для владельца/админа.
router.get('/:id/reviews', asyncHandler(async (req, res) => {
  const { target, statusFilter } = await loadTabContext(req);
  res.json(await listReviews(target._id, req.query, statusFilter, req));
}));

// GET /api/users/:id/comments — оба targetType (film/review), targetType в каждом.
router.get('/:id/comments', asyncHandler(async (req, res) => {
  const { target, statusFilter } = await loadTabContext(req);
  res.json(await listComments(target._id, req.query, statusFilter, req));
}));

// GET /api/users/:id/achievements
// Должен быть объявлен до /:id только для читаемости: Express 5 сопоставляет
// путь целиком, и /:id не перехватывает /:id/achievements. Но порядок
// «специфичные раньше общего» соблюдаем сознательно.
router.get('/:id/achievements', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const target = await User.findById(req.params.id).select('privacy');
  if (!target) throw new NotFoundError('Пользователь не найден');

  const viewer = await resolveViewer(req);
  if (!canViewProfile(viewer, target)) {
    throw new AppError('PROFILE_HIDDEN', 'Профиль скрыт', 404);
  }

  await sendAchievements(res, req.params.id);
}));

// GET /api/users/:id — карточка профиля (B9: только user + counters +
// pinnedAchievement + achievementsCount; массивы удалены по 1B).
router.get('/:id', validateObjectId('id'), asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;
  await sendProfile(req, res, req.params.id);
}));

module.exports = router;
