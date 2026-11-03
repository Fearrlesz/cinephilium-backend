// Приватность профиля и ленты.
//
// DECISION: B-PRIVACY/A2 — скрываются только личные разделы (дневник, watchlist,
// оценки, достижения). Рецензии и комментарии остаются видимыми там, где опубликованы,
// и в агрегатах фильмов оценки скрытого пользователя тоже участвуют (F1).

const HIDDEN_FIELDS = ['hideProfile', 'hideFromFeed'];

function privacyOf(user) {
  return {
    hideProfile: user?.privacy?.hideProfile === true,
    hideFromFeed: user?.privacy?.hideFromFeed === true
  };
}

/**
 * Может ли зритель видеть профиль целиком.
 *
 * DECISION: B-PRIVACY/B3+ — скрытый профиль видят владелец, админ и в будущем
 * «друзья». Ветка друзей оставлена заглушкой: follow в проекте пока нет,
 * но вызывающий код (retro-fit B5, будущий B6) не должен переделываться.
 *
 * @param {{ userId?: string|object, isAdmin?: boolean }|null} viewer
 * @param {object|null} target документ User (нужны `_id` и `privacy`)
 * @returns {boolean}
 */
function canViewProfile(viewer, target) {
  if (!target) return false;
  if (!privacyOf(target).hideProfile) return true;
  if (!viewer) return false;

  if (viewer.userId && String(viewer.userId) === String(target._id)) return true;
  if (viewer.isAdmin) return true;

  // TODO: B-SOCIAL — здесь будет проверка «зритель и target — друзья/подписки».
  // Пока follow нет, скрытый профиль посторонним закрыт.
  return false;
}

/**
 * Заглушка скрытого профиля (E2): ник и аватар видны всегда — они и так
 * светятся в рецензиях и комментариях, поэтому прятать их бессмысленно.
 */
function hiddenProfileStub(user) {
  return {
    id: user._id,
    nickname: user.nickname,
    avatar: user.avatar || '',
    isHidden: true
  };
}

module.exports = { HIDDEN_FIELDS, privacyOf, canViewProfile, hiddenProfileStub };
