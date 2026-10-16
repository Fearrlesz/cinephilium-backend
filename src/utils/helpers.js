const mongoose = require('mongoose');
const User     = require('../models/User');
const Rating   = require('../models/Rating');
const Review   = require('../models/Review');
const Comment  = require('../models/Comment');
const Event    = require('../models/Event');
const { getUserAchievements } = require('./achievements');

async function existsById(model, id) {
  return (await model.exists({ _id: id })) !== null;
}

async function createEvent(type, user, film, filmId, score = null, contentId = null, metadata = {}) {
  try {
    await Event.create({ type, user, film: film || '', filmId, score, contentId, metadata });
  } catch (error) {
    console.error('Ошибка создания события:', error);
  }
}

async function updateAchievements(userId) {
  try {
    const ratingsCount  = await Rating.countDocuments({ userId });
    const reviewsCount  = await Review.countDocuments({ userId, status: 'approved' });
    const commentsCount = await Comment.countDocuments({ userId, status: 'approved' });

    const allPossible = await getUserAchievements(
      userId,
      mongoose.connection.db,
      ratingsCount,
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

      await createEvent(
        'achievement',
        user.nickname,
        'Новое достижение!',
        null, null, null,
        { achievements: newAchievements }
      );
    }
  } catch (error) {
    console.error('❌ Ошибка обновления достижений:', error);
  }
}

module.exports = { existsById, createEvent, updateAchievements };
