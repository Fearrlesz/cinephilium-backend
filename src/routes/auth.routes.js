const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body } = require('express-validator');
const User     = require('../models/User');
const { authLimiter } = require('../middleware/security');
const { authenticate } = require('../middleware/auth');
const {
  EXCLUSIVE_NICKNAME,
  EMAIL_CODE_TTL_MIN,
  EMAIL_RESEND_COOLDOWN_SEC,
  EMAIL_RESEND_MAX_PER_HOUR
} = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const { UnauthorizedError, ConflictError, AppError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');
const { generateNumericCode, generateResetToken, hashToken } = require('../utils/tokens');
const mailer = require('../services/mailer');

const router = express.Router();

const verificationMessage = 'Проверьте почту для подтверждения';

function publicUser(user) {
  return {
    id: user._id,
    email: user.email,
    nickname: user.nickname,
    emailVerified: user.emailVerified
  };
}

function issueJwt(user) {
  return jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function dispatchEmail(send) {
  try {
    Promise.resolve(send()).catch(() => {});
  } catch {}
}

function checkResendLimit(user, now) {
  const verification = user.emailVerification;
  const cooldownMs = EMAIL_RESEND_COOLDOWN_SEC * 1000;
  if (verification?.sentAt) {
    const retryAfter = Math.ceil((verification.sentAt.getTime() + cooldownMs - now.getTime()) / 1000);
    if (retryAfter > 0) {
      throw new AppError('RESEND_COOLDOWN', 'Повторная отправка пока недоступна', 429, { retryAfter });
    }
  }

  const recentSends = (verification?.resendHistory || [])
    .filter(sentAt => now.getTime() - new Date(sentAt).getTime() < 60 * 60 * 1000);
  if (recentSends.length >= EMAIL_RESEND_MAX_PER_HOUR) {
    throw new AppError('RESEND_LIMIT', 'Превышен лимит отправки кодов', 429);
  }
}

function updateVerification(user, now) {
  const previousHistory = (user.emailVerification?.resendHistory || [])
    .filter(sentAt => now.getTime() - new Date(sentAt).getTime() < 60 * 60 * 1000);
  const code = generateNumericCode();
  user.emailVerification = {
    codeHash: hashToken(code),
    expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MIN * 60 * 1000),
    sentAt: now,
    attempts: 0,
    resendHistory: [...previousHistory, now]
  };
  dispatchEmail(() => mailer.sendVerificationCode(user.email, code));
}

// POST /api/auth/register
router.post('/register', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Пароль должен быть минимум 8 символов'),
  body('nickname').notEmpty().isLength({ max: 50 }).withMessage('Никнейм не длиннее 50 символов')
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const { email, password, nickname } = req.body;
  const existingEmail = await User.findOne({ email });
  if (existingEmail) {
    if (existingEmail.emailVerified) throw new ConflictError('Пользователь уже существует');

    const now = new Date();
    const sentAt = existingEmail.emailVerification?.sentAt;
    const retryAfter = sentAt
      ? Math.ceil((sentAt.getTime() + EMAIL_RESEND_COOLDOWN_SEC * 1000 - now.getTime()) / 1000)
      : 0;
    if (retryAfter <= 0) {
      checkResendLimit(existingEmail, now);
      updateVerification(existingEmail, now);
      await existingEmail.save();
    }
    return res.status(200).json({ user: publicUser(existingEmail), message: verificationMessage });
  }

  const existingNickname = await User.findOne({ nickname });
  if (existingNickname) throw new ConflictError('Пользователь уже существует');

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = new User({ email, password: hashedPassword, nickname, emailVerified: false });
  updateVerification(user, new Date());
  await user.save();

  return res.status(201).json({ user: publicUser(user), message: verificationMessage });
}));

// POST /api/auth/verify-email
router.post('/verify-email', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('code').matches(/^\d{6}$/).withMessage('Код должен состоять из 6 цифр')
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const user = await User.findOne({ email: req.body.email });
  if (!user) throw new AppError('INVALID_CODE', 'Неверный код подтверждения', 400);
  if (user.emailVerified) return res.json({ message: 'Email уже подтверждён' });

  const verification = user.emailVerification;
  const now = new Date();
  if (!verification || !verification.expiresAt || verification.expiresAt < now) {
    throw new AppError('CODE_EXPIRED', 'Код подтверждения истёк', 400);
  }
  if (verification.attempts >= 5) {
    throw new AppError('TOO_MANY_ATTEMPTS', 'Слишком много неверных попыток', 429);
  }
  if (hashToken(req.body.code) !== verification.codeHash) {
    verification.attempts += 1;
    await user.save();
    throw new AppError('INVALID_CODE', 'Неверный код подтверждения', 400);
  }

  user.emailVerified = true;
  user.emailVerification = null;
  await user.save();
  return res.json({ token: issueJwt(user), user: publicUser(user) });
}));

// POST /api/auth/resend-verification
router.post('/resend-verification', authLimiter, [
  body('email').isEmail().normalizeEmail()
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const user = await User.findOne({ email: req.body.email });
  if (!user) return res.json({ message: verificationMessage });
  if (user.emailVerified) throw new AppError('ALREADY_VERIFIED', 'Email уже подтверждён', 400);

  const now = new Date();
  checkResendLimit(user, now);
  updateVerification(user, now);
  await user.save();
  return res.json({ message: verificationMessage });
}));

// POST /api/auth/forgot-password
router.post('/forgot-password', authLimiter, [
  body('email').isEmail().normalizeEmail()
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const user = await User.findOne({ email: req.body.email });
  if (user) {
    const resetToken = generateResetToken();
    const now = new Date();
    user.passwordReset = {
      tokenHash: hashToken(resetToken),
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
      sentAt: now,
      usedAt: null
    };
    await user.save();
    const clientUrl = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
    const resetUrl = `${clientUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;
    dispatchEmail(() => mailer.sendPasswordReset(user.email, resetUrl));
  }
  return res.json({ message: 'Если email существует, письмо отправлено' });
}));

// POST /api/auth/reset-password
router.post('/reset-password', authLimiter, [
  body('token').isString().notEmpty(),
  body('newPassword').isLength({ min: 8 }).withMessage('Пароль должен быть минимум 8 символов')
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const user = await User.findOne({ 'passwordReset.tokenHash': hashToken(req.body.token) });
  const reset = user?.passwordReset;
  if (!reset || !reset.expiresAt || reset.expiresAt < new Date() || reset.usedAt) {
    throw new AppError('INVALID_OR_EXPIRED_TOKEN', 'Ссылка недействительна или истекла', 400);
  }

  user.password = await bcrypt.hash(req.body.newPassword, 10);
  reset.usedAt = new Date();
  user.passwordReset = null;
  await user.save();
  // TODO: invalidate the user's refresh tokens when session storage is introduced.
  return res.json({ message: 'Пароль изменён' });
}));

// POST /api/auth/login
router.post('/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) throw new UnauthorizedError('Неверный email или пароль');
    if (!user.emailVerified) {
      throw new AppError('EMAIL_NOT_VERIFIED', 'Подтвердите email', 403);
    }

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
