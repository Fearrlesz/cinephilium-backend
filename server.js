
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult, param } = require('express-validator');

// ===== ПОДКЛЮЧЕНИЕ ДОСТИЖЕНИЙ =====
const { getUserAchievements } = require('./utils/achievements');

const app = express();

// ===== ДИАГНОСТИКА ПЕРЕМЕННЫХ =====
console.log('🔍 CLIENT_URL =', process.env.CLIENT_URL || '❌ НЕ УСТАНОВЛЕНА');
console.log('🔍 TMDB_API_KEY =', process.env.TMDB_API_KEY ? '✅ Есть (первые 10 символов: ' + process.env.TMDB_API_KEY.slice(0, 10) + '...)' : '❌ НЕТ');

// ===== НАСТРОЙКА CORS =====
const allowedOrigins = [
  process.env.CLIENT_URL,
  'https://cinephilium-frontendnew.vercel.app',
  'http://localhost:3000'
].filter(Boolean);

console.log('✅ Разрешённые CORS-источники:', allowedOrigins);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn('❌ CORS заблокировал запрос с origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// ===== ПРОВЕРКА ОБЯЗАТЕЛЬНЫХ ПЕРЕМЕННЫХ =====
const requiredEnv = ['MONGODB_URI', 'JWT_SECRET', 'TMDB_API_KEY', 'ADMIN_SECRET_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`❌ Ошибка: Отсутствуют обязательные переменные окружения: ${missingEnv.join(', ')}`);
  console.error('   Добавьте их в настройках Render (Environment Variables)');
  process.exit(1);
}

console.log('✅ Все переменные окружения заданы');

// ===== ПОДКЛЮЧЕНИЕ К БАЗЕ =====
mongoose.set('strictQuery', false);

// ============================================================
// СХЕМЫ МОДЕЛЕЙ
// ============================================================

// ----- ПОЛЬЗОВАТЕЛИ -----
const userSchema = new mongoose.Schema({
  email: {
    type: String,
    unique: true,
    required: true,
    maxlength: 100,
    match: [/^\S+@\S+\.\S+$/, 'Некорректный email']
  },
  password: { type: String, required: true },
  nickname: { type: String, unique: true, required: true, maxlength: 50 },
  avatar: { type: String, default: '' },
  isAdmin: { type: Boolean, default: false },
  totalPoints: { type: Number, default: 0 },
  achievements: { type: [String], default: [] },
  registeredAt: { type: Date, default: Date.now }
});

// ----- ФИЛЬМЫ -----
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

/* === БЛОК S1: Схема Rating (Синефилиум 2.0) ===
   - критерии и вайб: 1–10
   - technicalScore и combinedScore: 10–100
*/
const ratingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  genrePreset: { type: String, default: null },
  blockWeights: {
    scenario:   Number,
    characters: Number,
    visual:     Number,
    sound:      Number,
    style:      Number
  },
  scores: {
    scenario: {
      plot:     { type: Number, min: 1, max: 10, required: true },
      ideas:    { type: Number, min: 1, max: 10, required: true },
      dialogue: { type: Number, min: 1, max: 10, required: true }
    },
    characters: {
      depth:         { type: Number, min: 1, max: 10, required: true },
      chemistry:     { type: Number, min: 1, max: 10, required: true },
      functionality: { type: Number, min: 1, max: 10, required: true }
    },
    visual: {
      composition:    { type: Number, min: 1, max: 10, required: true },
      cinematography: { type: Number, min: 1, max: 10, required: true },
      pacing:         { type: Number, min: 1, max: 10, required: true },
      tone:           { type: Number, min: 1, max: 10, required: true }
    },
    sound: {
      music:     { type: Number, min: 1, max: 10, required: true },
      design:    { type: Number, min: 1, max: 10, required: true },
      narrative: { type: Number, min: 1, max: 10, required: true }
    },
    style: {
      originality: { type: Number, min: 1, max: 10, required: true },
      boldness:    { type: Number, min: 1, max: 10, required: true }
    }
  },
  vibe:           { type: Number, min: 1, max: 10, required: true },
  technicalScore: { type: Number, min: 10, max: 100 },
  combinedScore:  { type: Number, min: 10, max: 100 },
  textReview: { type: String, maxlength: 2000, default: '' },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

ratingSchema.index({ userId: 1, filmId: 1 }, { unique: true });
ratingSchema.index({ filmId: 1 });
ratingSchema.index({ userId: 1 });

// ----- КОММЕНТАРИИ -----
const commentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  text: { type: String, required: true, maxlength: 1000 },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ----- РЕЦЕНЗИИ -----
const reviewSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  ratingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rating', required: true },
  title: { type: String, required: true, maxlength: 100 },
  text: { type: String, required: true, maxlength: 5000 },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ----- ДЕЙСТВИЯ (для топа) -----
const actionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['rating', 'review', 'comment', 'like', 'import', 'admin_bonus'], required: true },
  points: { type: Number, required: true },
  refId: { type: mongoose.Schema.Types.ObjectId },
  createdAt: { type: Date, default: Date.now }
});

