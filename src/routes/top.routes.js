const express = require('express');
const User    = require('../models/User');

const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// GET /api/top/users
router.get('/users', asyncHandler(async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    // Помеченные фермы не должны светиться и в рейтинге пользователей.
    const visibleFilter = { flagged: { $ne: true } };
    const total = await User.countDocuments(visibleFilter);

    const users = await User.aggregate([
      { $match: visibleFilter },
      { $project: { password: 0 } },
      { $sort: { totalPoints: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      { $project: {
        _id: 1,
        nickname: 1,
        avatar: 1,
        isAdmin: 1,
        totalPoints: 1,
        achievements: 1,
        registeredAt: 1,
        counters: 1
      } }
    ]);

    res.json({
      items: users,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
