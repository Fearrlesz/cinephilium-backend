const express = require('express');
const User    = require('../models/User');

const router = express.Router();

// GET /api/top/users
router.get('/users', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;

    const users = await User.aggregate([
      { $project: { password: 0 } },
      { $sort: { totalPoints: -1 } },
      { $limit: limit },
      { $lookup: { from: 'ratings',  localField: '_id', foreignField: 'userId', as: 'ratings' } },
      { $lookup: { from: 'reviews',  localField: '_id', foreignField: 'userId', as: 'reviews' } },
      { $lookup: { from: 'comments', localField: '_id', foreignField: 'userId', as: 'comments' } },
      {
        $lookup: {
          from: 'actions',
          let: { userId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$userId', '$$userId'] }, { $eq: ['$type', 'like'] }] } } }
          ],
          as: 'likesReceived'
        }
      },
      {
        $addFields: {
          ratingsCount:  { $size: '$ratings' },
          reviewsCount:  { $size: '$reviews' },
          commentsCount: { $size: '$comments' },
          likesReceived: { $size: '$likesReceived' }
        }
      },
      { $project: { ratings: 0, reviews: 0, comments: 0, likesReceived: 0 } }
    ]);

    res.json(users);
  } catch (error) {
    console.error('Ошибка загрузки топа:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