// ----- СОБЫТИЯ (лента активности) -----
const eventSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['rating', 'review', 'comment', 'film_add', 'achievement']
  },
  user: { type: String, required: true },
  film: { type: String, default: '' },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film' },
  score: { type: Number, default: null },
  contentId: { type: mongoose.Schema.Types.ObjectId },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now }
});

// ===== ИНДЕКСЫ =====
filmSchema.index({ title: 'text' });
commentSchema.index({ filmId: 1, createdAt: -1 });
actionSchema.index({ userId: 1, actorId: 1, refId: 1, type: 1 });
eventSchema.index({ createdAt: -1 });

const User    = mongoose.model('User', userSchema);
const Film    = mongoose.model('Film', filmSchema);
const Rating  = mongoose.model('Rating', ratingSchema);
const Comment = mongoose.model('Comment', commentSchema);
const Review  = mongoose.model('Review', reviewSchema);
const Action  = mongoose.model('Action', actionSchema);
const Event   = mongoose.model('Event', eventSchema);

/* ============================================================
   БЛОК S2: Конфиг и расчёт технического балла (Синефилиум 2.0)
   ============================================================ */

/* Критерии ВНУТРИ блока усредняются БЕЗ весов (среднее арифметическое) */
const BLOCK_CRITERIA = {
  scenario:   ['plot', 'ideas', 'dialogue'],
  characters: ['depth', 'chemistry', 'functionality'],
  visual:     ['composition', 'cinematography', 'pacing', 'tone'],
  sound:      ['music', 'design', 'narrative'],
  style:      ['originality', 'boldness']
};

/* Веса блоков по жанрам (сумма = 100%) */
const GENRE_PRESETS = {
  drama:        [25, 20, 20, 15, 20],
  action:       [20, 20, 30, 20, 10],
  comedy:       [30, 30, 15, 15, 10],
  horror:       [25, 20, 20, 25, 10],
  scifi_block:  [25, 20, 25, 20, 10],
  scifi_author: [20, 20, 25, 15, 20],
  musical:      [20, 20, 20, 30, 10],
  biopic:       [30, 30, 20, 15,  5],
  hybrid:       null
};

/* Базовые веса «без жанра» */
const DEFAULT_WEIGHTS_ARRAY = [30, 25, 20, 15, 10];

/* Множители формулы комбинированного балла */
const TECHNICAL_WEIGHT = 0.7; // 70% техники
const VIBE_WEIGHT      = 3;   // 30% вайба (перевод 1–10 → 10–100)

const roundTenth = n => Math.round(n * 10) / 10;

/**
 * Технический балл (ТБ) по системе «Синефилиум 2.0».
 * Шаг 1: среднее арифметическое критериев внутри каждого блока (1–10).
 * Шаг 2: ТБ = (Σ блок × вес) / 100 × 10 → 10–100, округление до десятых.
 *
 * @param scores  { scenario: {plot, ideas, dialogue}, ... } — значения 1–10
 * @param weights { scenario, characters, visual, sound, style } — проценты, сумма = 100
 */
function calculateTechnicalScore(scores, weights) {
  const blockAvgs = {};

  for (const [block, criteria] of Object.entries(BLOCK_CRITERIA)) {
    let sum = 0;
    for (const name of criteria) {
      const v = scores?.[block]?.[name];
      if (!Number.isFinite(v) || v < 1 || v > 10) {
        throw new Error(`Некорректная оценка: ${block}.${name} = ${v} (нужно 1–10)`);
      }
      sum += v;
    }
    blockAvgs[block] = sum / criteria.length; // 1–10
  }

  const weightedAvg =
    blockAvgs.scenario   * (weights.scenario   / 100) +
    blockAvgs.characters * (weights.characters / 100) +
    blockAvgs.visual     * (weights.visual     / 100) +
    blockAvgs.sound      * (weights.sound      / 100) +
    blockAvgs.style      * (weights.style      / 100);

  return roundTenth(weightedAvg * 10); // 10–100
}

/* Хелпер: массив весов → объект */
function weightsArrayToObject(arr) {
  return {
    scenario:   arr[0],
    characters: arr[1],
    visual:     arr[2],
    sound:      arr[3],
    style:      arr[4]
  };
}

/* Хелпер: объект весов → массив (для нормализации) */
function weightsObjectToArray(obj) {
  return [
    obj?.scenario   ?? 0,
    obj?.characters ?? 0,
    obj?.visual     ?? 0,
    obj?.sound      ?? 0,
    obj?.style      ?? 0
  ];
}

/* ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===== */
async function addPoints(userId, actorId, type, points, refId = null) {
  const user = await User.findById(userId);
  if (!user) return false;

  await Action.create({ userId, actorId, type, points, refId });
  await User.findByIdAndUpdate(userId, { $inc: { totalPoints: points } });
  return true;
}

