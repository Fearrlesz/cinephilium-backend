const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User     = require('../models/User');
const { authLimiter } = require('../middleware/security');
const { authenticate } = require('../middleware/auth');
const { EXCLUSIVE_NICKNAME } = require('../config/env');

const router = express.Router();

// POST /api/auth/register
router.post('/register', authLimiter, [
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

// POST /api/auth/login
router.post('/login', authLimiter, [
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

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    const isExclusive = user.nickname === EXCLUSIVE_NICKNAME;
    res.json({ ...user.toObject(), isExclusive });
  } catch {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

module.exports = router;
