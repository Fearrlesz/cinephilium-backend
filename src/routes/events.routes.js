const express = require('express');
const Event   = require('../models/Event');

const router = express.Router();

// GET /api/events
router.get('/', async (req, res) => {
  try {
    const events = await Event.find()
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(events);
  } catch (error) {
    console.error('Ошибка загрузки событий:', error);
    res.status(500).json({ error: 'Ошибка загрузки событий' });
  }
});

module.exports = router;