async function removePointsByAction(userId, actorId, refId, type) {
  const action = await Action.findOne({ userId, actorId, refId, type });
  if (action) {
    await User.findByIdAndUpdate(userId, { $inc: { totalPoints: -action.points } });
    await action.deleteOne();
    return true;
  }
  return false;
}

async function existsById(model, id) {
  return await model.findById(id) !== null;
}

async function createEvent(type, user, film, filmId, score = null, contentId = null, metadata = {}) {
  try {
    await Event.create({
      type,
      user,
      film: film || '',
      filmId,
      score,
      contentId,
      metadata
    });
  } catch (error) {
    console.error('Ошибка создания события:', error);
  }
}

// ===== ОБНОВЛЕНИЕ ДОСТИЖЕНИЙ =====
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
        null,
        null,
        null,
        { achievements: newAchievements }
      );
    }
  } catch (error) {
    console.error('❌ Ошибка обновления достижений:', error);
  }
}

// ============================================================
// МИДДЛВАРЫ
// ============================================================

const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    req.userId = user._id;
    req.user = user;
    req.isAdmin = user.isAdmin || false;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Неверный токен' });
  }
};

const isAdmin = async (req, res, next) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Доступ только для администратора' });
  next();
};

const validateObjectId = (paramName) => [
  param(paramName).isMongoId().withMessage('Неверный ID')
];

// ============================================================
// АУТЕНТИФИКАЦИЯ
// ============================================================

