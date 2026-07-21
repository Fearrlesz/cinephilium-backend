require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult, param } = require('express-validator');

const app = express();
app.use(cors());
app.use(express.json());

// ===== ПРОВЕРКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ =====
const requiredEnv = ['MONGODB_URI', 'JWT_SECRET', 'TMDB_API_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`❌ Ошибка: Отсутствуют обязательные переменные окружения: ${missingEnv.join(', ')}`);
  console.error('   Добавьте их в настройках Render (Environment Variables)');
  process.exit(1);
}

console.log('✅ Все переменные окружения заданы');

// ===== ПОДКЛЮЧЕНИЕ К БАЗЕ =====
mongoose.set('strictQuery', false);

// ===== СХЕМЫ МОДЕЛЕЙ =====

const userSchema = new mongoose.Schema({
  email: { 
    type: String, 
    unique: true, 
    required: true,
    maxlength: 100
  },
  password: { 
    type: String, 
    required: true 
  },
  nickname: { 
    type: String, 
    required: true,
    maxlength: 50
  },
  avatar: { 
    type: String, 
    default: '' 
  },
  registeredAt: { 
    type: Date, 
    default: Date.now 
  }
});

const filmSchema = new mongoose.Schema({
  tmdbId: { type: Number, unique: true },
  title: { type: String, required: true },
  year: Number,
  poster: String,
  description: { type: String, maxlength: 1000 },
  genres: [String],
  director: { type: String, maxlength: 100 },
  actors: [String],
  trailer: String,
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

const ratingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  base1: { type: [Number], required: true, validate: v => v.length === 5 },
  base2: { type: [Number], required: true, validate: v => v.length === 5 },
  base3: { type: [Number], required: true, validate: v => v.length === 5 },
  base4: { type: [Number], required: true, validate: v => v.length === 5 },
  subjectiveM: { type: Number, required: true, min: 1, max: 10 },
  technicalScore: Number,
  finalScore: Number,
  textReview: { type: String, maxlength: 2000 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ===== ИНДЕКСЫ =====
ratingSchema.index({ userId: 1, filmId: 1 }, { unique: true });
ratingSchema.index({ filmId: 1 });
ratingSchema.index({ userId: 1 });
filmSchema.index({ title: 'text' });

const User = mongoose.model('User', userSchema);
const Film = mongoose.model('Film', filmSchema);
const Rating = mongoose.model('Rating', ratingSchema);

// ===== ФУНКЦИЯ РАСЧЕТА ОЦЕНКИ =====

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

// ===== МИДДЛВАР АУТЕНТИФИКАЦИИ =====

const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Неверный токен' });
  }
};

// ===== МИДДЛВАР ВАЛИДАЦИИ OBJECTID =====

const validateObjectId = (paramName) => [
  param(paramName).isMongoId().withMessage('Неверный ID')
];

// ===== АУТЕНТИФИКАЦИЯ =====

app.post('/api/auth/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Пароль должен быть минимум 6 символов'),
  body('nickname').notEmpty().isLength({ max: 50 }).withMessage('Никнейм не длиннее 50 символов')
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
    res.json({ 
      token, 
      user: { 
        id: user._id, 
        email: user.email, 
        nickname: user.nickname,
        registeredAt: user.registeredAt 
      } 
    });
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/auth/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ 
      token, 
      user: { 
        id: user._id, 
        email: user.email, 
        nickname: user.nickname,
        registeredAt: user.registeredAt 
      } 
    });
  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    res.json(user);
  } catch (error) {
    console.error('Ошибка получения профиля:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ===== ФИЛЬМЫ =====

app.get('/api/films', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  try {
    // Один запрос через агрегацию вместо N запросов
    const filmsWithRatings = await Film.aggregate([
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: 'ratings',
          localField: '_id',
          foreignField: 'filmId',
          as: 'ratings'
        }
      },
      {
        $addFields: {
          averageRating: {
            $cond: [
              { $gt: [{ $size: '$ratings' }, 0] },
              { $round: [{ $avg: '$ratings.finalScore' }, 1] },
              0
            ]
          },
          votesCount: { $size: '$ratings' }
        }
      },
      { $project: { ratings: 0 } }
    ]);

    const total = await Film.countDocuments();

    res.json({
      films: filmsWithRatings,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Ошибка загрузки фильмов:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/films/:id', [
  ...validateObjectId('id')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const film = await Film.findById(req.params.id);
    if (!film) {
      return res.status(404).json({ error: 'Фильм не найден' });
    }

    const ratingData = await Rating.aggregate([
      { $match: { filmId: film._id } },
      { $group: {
        _id: null,
        avgRating: { $avg: '$finalScore' },
        total: { $sum: 1 }
      }}
    ]);

    let userRating = null;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userRating = await Rating.findOne({ filmId: film._id, userId: decoded.userId });
      } catch (e) {}
    }

    const avgRating = ratingData.length > 0 ? Math.round(ratingData[0].avgRating * 10) / 10 : 0;
    const votesCount = ratingData.length > 0 ? ratingData[0].total : 0;

    res.json({
      ...film.toObject(),
      averageRating: avgRating,
      votesCount,
      userRating
    });
  } catch (error) {
    console.error('Ошибка загрузки фильма:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ===== ПОЛЬЗОВАТЕЛИ =====

// Получить всех пользователей, оценивших фильм
app.get('/api/films/:id/users', [
  ...validateObjectId('id')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const filmId = req.params.id;
    const ratings = await Rating.find({ filmId })
      .populate('userId', 'nickname email avatar')
      .select('userId finalScore technicalScore subjectiveM base1 base2 base3 base4 textReview');
    
    const users = ratings.map(r => ({
      user: {
        id: r.userId._id,
        nickname: r.userId.nickname,
        avatar: r.userId.avatar,
        // email скрываем для чужих пользователей
        email: undefined
      },
      rating: {
        id: r._id,
        finalScore: r.finalScore,
        technicalScore: r.technicalScore,
        subjectiveM: r.subjectiveM,
        base1: r.base1,
        base2: r.base2,
        base3: r.base3,
        base4: r.base4,
        textReview: r.textReview
      }
    }));
    
    res.json(users);
  } catch (error) {
    console.error('Ошибка загрузки пользователей фильма:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Получить профиль пользователя с его оценками
app.get('/api/users/:id', [
  ...validateObjectId('id')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const userId = req.params.id;
    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    const ratings = await Rating.find({ userId })
      .populate('filmId', 'title poster year');
    
    // Скрываем email для чужих пользователей
    const isOwnProfile = req.headers.authorization?.split(' ')[1] ? 
      (() => {
        try {
          const decoded = jwt.verify(req.headers.authorization.split(' ')[1], process.env.JWT_SECRET);
          return decoded.userId === userId;
        } catch { return false; }
      })() : false;

    res.json({
      user: {
        id: user._id,
        nickname: user.nickname,
        avatar: user.avatar,
        registeredAt: user.registeredAt,
        email: isOwnProfile ? user.email : undefined
      },
      ratings: ratings.map(r => ({
        id: r._id,
        film: r.filmId,
        finalScore: r.finalScore,
        technicalScore: r.technicalScore,
        subjectiveM: r.subjectiveM,
        base1: r.base1,
        base2: r.base2,
        base3: r.base3,
        base4: r.base4,
        textReview: r.textReview
      }))
    });
  } catch (error) {
    console.error('Ошибка загрузки профиля пользователя:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Получить детали одной оценки
app.get('/api/ratings/:id/details', [
  ...validateObjectId('id')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const rating = await Rating.findById(req.params.id)
      .populate('userId', 'nickname')
      .populate('filmId', 'title poster');
    
    if (!rating) {
      return res.status(404).json({ error: 'Оценка не найдена' });
    }
    
    res.json(rating);
  } catch (error) {
    console.error('Ошибка загрузки деталей оценки:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ===== TMDB ИНТЕГРАЦИЯ =====

app.get('/api/tmdb/search', [
  body('query').notEmpty().withMessage('Введите поисковый запрос')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { query } = req.query;
    const apiKey = process.env.TMDB_API_KEY;
    const response = await fetch(
      `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodeURIComponent(query)}&language=ru-RU`
    );
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Ошибка поиска в TMDB:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/films/import', [
  body('tmdbId').isInt({ min: 1 }).withMessage('Некорректный ID фильма')
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { tmdbId } = req.body;
    const apiKey = process.env.TMDB_API_KEY;

    // Получаем данные из TMDB
    const filmResponse = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=ru-RU&append_to_response=credits,videos`
    );
    const filmData = await filmResponse.json();

    if (!filmData.title) {
      return res.status(404).json({ error: 'Фильм не найден в TMDB' });
    }

    // Используем findOneAndUpdate с upsert для избежания race condition
    const filmDataForSave = {
      tmdbId: filmData.id,
      title: filmData.title,
      year: new Date(filmData.release_date).getFullYear(),
      poster: filmData.poster_path ? `https://image.tmdb.org/t/p/w500${filmData.poster_path}` : '',
      description: (filmData.overview || '').slice(0, 1000),
      genres: filmData.genres?.map(g => g.name) || [],
      director: filmData.credits?.crew?.find(c => c.job === 'Director')?.name || 'Неизвестен',
      actors: filmData.credits?.cast?.slice(0, 5).map(a => a.name) || [],
      trailer: filmData.videos?.results?.find(v => v.type === 'Trailer')?.key 
        ? `https://www.youtube.com/embed/${filmData.videos.results.find(v => v.type === 'Trailer').key}`
        : '',
      createdBy: req.userId
    };

    const film = await Film.findOneAndUpdate(
      { tmdbId: filmData.id },
      filmDataForSave,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json(film);
  } catch (error) {
    console.error('Ошибка импорта фильма:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ===== ОЦЕНКИ =====

app.post('/api/ratings', [
  body('filmId').isMongoId().withMessage('Некорректный ID фильма'),
  body('base1').isArray({ min: 5, max: 5 }).withMessage('Должно быть 5 оценок'),
  body('base2').isArray({ min: 5, max: 5 }).withMessage('Должно быть 5 оценок'),
  body('base3').isArray({ min: 5, max: 5 }).withMessage('Должно быть 5 оценок'),
  body('base4').isArray({ min: 5, max: 5 }).withMessage('Должно быть 5 оценок'),
  body('subjectiveM').isInt({ min: 1, max: 10 }).withMessage('M должно быть от 1 до 10'),
  body('textReview').optional().isLength({ max: 2000 }).withMessage('Отзыв не длиннее 2000 символов')
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { filmId, base1, base2, base3, base4, subjectiveM, textReview } = req.body;

    // Проверяем существование фильма
    const film = await Film.findById(filmId);
    if (!film) {
      return res.status(404).json({ error: 'Фильм не найден' });
    }

    // Проверяем значения критериев
    const allValues = [...base1, ...base2, ...base3, ...base4];
    if (allValues.some(v => v < 1 || v > 10)) {
      return res.status(400).json({ error: 'Все оценки должны быть от 1 до 10' });
    }

    const { technicalScore, finalScore } = calculateRating(base1, base2, base3, base4, subjectiveM);

    // Используем findOneAndUpdate с upsert
    const rating = await Rating.findOneAndUpdate(
      { userId: req.userId, filmId },
      {
        userId: req.userId,
        filmId,
        base1,
        base2,
        base3,
        base4,
        subjectiveM,
        technicalScore,
        finalScore,
        textReview: textReview || '',
        updatedAt: new Date()
      },
      { 
        upsert: true, 
        new: true, 
        setDefaultsOnInsert: true,
        runValidators: true
      }
    );

    res.json({
      rating,
      technicalScore,
      finalScore
    });
  } catch (error) {
    console.error('Ошибка сохранения оценки:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/ratings/user', authenticate, async (req, res) => {
  try {
    const ratings = await Rating.find({ userId: req.userId })
      .populate('filmId')
      .sort({ createdAt: -1 });

    res.json(ratings);
  } catch (error) {
    console.error('Ошибка получения оценок пользователя:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.delete('/api/ratings/:id', [
  ...validateObjectId('id')
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const rating = await Rating.findById(req.params.id);
    
    if (!rating) {
      return res.status(404).json({ error: 'Оценка не найдена' });
    }

    if (rating.userId.toString() !== req.userId) {
      return res.status(403).json({ error: 'Нет прав на удаление' });
    }

    await Rating.findByIdAndDelete(req.params.id);
    res.json({ message: 'Оценка удалена' });
  } catch (error) {
    console.error('Ошибка удаления оценки:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ===== ЗАПУСК СЕРВЕРА =====

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

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
    
