require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');

const app = express();
app.use(cors());
app.use(express.json());

const User = mongoose.model('User', {
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  nickname: { type: String, required: true },
  avatar: { type: String, default: '' },
  registeredAt: { type: Date, default: Date.now }
});

const Film = mongoose.model('Film', {
  tmdbId: { type: Number, unique: true },
  title: String,
  year: Number,
  poster: String,
  description: String,
  genres: [String],
  director: String,
  actors: [String],
  trailer: String,
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

const Rating = mongoose.model('Rating', {
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  base1: { type: [Number], required: true },
  base2: { type: [Number], required: true },
  base3: { type: [Number], required: true },
  base4: { type: [Number], required: true },
  subjectiveM: { type: Number, required: true, min: 1, max: 10 },
  technicalScore: Number,
  finalScore: Number,
  textReview: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

function calculateRating(base1, base2, base3, base4, subjectiveM) {
    const avg1 = base1.reduce((a, b) => a + b, 0) / 5;
    const avg2 = base2.reduce((a, b) => a + b, 0) / 5;
    const avg3 = base3.reduce((a, b) => a + b, 0) / 5;
    const avg4 = base4.reduce((a, b) => a + b, 0) / 5;
    
    const T = (avg1 + avg2 + avg3 + avg4) * 1.4;
    const finalRaw = T + 34 * (subjectiveM - 1) / 9;
    
    return {
        technicalScore: Math.round(T),
        finalScore: Math.round(finalRaw)
    };
}

app.post('/api/auth/register', [
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  body('nickname').notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, password, nickname } = req.body;
    const existingUser = await User.findOne({ $or: [{ email }, { nickname }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Пользователь уже существует' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword, nickname });
    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, email, nickname } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, email, nickname: user.nickname } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    res.json({ id: user._id, email: user.email, nickname: user.nickname, avatar: user.avatar });
  } catch (error) {
    res.status(401).json({ error: 'Неверный токен' });
  }
});

app.get('/api/films', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  try {
    const films = await Film.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const filmsWithRating = await Promise.all(films.map(async (film) => {
      const ratings = await Rating.find({ filmId: film._id });
      const avgRating = ratings.length > 0 
        ? ratings.reduce((sum, r) => sum + r.finalScore, 0) / ratings.length
        : 0;
      
      return {
        ...film.toObject(),
        averageRating: Math.round(avgRating * 100) / 100,
        votesCount: ratings.length
      };
    }));

    const total = await Film.countDocuments();
    res.json({
      films: filmsWithRating,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/films/:id', async (req, res) => {
  try {
    const film = await Film.findById(req.params.id);
    if (!film) {
      return res.status(404).json({ error: 'Фильм не найден' });
    }

    const ratings = await Rating.find({ filmId: film._id });
    const avgRating = ratings.length > 0 
      ? ratings.reduce((sum, r) => sum + r.finalScore, 0) / ratings.length
      : 0;

    let userRating = null;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userRating = await Rating.findOne({ filmId: film._id, userId: decoded.userId });
      } catch (e) {}
    }

    res.json({
      ...film.toObject(),
      averageRating: Math.round(avgRating * 100) / 100,
      votesCount: ratings.length,
      userRating
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tmdb/search', async (req, res) => {
  const { query } = req.query;
  if (!query) {
    return res.status(400).json({ error: 'Введите поисковый запрос' });
  }

  try {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'TMDB API ключ не настроен' });
    }
    const response = await fetch(
      `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(query)}&language=ru-RU`
    );
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/films/import', async (req, res) => {
  const { tmdbId } = req.body;
  
  try {
    const existingFilm = await Film.findOne({ tmdbId });
    if (existingFilm) {
      return res.status(400).json({ error: 'Этот фильм уже добавлен' });
    }

    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'TMDB API ключ не настроен' });
    }
    const filmResponse = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=ru-RU&append_to_response=credits,videos`
    );
    const filmData = await filmResponse.json();

    if (!filmData.title) {
      return res.status(404).json({ error: 'Фильм не найден в TMDB' });
    }

    const newFilm = new Film({
      tmdbId: filmData.id,
      title: filmData.title,
      year: new Date(filmData.release_date).getFullYear(),
      poster: filmData.poster_path ? `https://image.tmdb.org/t/p/w500${filmData.poster_path}` : '',
      description: filmData.overview,
      genres: filmData.genres?.map(g => g.name) || [],
      director: filmData.credits?.crew?.find(c => c.job === 'Director')?.name || 'Неизвестен',
      actors: filmData.credits?.cast?.slice(0, 5).map(a => a.name) || [],
      trailer: filmData.videos?.results?.find(v => v.type === 'Trailer')?.key 
        ? `https://www.youtube.com/embed/${filmData.videos.results.find(v => v.type === 'Trailer').key}`
        : ''
    });

    await newFilm.save();
    res.json(newFilm);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ratings', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { filmId, base1, base2, base3, base4, subjectiveM, textReview } = req.body;

    if (![base1, base2, base3, base4].every(arr => arr.length === 5)) {
      return res.status(400).json({ error: 'Необходимо заполнить все 20 критериев' });
    }

    const allValues = [...base1, ...base2, ...base3, ...base4];
    if (allValues.some(v => v < 1 || v > 10)) {
      return res.status(400).json({ error: 'Все оценки должны быть от 1 до 10' });
    }

    const { technicalScore, finalScore } = calculateRating(base1, base2, base3, base4, subjectiveM);

    let rating = await Rating.findOne({ userId: decoded.userId, filmId });
    
    if (rating) {
      rating.base1 = base1;
      rating.base2 = base2;
      rating.base3 = base3;
      rating.base4 = base4;
      rating.subjectiveM = subjectiveM;
      rating.technicalScore = technicalScore;
      rating.finalScore = finalScore;
      rating.textReview = textReview || rating.textReview;
      rating.updatedAt = new Date();
      await rating.save();
    } else {
      rating = new Rating({
        userId: decoded.userId,
        filmId,
        base1,
        base2,
        base3,
        base4,
        subjectiveM,
        technicalScore,
        finalScore,
        textReview: textReview || ''
      });
      await rating.save();
    }

    res.json({
      rating,
      technicalScore,
      finalScore
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ratings/user', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const ratings = await Rating.find({ userId: decoded.userId })
      .populate('filmId')
      .sort({ createdAt: -1 });

    res.json(ratings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/ratings/:id', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const rating = await Rating.findById(req.params.id);
    
    if (!rating) {
      return res.status(404).json({ error: 'Оценка не найдена' });
    }

    if (rating.userId.toString() !== decoded.userId) {
      return res.status(403).json({ error: 'Нет прав на удаление' });
    }

    await Rating.findByIdAndDelete(req.params.id);
    res.json({ message: 'Оценка удалена' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ Ошибка: MONGODB_URI не задан в переменных окружения');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('✅ Подключено к MongoDB');
    app.listen(PORT, () => {
      console.log(`✅ Сервер запущен на порту ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Ошибка подключения к MongoDB:', err);
    process.exit(1);
  }); 
