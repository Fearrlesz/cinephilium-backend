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
  email: { type: String, unique: true, required: true, maxlength: 100 },
  password: { type: String, required: true },
  nickname: { type: String, unique: true, required: true, maxlength: 50 },
  avatar: { type: String, default: '' },
  isAdmin: { type: Boolean, default: false },
  totalPoints: { type: Number, default: 0 },
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

// ----- ОЦЕНКИ -----
const ratingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  base1: { type: [Number], required: true, validate: v => v.length === 5 && v.every(n => n >= 1 && n <= 10) },
  base2: { type: [Number], required: true, validate: v => v.length === 5 && v.every(n => n >= 1 && n <= 10) },
  base3: { type: [Number], required: true, validate: v => v.length === 5 && v.every(n => n >= 1 && n <= 10) },
  base4: { type: [Number], required: true, validate: v => v.length === 5 && v.every(n => n >= 1 && n <= 10) },
  subjectiveM: { type: Number, required: true, min: 1, max: 10 },
  technicalScore: Number,
  finalScore: Number,
  textReview: { type: String, maxlength: 2000 },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ----- КОММЕНТАРИИ -----
const commentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  text: { type: String, required: true, maxlength: 1000 },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
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
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// ----- ДЕЙСТВИЯ (для топа) -----
const actionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },          // владелец контента (получатель очков)
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },        // кто совершил действие
  type: { type: String, enum: ['rating', 'review', 'comment', 'like', 'import', 'admin_bonus'], required: true },
  points: { type: Number, required: true },
  refId: { type: mongoose.Schema.Types.ObjectId },
  createdAt: { type: Date, default: Date.now }
});

// ===== ИНДЕКСЫ =====
ratingSchema.index({ userId: 1, filmId: 1 }, { unique: true });
ratingSchema.index({ filmId: 1 });
ratingSchema.index({ userId: 1 });
filmSchema.index({ title: 'text' });
commentSchema.index({ filmId: 1, createdAt: -1 });
actionSchema.index({ userId: 1, actorId: 1, refId: 1, type: 1 });

const User = mongoose.model('User', userSchema);
const Film = mongoose.model('Film', filmSchema);
const Rating = mongoose.model('Rating', ratingSchema);
const Comment = mongoose.model('Comment', commentSchema);
const Review = mongoose.model('Review', reviewSchema);
const Action = mongoose.model('Action', actionSchema);

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

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

