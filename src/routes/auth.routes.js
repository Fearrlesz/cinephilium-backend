const express  = require('express');
const bcrypt   = require('bcryptjs');
const { body } = require('express-validator');
const User     = require('../models/User');
const Session  = require('../models/Session');
const { authLimiter, registerLimiter } = require('../middleware/security');
const { authenticate } = require('../middleware/auth');
const {
  EXCLUSIVE_NICKNAME,
  EMAIL_CODE_TTL_MIN,
  EMAIL_RESEND_COOLDOWN_SEC,
  EMAIL_RESEND_MAX_PER_HOUR,
  JWT_REFRESH_TTL_DAYS
} = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const { UnauthorizedError, ConflictError, ValidationError, AppError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');
const { generateNumericCode, generateResetToken, hashToken } = require('../utils/tokens');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { setRefreshCookie, clearRefreshCookie } = require('../utils/cookies');
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

async function issueTokens(user, req, res) {
  const now = new Date();
  const session = new Session({
    userId: user._id,
    userAgent: req.get('user-agent'),
    ip: req.ip,
    expiresAt: new Date(now.getTime() + JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000)
  });
  const refreshToken = signRefreshToken(user._id, session._id);
  session.tokenHash = hashToken(refreshToken);
  await session.save();
  setRefreshCookie(res, refreshToken);
  return signAccessToken(user._id);
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
router.post('/register', registerLimiter, authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Пароль должен быть минимум 8 символов'),
  body('nickname').notEmpty().isLength({ max: 50 }).withMessage('Никнейм не длиннее 50 символов')
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  // Согласия проверяются ДО любого обращения к БД: без них аккаунт не создаётся.
  const consent = req.body.consent;
  if (!consent || consent.personalData !== true || consent.cookies !== true) {
    throw new ValidationError('Нужно согласие на обработку персональных данных и использование cookie');
  }

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
  const user = new User({
    email,
    password: hashedPassword,
    nickname,
    emailVerified: false,
    registeredIp: req.ip,
    consent: {
      personalData: true,
      cookies: true,
      version: String(consent.version || '1.0'),
      acceptedAt: new Date(),
      ip: req.ip
    }
  });
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
  const accessToken = await issueTokens(user, req, res);
  return res.json({ accessToken, user: publicUser(user) });
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
  await Session.deleteMany({ userId: user._id });
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

    const accessToken = await issueTokens(user, req, res);
    res.json({
      accessToken,
      user: {
        id: user._id, email: user.email, nickname: user.nickname,
        isAdmin: user.isAdmin, totalPoints: user.totalPoints
      }
    });
  } catch (error) {
    throw error;
  }
}));

// POST /api/auth/refresh
router.post('/refresh', asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) {
    throw new AppError('NO_REFRESH_TOKEN', 'Refresh-токен отсутствует', 401);
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    clearRefreshCookie(res);
    throw new AppError('INVALID_REFRESH_TOKEN', 'Refresh-токен недействителен', 401);
  }

  const session = await Session.findOne({
    _id: payload.sessionId,
    tokenHash: hashToken(refreshToken)
  });
  if (!session) {
    clearRefreshCookie(res);
    throw new AppError('SESSION_REVOKED', 'Сессия завершена', 401);
  }

  const now = new Date();
  if (session.expiresAt <= now) {
    await Session.deleteOne({ _id: session._id });
    clearRefreshCookie(res);
    throw new AppError('SESSION_EXPIRED', 'Срок сессии истёк', 401);
  }

  const newRefreshToken = signRefreshToken(payload.userId, payload.sessionId);
  const rotation = await Session.updateOne(
    { _id: session._id, tokenHash: hashToken(refreshToken), expiresAt: { $gt: now } },
    { $set: { tokenHash: hashToken(newRefreshToken), lastUsedAt: now } }
  );
  if (rotation.modifiedCount !== 1) {
    clearRefreshCookie(res);
    throw new AppError('SESSION_REVOKED', 'Сессия завершена', 401);
  }
  setRefreshCookie(res, newRefreshToken);
  return res.json({ accessToken: signAccessToken(payload.userId) });
}));

// POST /api/auth/logout
router.post('/logout', asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (refreshToken) await Session.deleteOne({ tokenHash: hashToken(refreshToken) });
  clearRefreshCookie(res);
  return res.json({ message: 'Выход выполнен' });
}));

// POST /api/auth/logout-all
router.post('/logout-all', authenticate, asyncHandler(async (req, res) => {
  await Session.deleteMany({ userId: req.userId });
  clearRefreshCookie(res);
  return res.json({ message: 'Все сессии завершены' });
}));

// GET /api/auth/me
router.get('/me', authenticate, asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.userId).select('-password');
  const isExclusive = user.nickname === EXCLUSIVE_NICKNAME;
  res.json({ ...user.toObject(), isExclusive });
}));

module.exports = router;
