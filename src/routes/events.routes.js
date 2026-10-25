const express = require('express');
const Event   = require('../models/Event');

const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// GET /api/events
router.get('/', asyncHandler(async (req, res, next) => {
  try {
    const events = await Event.find()
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(events);
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
