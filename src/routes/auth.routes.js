const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body } = require('express-validator');
const User     = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { EXCLUSIVE_NICKNAME } = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const { UnauthorizedError, ConflictError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// POST /api/auth/register
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Пароль должен быть минимум 6 символов'),
  body('nickname').notEmpty().isLength({ max: 50 }).withMessage('Никнейм не длиннее 50 символов')
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const { email, password, nickname } = req.body;

    const existingUser = await User.findOne({ $or: [{ email }, { nickname }] });
    if (existingUser) throw new ConflictError('Пользователь уже существует');

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
    throw error;
  }
}));

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) throw new UnauthorizedError('Неверный email или пароль');

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) throw new UnauthorizedError('Неверный email или пароль');

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user._id, email: user.email, nickname: user.nickname,
        isAdmin: user.isAdmin, totalPoints: user.totalPoints
      }
    });
  } catch (error) {
    throw error;
  }
}));

// GET /api/auth/me
router.get('/me', authenticate, asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.userId).select('-password');
  const isExclusive = user.nickname === EXCLUSIVE_NICKNAME;
  res.json({ ...user.toObject(), isExclusive });
}));

module.exports = router;
