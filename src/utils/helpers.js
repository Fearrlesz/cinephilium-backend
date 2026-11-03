const mongoose = require('mongoose');
const User     = require('../models/User');
const Event    = require('../models/Event');
const { getUserAchievements } = require('./achievements');

async function existsById(model, id) {
  return (await model.exists({ _id: id })) !== null;
}

/**
 * Создание события ленты.
 *
 * DECISION: B-PRIVACY/event-userid (вариант A) — событие обязано знать автора:
 * без `userId` ленту нельзя отфильтровать по `privacy.hideFromFeed`. Параметры
 * передаются объектом, чтобы пропущенный автор не подставился «по старой памяти»
 * позиционно. `user` (ник) остаётся для отображения — это не связь.
 */
async function createEvent(type, {
  userId,
  nickname,
  film,
  filmId = null,
  score = null,
  contentId = null,
  metadata = {}
} = {}) {
  if (!userId) {
    // Событие без автора невозможно скрыть по приватности — лучше не создавать
    // и громко сообщить в лог, чем тихо получить неуправляемую запись.
    console.error(`[createEvent] пропущено событие "${type}": не передан userId`);
    return;
  }

  try {
    await Event.create({
      type,
      userId,
      user: nickname,
      film: film || '',
      filmId,
      score,
      contentId,
      metadata
    });
  } catch (error) {
    console.error('Ошибка создания события:', error);
  }
}

async function updateAchievements(userId) {
  try {
    const countersUser = await User.findById(userId).select('counters').lean();
    if (!countersUser) return;
    const ratingsCount  = countersUser.counters?.ratings || 0;
    const vibesCount    = countersUser.counters?.vibes || 0;
    const reviewsCount  = countersUser.counters?.reviewsApproved || 0;
    const commentsCount = countersUser.counters?.commentsApproved || 0;

    const allPossible = await getUserAchievements(
      userId,
      mongoose.connection.db,
      { ratings: ratingsCount, vibes: vibesCount },
      reviewsCount,
      commentsCount
    );

    const user = await User.findById(userId);
    if (!user) return;

    const currentAchievements = user.achievements || [];
    const newAchievements = allPossible.filter(a => !currentAchievements.includes(a));

    if (newAchievements.length > 0) {
      const updatedAchievements = [...currentAchievements, ...newAchievements];
      await User.findByIdAndUpdate(userId, { achievements: updatedAchievements });
      console.log(`🎮 Пользователь ${user.nickname} получил новые достижения: ${newAchievements.join(', ')}`);

      await createEvent('achievement', {
        userId: user._id,
        nickname: user.nickname,
        film: 'Новое достижение!',
        metadata: { achievements: newAchievements }
      });
    }
  } catch (error) {
    console.error('❌ Ошибка обновления достижений:', error);
  }
}

module.exports = { existsById, createEvent, updateAchievements };