async function addPoints(userId, actorId, type, points, refId = null) {
  await Action.create({ userId, actorId, type, points, refId });
  await User.findByIdAndUpdate(userId, { $inc: { totalPoints: points } });
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
      user: { id: user._id, email: user.email, nickname: user.nickname, isAdmin: user.isAdmin, totalPoints: user.totalPoints }
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
      user: { id: user._id, email: user.email, nickname: user.nickname, isAdmin: user.isAdmin, totalPoints: user.totalPoints }
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

// ============================================================
// ФИЛЬМЫ
// ============================================================

app.get('/api/films', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  try {
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
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const film = await Film.findById(req.params.id);
    if (!film) return res.status(404).json({ error: 'Фильм не найден' });

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

    const filmExists = await existsById(Film, filmId);
    if (!filmExists) return res.status(404).json({ error: 'Фильм не найден' });

    if (parentId) {
      const parentExists = await existsById(Comment, parentId);
      if (!parentExists) return res.status(404).json({ error: 'Родительский комментарий не найден' });
    }

    const comment = new Comment({ userId: req.userId, filmId, text, parentId });
    await comment.save();

    const points = req.isAdmin ? 10 : 2;
    await addPoints(req.userId, req.userId, 'comment', points, comment._id);

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
    const comments = await Comment.find({ filmId: req.params.filmId, parentId: null })
      .populate('userId', 'nickname isAdmin')
      .sort({ createdAt: -1 });

    const commentIds = comments.map(c => c._id);
    const replies = await Comment.find({ parentId: { $in: commentIds } })
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

    const likeIndex = comment.likes.indexOf(req.userId);
    if (likeIndex > -1) {
      comment.likes.splice(likeIndex, 1);
      await comment.save();
      await removePointsByAction(comment.userId, req.userId, comment._id, 'like');
      res.json({ liked: false, likes: comment.likes.length });
    } else {
      comment.likes.push(req.userId);
      await comment.save();
      const points = req.isAdmin ? 3 : 1;
      await addPoints(comment.userId, req.userId, 'like', points, comment._id);
      res.json({ liked: true, likes: comment.likes.length });
    }
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

    const filmExists = await existsById(Film, filmId);
    if (!filmExists) return res.status(404).json({ error: 'Фильм не найден' });

    const rating = await Rating.findOne({ _id: ratingId, userId: req.userId });
    if (!rating) return res.status(403).json({ error: 'Вы не можете использовать чужую оценку для рецензии' });

    const existing = await Review.findOne({ userId: req.userId, filmId });
    if (existing) return res.status(400).json({ error: 'Вы уже написали рецензию на этот фильм' });

    const review = new Review({ userId: req.userId, filmId, ratingId, title, text });
    await review.save();

    const points = req.isAdmin ? 50 : 30;
    await addPoints(req.userId, req.userId, 'review', points, review._id);

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
    const reviews = await Review.find({ filmId: req.params.filmId })
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

    const likeIndex = review.likes.indexOf(req.userId);
    if (likeIndex > -1) {
      review.likes.splice(likeIndex, 1);
      await review.save();
      await removePointsByAction(review.userId, req.userId, review._id, 'like');
      res.json({ liked: false, likes: review.likes.length });
    } else {
      review.likes.push(req.userId);
      await review.save();
      const points = req.isAdmin ? 20 : 5;
      await addPoints(review.userId, req.userId, 'like', points, review._id);
      res.json({ liked: true, likes: review.likes.length });
    }
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
      {
        $lookup: {
          from: 'ratings',
          localField: '_id',
          foreignField: 'userId',
          as: 'ratings'
        }
      },
      {
        $lookup: {
          from: 'reviews',
          localField: '_id',
          foreignField: 'userId',
          as: 'reviews'
        }
      },
      {
        $lookup: {
          from: 'comments',
          localField: '_id',
          foreignField: 'userId',
          as: 'comments'
        }
      },
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
          ratingsCount: { $size: '$ratings' },
          reviewsCount: { $size: '$reviews' },
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

// ============================================================
// ОЦЕНКИ
// ============================================================

app.post('/api/ratings', [
  body('filmId').isMongoId().withMessage('Некорректный ID фильма'),
  body('base1').isArray({ min: 5, max: 5 }).custom(v => v.every(n => n >= 1 && n <= 10)),
  body('base2').isArray({ min: 5, max: 5 }).custom(v => v.every(n => n >= 1 && n <= 10)),
  body('base3').isArray({ min: 5, max: 5 }).custom(v => v.every(n => n >= 1 && n <= 10)),
  body('base4').isArray({ min: 5, max: 5 }).custom(v => v.every(n => n >= 1 && n <= 10)),
  body('subjectiveM').isInt({ min: 1, max: 10 })
], authenticate, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { filmId, base1, base2, base3, base4, subjectiveM, textReview } = req.body;
    const film = await Film.findById(filmId);
    if (!film) return res.status(404).json({ error: 'Фильм не найден' });

    const { technicalScore, finalScore } = calculateRating(base1, base2, base3, base4, subjectiveM);

    let rating = await Rating.findOne({ userId: req.userId, filmId });
    let isNew = false;

    if (rating) {
      rating.base1 = base1;
      rating.base2 = base2;
      rating.base3 = base3;
      rating.base4 = base4;
      rating.subjectiveM = subjectiveM;
      rating.technicalScore = technicalScore;
      rating.finalScore = finalScore;
      rating.textReview = textReview || '';
      rating.updatedAt = new Date();
      await rating.save();
    } else {
      rating = new Rating({
        userId: req.userId,
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
      isNew = true;
    }

    if (isNew) {
      const points = req.isAdmin ? 20 : 10;
      await addPoints(req.userId, req.userId, 'rating', points, rating._id);
    }

    res.json({ rating, technicalScore, finalScore });
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
    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status}`);
    }
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
    const filmResponse = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=ru-RU&append_to_response=credits,videos`
    );
    if (!filmResponse.ok) {
      throw new Error(`TMDB API error: ${filmResponse.status}`);
    }
    const filmData = await filmResponse.json();
    if (!filmData.title) return res.status(404).json({ error: 'Фильм не найден в TMDB' });

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

    let film = await Film.findOne({ tmdbId: filmData.id });
    let isNew = false;

    if (!film) {
      film = new Film(filmDataForSave);
      await film.save();
      isNew = true;
    } else {
      await Film.findOneAndUpdate({ tmdbId: filmData.id }, filmDataForSave);
    }

    if (isNew) {
      const points = req.isAdmin ? 5 : 2;
      await addPoints(req.userId, req.userId, 'import', points, film._id);
    }

    res.json(film);
  } catch (error) {
    console.error('Ошибка импорта фильма:', error);
    res.status(500).json({ error: 'Ошибка импорта фильма' });
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
    
    const ratings = await Rating.find({ userId }).populate('filmId', 'title poster year');
    const reviews = await Review.find({ userId }).populate('filmId', 'title poster');
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

// ============================================================
// МОДЕРАЦИЯ (АДМИН-ПАНЕЛЬ)
// ============================================================

// ----- Получить комментарии на модерации -----
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

// ----- Получить рецензии на модерации -----
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

// ----- Одобрить комментарий -----
app.put('/api/admin/comments/:id/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const comment = await Comment.findByIdAndUpdate(
      req.params.id,
      { status: 'approved' },
      { new: true }
    ).populate('userId', 'nickname');
    if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });
    res.json(comment);
  } catch (error) {
    console.error('Ошибка одобрения комментария:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ----- Отклонить комментарий -----
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

// ----- Одобрить рецензию -----
app.put('/api/admin/reviews/:id/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { status: 'approved' },
      { new: true }
    ).populate('userId', 'nickname').populate('filmId', 'title');
    if (!review) return res.status(404).json({ error: 'Рецензия не найдена' });
    res.json(review);
  } catch (error) {
    console.error('Ошибка одобрения рецензии:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ----- Отклонить рецензию -----
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
