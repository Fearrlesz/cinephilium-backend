const express = require('express');
const Event   = require('../models/Event');
const User    = require('../models/User');

const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// GET /api/events
// DECISION: B-PRIVACY/I1 — hideFromFeed скрывает ВСЕ события автора
// (vibe, rating, review, comment, achievement, film_add). Фильтрация на чтении:
// снял флаг — события вернулись.
// Фильтруем по userId, а не по нику: ник — отображаемое имя, а не связь
// (DECISION B-PRIVACY/event-userid, вариант A).
router.get('/', asyncHandler(async (req, res, next) => {
  const hidden = await User.find({ 'privacy.hideFromFeed': true }).select('_id').lean();

  // События без userId (не прошли миграцию) остаются видимыми: скрыть их нечем,
  // а исчезновение всей старой ленты было бы хуже. Миграция add-event-userid
  // закрывает этот разрыв.
  const filter = hidden.length > 0
    ? { userId: { $nin: hidden.map(user => user._id) } }
    : {};

  const events = await Event.find(filter).sort({ createdAt: -1 }).limit(50);
  res.json(events);
}));

module.exports = router;