app.post('/api/auth/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Пароль должен быть минимум 6 символов'),
  body('nickname').notEmpty().isLength({ max: 50 }).withMessage('Никнейм не длиннее 50 символов')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { email, password, nickname } = req.body;
    const existingUser = await User.findOne({ $or: [{ email }, { nickname }] });
    if (existingUser) return res.status(400).json({ error: 'Пользователь уже существует' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword, nickname });
    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user._id, email: user.email, nickname: user.nickname,
        isAdmin: user.isAdmin, totalPoints: user.totalPoints
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
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: 'Неверный email или пароль' });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user._id, email: user.email, nickname: user.nickname,
        isAdmin: user.isAdmin, totalPoints: user.totalPoints
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
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/* === ТОП ПО ВЫБРАННОЙ МЕТРИКЕ === */
app.get('/api/films/top', async (req, res) => {
  try {
    const sort  = req.query.sort || 'technical';
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);

    const sortField =
      sort === 'combined' ? 'averageCombined' :
      sort === 'vibe'     ? 'averageVibe'     :
                            'averageRating';

    const films = await Film.aggregate([
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
          averageRating:   { $avg: '$ratings.technicalScore' },
          averageVibe:     { $avg: '$ratings.vibe' },
          averageCombined: { $avg: '$ratings.combinedScore' },
          votesCount:      { $size: '$ratings' },
          // защита от null при сортировке
          _sortKey: { $ifNull: [{ $avg: `$ratings.${
            sortField === 'averageCombined' ? 'combinedScore' :
            sortField === 'averageVibe'     ? 'vibe' :
                                              'technicalScore'
          }` }, -1] }
        }
      },
      // фильмы без оценок в топ не пускаем
      { $match: { _sortKey: { $gt: 0 } } },
      { $project: { ratings: 0, _sortKey: 0 } },
      // тай-брейкер по количеству оценок и _id, чтобы топ не «дрожал»
      { $sort: { [sortField]: -1, votesCount: -1, _id: 1 } },
      { $limit: limit }
    ]);

    res.json({ films, sort: sortField, limit });
  } catch (error) {
    console.error('Ошибка загрузки топа:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ============================================================
// ФИЛЬМЫ
// ============================================================

/* === БЛОК S4: GET /api/films/:id — с тремя средними (ТБ / Вайб / Комбо) === */
app.get('/api/films/:id', [
  ...validateObjectId('id')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const film = await Film.findById(req.params.id);
    if (!film) return res.status(404).json({ error: 'Фильм не найден' });

    const ratingData = await Rating.aggregate([
      { $match: { filmId: film._id } },
      {
        $group: {
          _id: null,
          avgTechnical: { $avg: '$technicalScore' },
          avgVibe:      { $avg: '$vibe' },
          avgCombined:  { $avg: '$combinedScore' },
          total:        { $sum: 1 }
        }
      }
    ]);

    const avgTechnical = ratingData[0]?.avgTechnical || 0;
    const avgVibe      = ratingData[0]?.avgVibe      || 0;
    const avgCombined  = ratingData[0]?.avgCombined  || 0;
    const votesCount   = ratingData[0]?.total        || 0;

    let userRating = null;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userRating = await Rating.findOne({ filmId: film._id, userId: decoded.userId });
      } catch (e) { /* игнор */ }
    }

    res.json({
      ...film.toObject(),
      averageRating:   roundTenth(avgTechnical),  // ТБ — основной рейтинг
      averageVibe:     roundTenth(avgVibe),       // 💫 средний вайб
      averageCombined: roundTenth(avgCombined),   // ⭐ комбинированный
      votesCount,
      userRating
    });
  } catch (error) {
    console.error('Ошибка загрузки фильма:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ===== ПОИСК ФИЛЬМА ПО НАЗВАНИЮ =====
app.get('/api/films/search-by-title', async (req, res) => {
  try {
    const title = req.query.title;
    if (!title) return res.status(400).json({ error: 'Название фильма не указано' });

    let film = await Film.findOne({ title: title });
    if (!film) film = await Film.findOne({ title: { $regex: new RegExp(title, 'i') } });
    if (!film) return res.status(404).json({ error: 'Фильм не найден' });

    res.json(film);
  } catch (error) {
    console.error('Ошибка поиска фильма по названию:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/* === GET /api/films/:id/ratings — все оценки фильма === */
app.get('/api/films/:id/ratings', async (req, res) => {
  try {
    const ratings = await Rating.find({ filmId: req.params.id })
      .populate('userId', 'nickname avatar isAdmin')
      .select('technicalScore combinedScore vibe textReview likes createdAt genrePreset blockWeights scores')
      .sort({ createdAt: -1 });

    const formattedRatings = ratings.map(r => ({
      rating: {
        _id:            r._id,
        technicalScore: r.technicalScore,
        combinedScore:  r.combinedScore,
        // алиас для обратной совместимости с фронтом
        finalScore:     r.combinedScore,
        vibe:           r.vibe,
        textReview:     r.textReview,
        likes:          r.likes,
        createdAt:      r.createdAt,
        genrePreset:    r.genrePreset,
        blockWeights:   r.blockWeights,
        scores:         r.scores
      },
      user: {
        _id:     r.userId?._id,
        nickname: r.userId?.nickname || 'Пользователь',
        avatar:  r.userId?.avatar,
        isAdmin: r.userId?.isAdmin || false
      }
    }));

    res.json(formattedRatings);
  } catch (err) {
    console.error('Ошибка загрузки оценок:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/* === Лёгкий список пользователей с их оценками === */
app.get('/api/films/:id/users', async (req, res) => {
  try {
    const filmId = req.params.id;

    const ratings = await Rating.find({ filmId })
      .populate('userId', 'nickname isAdmin')
      .select('combinedScore technicalScore')
      .lean();

    const result = ratings.map(r => ({
      user: {
        _id:     r.userId?._id,
        nickname: r.userId?.nickname || 'Пользователь',
        isAdmin: r.userId?.isAdmin || false
      },
      rating: {
        _id:        r._id,
        finalScore: r.combinedScore ?? r.technicalScore ?? 0,
        technicalScore: r.technicalScore,
        combinedScore:  r.combinedScore
      }
    }));

    res.json(result);
  } catch (err) {
    console.error('Ошибка загрузки пользователей фильма:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

/* === БЛОК S6: GET /api/films — сортировка по ТБ / вайбу / комбо === */
app.get('/api/films', async (req, res) => {
  try {
    const sort  = req.query.sort || 'technical';
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    let sortField;
    switch (sort) {
      case 'combined': sortField = 'averageCombined'; break;
      case 'vibe':     sortField = 'averageVibe';     break;
      case 'technical':
      default:         sortField = 'averageRating';   break;
    }

    const films = await Film.aggregate([
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
          averageRating:   { $avg: '$ratings.technicalScore' },
          averageVibe:     { $avg: '$ratings.vibe' },
          averageCombined: { $avg: '$ratings.combinedScore' },
          votesCount:      { $size: '$ratings' }
        }
      },
      { $project: { ratings: 0 } },
      { $sort: { [sortField]: -1, _id: 1 } }, 
      { $skip: skip },
      { $limit: limit }
    ]);

    const total = await Film.countDocuments();

    res.json({
      films,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      },
      sort: sortField
    });
  } catch (error) {
    console.error('Ошибка загрузки фильмов:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ============================================================
// КОММЕНТАРИИ
// ============================================================

app.post('/api/comments', [
  body('filmId').isMongoId().withMessage('Некорректный ID фильма'),
  body('text').notEmpty().isLength({ max: 1000 }).withMessage('Текст не длиннее 1000 символов'),
  body('parentId').optional().isMongoId().withMessage('Некорректный ID родительского комментария')
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { filmId, text, parentId } = req.body;

    const film = await Film.findById(filmId);
    if (!film) return res.status(404).json({ error: 'Фильм не найден' });

    if (parentId) {
      const parentExists = await existsById(Comment, parentId);
      if (!parentExists) return res.status(404).json({ error: 'Родительский комментарий не найден' });
    }

    const comment = new Comment({ userId: req.userId, filmId, text, parentId, status: 'pending' });
    await comment.save();

    const commentWithUser = await Comment.findById(comment._id).populate('userId', 'nickname isAdmin');
    res.json(commentWithUser);
  } catch (error) {
    console.error('Ошибка добавления комментария:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/comments/:filmId', [
  ...validateObjectId('filmId')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    let isAdmin = false;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId);
        isAdmin = user?.isAdmin || false;
      } catch (e) { /* игнор */ }
    }

    const statusFilter = isAdmin ? {} : { status: 'approved' };

    const comments = await Comment.find({
      filmId: req.params.filmId,
      parentId: null,
      ...statusFilter
    })
      .populate('userId', 'nickname isAdmin')
      .sort({ createdAt: -1 });

    const commentIds = comments.map(c => c._id);
    const replies = await Comment.find({
      parentId: { $in: commentIds },
      ...statusFilter
    })
      .populate('userId', 'nickname isAdmin')
      .sort({ createdAt: 1 });

    const commentsWithReplies = comments.map(c => ({
      ...c.toObject(),
      replies: replies.filter(r => r.parentId.toString() === c._id.toString())
    }));

    res.json(commentsWithReplies);
  } catch (error) {
    console.error('Ошибка загрузки комментариев:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/comments/:id/like', [
  ...validateObjectId('id')
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

    if (comment.userId.equals(req.userId)) {
      return res.status(400).json({ error: 'Нельзя лайкать себя' });
    }
    if (comment.likes.includes(req.userId)) {
      return res.status(400).json({ error: 'Вы уже лайкнули этот комментарий' });
    }

    comment.likes.push(req.userId);
    await comment.save();

    const points = req.isAdmin ? 3 : 1;
    await addPoints(comment.userId, req.userId, 'like', points, comment._id);
    await updateAchievements(comment.userId);

    res.json({ liked: true, likes: comment.likes.length });
  } catch (error) {
    console.error('Ошибка лайка комментария:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ============================================================
// РЕЦЕНЗИИ
// ============================================================

app.post('/api/reviews', [
  body('filmId').isMongoId().withMessage('Некорректный ID фильма'),
  body('ratingId').isMongoId().withMessage('Некорректный ID оценки'),
  body('title').notEmpty().isLength({ max: 100 }).withMessage('Заголовок не длиннее 100 символов'),
  body('text').notEmpty().isLength({ max: 5000 }).withMessage('Текст не длиннее 5000 символов')
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { filmId, ratingId, title, text } = req.body;

    const film = await Film.findById(filmId);
    if (!film) return res.status(404).json({ error: 'Фильм не найден' });

    const rating = await Rating.findOne({ _id: ratingId, userId: req.userId });
    if (!rating) return res.status(403).json({ error: 'Вы не можете использовать чужую оценку для рецензии' });

    const existing = await Review.findOne({ userId: req.userId, filmId });
    if (existing) return res.status(400).json({ error: 'Вы уже написали рецензию на этот фильм' });

    const review = new Review({ userId: req.userId, filmId, ratingId, title, text, status: 'pending' });
    await review.save();

    const reviewWithUser = await Review.findById(review._id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster');
    res.json(reviewWithUser);
  } catch (error) {
    console.error('Ошибка добавления рецензии:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/reviews/:filmId', [
  ...validateObjectId('filmId')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    let isAdmin = false;
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId);
        isAdmin = user?.isAdmin || false;
      } catch (e) { /* игнор */ }
    }

    const statusFilter = isAdmin ? {} : { status: 'approved' };

    const reviews = await Review.find({
      filmId: req.params.filmId,
      ...statusFilter
    })
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster')
      .sort({ createdAt: -1 });

    res.json(reviews);
  } catch (error) {
    console.error('Ошибка загрузки рецензий:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/reviews/details/:id', [
  ...validateObjectId('id')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const review = await Review.findById(req.params.id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster description director actors genres year')
      .populate('ratingId');
    if (!review) return res.status(404).json({ error: 'Рецензия не найдена' });
    res.json(review);
  } catch (error) {
    console.error('Ошибка загрузки рецензии:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/reviews/:id/like', [
  ...validateObjectId('id')
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Рецензия не найдена' });

    if (review.userId.equals(req.userId)) {
      return res.status(400).json({ error: 'Нельзя лайкать себя' });
    }
    if (review.likes.includes(req.userId)) {
      return res.status(400).json({ error: 'Вы уже лайкнули эту рецензию' });
    }

    review.likes.push(req.userId);
    await review.save();

    const points = req.isAdmin ? 20 : 5;
    await addPoints(review.userId, req.userId, 'like', points, review._id);
    await updateAchievements(review.userId);

    res.json({ liked: true, likes: review.likes.length });
  } catch (error) {
    console.error('Ошибка лайка рецензии:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ============================================================
// ТОП ПОЛЬЗОВАТЕЛЕЙ
// ============================================================

app.get('/api/top/users', async (req, res) => {
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
            { $match: { $expr: { $and: [ { $eq: ['$userId', '$$userId'] }, { $eq: ['$type', 'like'] } ] } } }
          ],
          as: 'likesReceived'
        }
      },
      {
        $addFields: {
          ratingsCount:   { $size: '$ratings' },
          reviewsCount:   { $size: '$reviews' },
          commentsCount:  { $size: '$comments' },
          likesReceived:  { $size: '$likesReceived' }
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

// ============================================================
// ОЦЕНКИ (Синефилиум 2.0)
// ============================================================

/* === БЛОК S3: POST /api/ratings === */
app.post('/api/ratings', authenticate, async (req, res) => {
  try {
    const { filmId, scores, vibe, genrePreset, blockWeights, textReview } = req.body;

    // --- filmId ---
    if (!filmId || !mongoose.Types.ObjectId.isValid(filmId)) {
      return res.status(400).json({ message: 'Некорректный filmId' });
    }

    // --- scores ---
    if (!scores || typeof scores !== 'object') {
      return res.status(400).json({ message: 'scores обязателен и должен быть объектом' });
    }

    for (const [block, crits] of Object.entries(BLOCK_CRITERIA)) {
      if (!scores[block] || typeof scores[block] !== 'object') {
        return res.status(400).json({ message: `Блок ${block} отсутствует или некорректен` });
      }
      for (const crit of crits) {
        const val = scores[block][crit];
        if (!Number.isFinite(val) || val < 1 || val > 10) {
          return res.status(400).json({
            message: `Некорректное значение ${block}.${crit} (нужно 1–10)`
          });
        }
      }
    }

    // --- vibe ---
    if (!Number.isFinite(vibe) || vibe < 1 || vibe > 10) {
      return res.status(400).json({ message: 'vibe должен быть от 1 до 10' });
    }

    // --- веса ---
    let weightsArray;

    if (genrePreset && GENRE_PRESETS[genrePreset] && genrePreset !== 'hybrid') {
      weightsArray = GENRE_PRESETS[genrePreset];
    } else if (Array.isArray(blockWeights) && blockWeights.length === 5) {
      const allValid = blockWeights.every(w => Number.isFinite(w) && w >= 0 && w <= 100);
      const sum = blockWeights.reduce((a, b) => a + b, 0);
      if (!allValid || sum !== 100) {
        return res.status(400).json({ message: 'Сумма весов блоков должна быть строго 100' });
      }
      weightsArray = blockWeights;
    } else if (blockWeights && typeof blockWeights === 'object') {
      const arr = weightsObjectToArray(blockWeights);
      const allValid = arr.every(w => Number.isFinite(w) && w >= 0 && w <= 100);
      const sum = arr.reduce((a, b) => a + b, 0);
      if (!allValid || sum !== 100) {
        return res.status(400).json({ message: 'Сумма весов блоков должна быть строго 100' });
      }
      weightsArray = arr;
    } else {
      weightsArray = DEFAULT_WEIGHTS_ARRAY;
    }

    const weights = weightsArrayToObject(weightsArray);

    // --- расчёт ТБ и комбинированного ---
    let technicalScore;
    try {
      technicalScore = calculateTechnicalScore(scores, weights);
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }
    const combinedScore = roundTenth(technicalScore * TECHNICAL_WEIGHT + vibe * VIBE_WEIGHT);

    // --- фильм ---
    const film = await Film.findById(filmId);
    if (!film) return res.status(404).json({ error: 'Фильм не найден' });

    // --- есть ли уже оценка ---
    const existingRating = await Rating.findOne({ userId: req.userId, filmId });
    const isNew = !existingRating;

    // --- сохранение ---
    const rating = await Rating.findOneAndUpdate(
      { userId: req.userId, filmId },
      {
        $set: {
          genrePreset: genrePreset || null,
          blockWeights: weights,
          scores,
          vibe,
          technicalScore,
          combinedScore,
          textReview: textReview || ''
        }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    // --- награды при первой оценке ---
    if (isNew) {
      const points = req.isAdmin ? 20 : 10;
      await addPoints(req.userId, req.userId, 'rating', points, rating._id);

      const user = await User.findById(req.userId);
      const nickname = user?.nickname || 'Пользователь';

      await createEvent(
        'rating',
        nickname,
        film.title,
        film._id,
        rating.combinedScore,
        rating._id,
        {
          technicalScore: rating.technicalScore,
          combinedScore:  rating.combinedScore,
          vibe:           rating.vibe
        }
      );

      if (typeof updateAchievements === 'function') {
        await updateAchievements(req.userId);
      }
    }

    res.status(201).json({
      rating,
      technicalScore,
      combinedScore,
      vibe,
      finalScore: combinedScore // алиас для обратной совместимости
    });
  } catch (err) {
    console.error('Ошибка сохранения оценки:', err);
    res.status(500).json({ message: 'Ошибка сервера' });
  }
});

app.get('/api/ratings/user', authenticate, async (req, res) => {
  try {
    const ratings = await Rating.find({ userId: req.userId })
      .populate('filmId')
      .sort({ createdAt: -1 });
    res.json(ratings);
  } catch (error) {
    console.error('Ошибка получения оценок:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/ratings/:id/details', [
  ...validateObjectId('id')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const rating = await Rating.findById(req.params.id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title poster');
    if (!rating) return res.status(404).json({ error: 'Оценка не найдена' });
    res.json(rating);
  } catch (error) {
    console.error('Ошибка загрузки деталей:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ============================================================
// АДМИН-ПАНЕЛЬ
// ============================================================

app.post('/api/admin/make', [
  body('secretKey').notEmpty().withMessage('Введите секретный ключ')
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { secretKey } = req.body;
    const adminSecret = process.env.ADMIN_SECRET_KEY;
    if (!adminSecret) {
      return res.status(500).json({ error: 'Секретный ключ не настроен на сервере' });
    }
    if (secretKey !== adminSecret) {
      return res.status(403).json({ error: 'Неверный секретный ключ' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    if (user.isAdmin) {
      return res.json({ message: 'Вы уже являетесь администратором', isAdmin: true });
    }

    user.isAdmin = true;
    await user.save();

    await addPoints(req.userId, req.userId, 'admin_bonus', 100, user._id);
    await updateAchievements(req.userId);

    res.json({
      message: 'Поздравляю! Вы теперь администратор! 👑',
      isAdmin: true,
      totalPoints: user.totalPoints
    });
  } catch (error) {
    console.error('Ошибка активации админа:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ============================================================
// TMDB ИНТЕГРАЦИЯ
// ============================================================

app.get('/api/tmdb/search', async (req, res) => {
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

app.post('/api/films/import', [
  body('tmdbId').isInt({ min: 1 }).withMessage('Некорректный ID фильма')
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { tmdbId } = req.body;
    const apiKey = process.env.TMDB_API_KEY;

    const [ruResponse, enResponse] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=ru-RU&append_to_response=credits,videos`),
      fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=en-US`)
    ]);

    if (!ruResponse.ok) throw new Error(`TMDB API error (ru): ${ruResponse.status}`);

    const filmData = await ruResponse.json();
    const enData = enResponse.ok ? await enResponse.json() : {};

    if (!filmData.title) return res.status(404).json({ error: 'Фильм не найден в TMDB' });

    const posterPath = filmData.poster_path || enData.poster_path || null;

    const filmDataForSave = {
      tmdbId: filmData.id,
      title: filmData.title,
      year: filmData.release_date ? new Date(filmData.release_date).getFullYear() : null,
      poster: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : '',
      description: (filmData.overview || enData.overview || '').slice(0, 1000),
      genres: filmData.genres?.map(g => g.name) || [],
      director: filmData.credits?.crew?.find(c => c.job === 'Director')?.name || 'Неизвестен',
      actors: filmData.credits?.cast?.slice(0, 5).map(a => a.name) || [],
      trailer: filmData.videos?.results?.find(v => v.type === 'Trailer')?.key
        ? `https://www.youtube.com/embed/${filmData.videos.results.find(v => v.type === 'Trailer').key}`
        : '',
      createdBy: req.userId
    };

    let film = await Film.findOne({ tmdbId: filmData.id });

    if (!film) {
      film = new Film(filmDataForSave);
      await film.save();
    } else {
      await Film.findOneAndUpdate({ tmdbId: filmData.id }, filmDataForSave);
      const updatedFilm = await Film.findOne({ tmdbId: filmData.id });
      return res.status(200).json({
        film: updatedFilm,
        alreadyExists: true,
        message: 'Фильм уже есть в каталоге, данные обновлены'
      });
    }

    const points = req.isAdmin ? 5 : 2;
    await addPoints(req.userId, req.userId, 'import', points, film._id);
    await createEvent('film_add', req.user.nickname, film.title, film._id);
    await updateAchievements(req.userId);

    res.status(201).json({
      film,
      alreadyExists: false,
      message: 'Фильм успешно добавлен'
    });
  } catch (error) {
    console.error('Ошибка импорта фильма:', error);
    res.status(500).json({ error: 'Ошибка импорта фильма' });
  }
});

// ============================================================
// ПРОКСИ ДЛЯ ПОСТЕРОВ TMDB
// ============================================================
app.get('/api/poster/*', async (req, res) => {
  const path = req.params[0];
  if (!path || path.includes('..')) return res.status(400).end();

  try {
    const r = await fetch(`https://image.tmdb.org/t/p/${path}`);
    if (!r.ok) return res.status(404).end();

    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');

    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error('Ошибка прокси постера:', err);
    res.status(502).end();
  }
});

// ============================================================
// ПОЛЬЗОВАТЕЛИ
// ============================================================

app.get('/api/users/:id', [
  ...validateObjectId('id')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const userId = req.params.id;
    const user = await User.findById(userId).select('-password');
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const ratings  = await Rating.find({ userId }).populate('filmId', 'title poster year');
    const reviews  = await Review.find({ userId }).populate('filmId', 'title poster');
    const comments = await Comment.find({ userId }).populate('filmId', 'title');

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
        isAdmin: user.isAdmin,
        totalPoints: user.totalPoints,
        achievements: user.achievements || [],
        email: isOwnProfile ? user.email : undefined
      },
      /* === БЛОК S5: Профиль пользователя === */
      ratings: ratings.map(r => ({
        id: r._id,
        film: r.filmId,
        technicalScore: r.technicalScore,
        combinedScore:  r.combinedScore,
        vibe:           r.vibe,
        genrePreset:    r.genrePreset,
        blockWeights:   r.blockWeights,
        scores:         r.scores,
        textReview:     r.textReview,
        createdAt:      r.createdAt
      })),
      reviews: reviews.map(r => ({
        id: r._id,
        film: r.filmId,
        title: r.title,
        text: r.text,
        likes: r.likes.length
      })),
      comments: comments.map(c => ({
        id: c._id,
        film: c.filmId,
        text: c.text
      }))
    });
  } catch (error) {
    console.error('Ошибка загрузки профиля:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/users/:id/achievements', [
  ...validateObjectId('id')
], async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId).select('achievements nickname');
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

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

    res.json({
      nickname: user.nickname,
      earned: user.achievements || [],
      possible: allPossible,
      progress: {
        ratings: ratingsCount,
        reviews: reviewsCount,
        comments: commentsCount
      }
    });
  } catch (error) {
    console.error('Ошибка получения достижений:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ============================================================
// МОДЕРАЦИЯ (АДМИН-ПАНЕЛЬ)
// ============================================================

app.get('/api/admin/pending/comments', authenticate, isAdmin, async (req, res) => {
  try {
    const comments = await Comment.find({ status: 'pending' })
      .populate('userId', 'nickname')
      .populate('filmId', 'title');
    res.json(comments);
  } catch (error) {
    console.error('Ошибка загрузки комментариев на модерацию:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/admin/pending/reviews', authenticate, isAdmin, async (req, res) => {
  try {
    const reviews = await Review.find({ status: 'pending' })
      .populate('userId', 'nickname')
      .populate('filmId', 'title');
    res.json(reviews);
  } catch (error) {
    console.error('Ошибка загрузки рецензий на модерацию:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.put('/api/admin/comments/:id/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const comment = await Comment.findByIdAndUpdate(
      req.params.id,
      { status: 'approved' },
      { new: true }
    ).populate('userId', 'nickname isAdmin').populate('filmId', 'title');

    if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

    const authorIsAdmin = comment.userId?.isAdmin || false;
    const authorPoints = authorIsAdmin ? 10 : 2;
    await addPoints(comment.userId._id, comment.userId._id, 'comment', authorPoints, comment._id);
    await createEvent('comment', comment.userId.nickname, comment.filmId.title, comment.filmId._id, null, comment._id);

    await updateAchievements(comment.userId._id);

    res.json(comment);
  } catch (error) {
    console.error('Ошибка одобрения комментария:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.put('/api/admin/comments/:id/reject', authenticate, isAdmin, async (req, res) => {
  try {
    const comment = await Comment.findByIdAndUpdate(
      req.params.id,
      { status: 'rejected' },
      { new: true }
    ).populate('userId', 'nickname');
    if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });
    res.json(comment);
  } catch (error) {
    console.error('Ошибка отклонения комментария:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.put('/api/admin/reviews/:id/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { status: 'approved' },
      { new: true }
    ).populate('userId', 'nickname isAdmin').populate('filmId', 'title');

    if (!review) return res.status(404).json({ error: 'Рецензия не найдена' });

    const authorIsAdmin = review.userId?.isAdmin || false;
    const authorPoints = authorIsAdmin ? 50 : 30;
    await addPoints(review.userId._id, review.userId._id, 'review', authorPoints, review._id);
    await createEvent('review', review.userId.nickname, review.filmId.title, review.filmId._id, null, review._id);

    await updateAchievements(review.userId._id);

    res.json(review);
  } catch (error) {
    console.error('Ошибка одобрения рецензии:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.put('/api/admin/reviews/:id/reject', authenticate, isAdmin, async (req, res) => {
  try {
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { status: 'rejected' },
      { new: true }
    ).populate('userId', 'nickname').populate('filmId', 'title');
    if (!review) return res.status(404).json({ error: 'Рецензия не найдена' });
    res.json(review);
  } catch (error) {
    console.error('Ошибка отклонения рецензии:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ============================================================
// СОБЫТИЯ (Лента активности)
// ============================================================

app.get('/api/events', async (req, res) => {
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

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================

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
