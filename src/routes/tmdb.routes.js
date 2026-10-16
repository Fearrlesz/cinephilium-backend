const express = require('express');

const router = express.Router();

// GET /api/tmdb/search
router.get('/search', async (req, res) => {
  const query = req.query.query || req.body.query;
  if (!query || query.trim() === '') {
    return res.status(400).json({ error: 'Введите поисковый запрос' });
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
    console.error('Ошибка поиска в TMDB:', error);
    res.status(500).json({ error: 'Ошибка поиска фильмов' });
  }
});

module.exports = router;
