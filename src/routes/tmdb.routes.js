const express = require('express');

const asyncHandler = require('../utils/asyncHandler');
const { ValidationError } = require('../utils/errors');

const router = express.Router();

// GET /api/tmdb/search
router.get('/search', asyncHandler(async (req, res, next) => {
  const query = req.query.query || req.body.query;
  if (!query || query.trim() === '') {
    throw new ValidationError('Введите поисковый запрос');
  }

  try {
    const apiKey = process.env.TMDB_API_KEY;
    const response = await fetch(
      `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(query)}&language=ru-RU`
    );

    if (!response.ok) throw new Error(`TMDB API error: ${response.status}`);

    const data = await response.json();
    res.json(data);
  } catch (error) {
    throw error;
  }
}));

module.exports = router;
