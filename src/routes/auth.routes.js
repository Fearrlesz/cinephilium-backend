const express  = require('express');
const bcrypt   = require('bcryptjs');
const { body } = require('express-validator');
const User     = require('../models/User');
const Invite   = require('../models/Invite');
const Session  = require('../models/Session');
const { authLimiter, registerLimiter } = require('../middleware/security');
const { authenticate } = require('../middleware/auth');
const {
  EXCLUSIVE_NICKNAME,
  JWT_REFRESH_TTL_DAYS,
  REGISTRATION_MODE
} = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const { UnauthorizedError, ConflictError, ValidationError, AppError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');
const { hashToken, normalizeInviteCode } = require('../utils/tokens');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { setRefreshCookie, clearRefreshCookie } = require('../utils/cookies');

const router = express.Router();

function publicUser(user) {
  return {
    id: user._id,
    nickname: user.nickname,
    email: user.email || null,
    isAdmin: Boolean(user.isAdmin),
    totalPoints: user.totalPoints || 0
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

function inviteIsExpired(invite, now = new Date()) {
  return Boolean(invite.expiresAt && invite.expiresAt <= now);
}

// Проверяем код до создания аккаунта, чтобы не мусорить в базе.
async function findUsableInvite(rawCode) {
  const normalized = normalizeInviteCode(rawCode);
  if (!/^[A-Z0-9]{8}$/.test(normalized)) {
    throw new AppError('INVITE_INVALID', 'Инвайт-код недействителен', 400);
  }

  const invite = await Invite.findOne({ codeHash: hashToken(normalized) });
  if (!invite) throw new AppError('INVITE_INVALID', 'Инвайт-код недействителен', 400);
  if (invite.revokedAt) throw new AppError('INVITE_REVOKED', 'Инвайт-код отозван', 410);
  if (invite.usedAt) throw new AppError('INVITE_USED', 'Инвайт-код уже использован', 409);
  if (inviteIsExpired(invite)) throw new AppError('INVITE_EXPIRED', 'Срок действия инвайт-кода истёк', 410);
  return invite;
}

// Бросаем регистрацию, если параллельный запрос успел занять тот же код:
// код должен достаться ровно одному аккаунту.
async function claimInvite(invite, userId) {
  const now = new Date();
  const claimed = await Invite.findOneAndUpdate(
    {
      _id: invite._id,
      usedAt: null,
      revokedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }]
    },
    { $set: { usedBy: userId, usedAt: now } },
    { returnDocument: 'after' }
  );
  if (!claimed) throw new AppError('INVITE_USED', 'Инвайт-код уже использован', 409);
  return claimed;
}

// GET /api/auth/config — что показать в форме входа/регистрации.
router.get('/config', (req, res) => {
  res.json({
    registrationMode: REGISTRATION_MODE,
    inviteRequired: REGISTRATION_MODE === 'invite',
    passwordResetRequiresAdmin: true
  });
});

// POST /api/auth/register
// Аккаунт создаётся сразу: почта не нужна и не подтверждается.
router.post('/register', registerLimiter, authLimiter, [
  body('nickname').trim().isLength({ min: 2, max: 50 }).withMessage('Никнейм должен быть от 2 до 50 символов'),
  body('password').isLength({ min: 8 }).withMessage('Пароль должен быть минимум 8 символов'),
  body('inviteCode').optional({ nullable: true }).isString().trim()
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  // Согласия проверяются ДО любого обращения к БД: без них аккаунт не создаётся.
  const consent = req.body.consent;
  if (!consent || consent.personalData !== true || consent.cookies !== true) {
    throw new ValidationError('Нужно согласие на обработку персональных данных и использование cookie');
  }

  const { nickname, password, inviteCode } = req.body;

  const existingNickname = await User.findOne({ nickname });
  if (existingNickname) throw new ConflictError('Этот никнейм уже занят');

  // Первый аккаунт на пустой базе создаём без инвайта и сразу админом:
  // иначе на свежей установке некому выдать первый код.
  const userCount = await User.estimatedDocumentCount();
  const isBootstrap = userCount === 0;

  let invite = null;
  if (!isBootstrap) {
    const hasInvite = typeof inviteCode === 'string' && normalizeInviteCode(inviteCode).length > 0;
    if (hasInvite) {
      invite = await findUsableInvite(inviteCode);
    } else if (REGISTRATION_MODE === 'invite') {
      throw new AppError('INVITE_REQUIRED', 'Для регистрации нужен инвайт-код', 403);
    }
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = new User({
    nickname,
    password: hashedPassword,
    isAdmin: isBootstrap,
    invitedBy: invite?.createdBy || null,
    registeredIp: req.ip,
    consent: {
      personalData: true,
      cookies: true,
      version: String(consent.version || '1.0'),
      acceptedAt: new Date(),
      ip: req.ip
    }
  });

  try {
    await user.save();
    if (invite) await claimInvite(invite, user._id);
  } catch (error) {
    // Не оставляем «полузарегистрированный» аккаунт, если код не закрепился.
    await User.deleteOne({ _id: user._id }).catch(() => {});
    throw error;
  }

  const accessToken = await issueTokens(user, req, res);
  return res.status(201).json({
    accessToken,
    user: publicUser(user),
    message: isBootstrap ? 'Аккаунт администратора создан' : 'Аккаунт создан'
  });
}));

// POST /api/auth/login — вход по никнейму и паролю.
router.post('/login', authLimiter, [
  body('nickname').optional({ nullable: true }).isString().trim(),
  body('email').optional({ nullable: true }).isString().trim(),
  body('password').notEmpty()
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const identifier = String(req.body.nickname || req.body.email || '').trim();
  const { password } = req.body;
  if (!identifier) throw new ValidationError('Укажите никнейм');

  // email оставлен только для старых аккаунтов, где он был логином.
  const user = await User.findOne(
    identifier.includes('@') ? { email: identifier.toLowerCase() } : { nickname: identifier }
  );
  if (!user) throw new UnauthorizedError('Неверный никнейм или пароль');

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) throw new UnauthorizedError('Неверный никнейм или пароль');

  const accessToken = await issueTokens(user, req, res);
  res.json({ accessToken, user: publicUser(user) });
}));

// POST /api/auth/reset-password — ссылку выдаёт администратор вручную,
// письмо никуда не отправляется.
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
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  const isExclusive = user.nickname === EXCLUSIVE_NICKNAME;
  res.json({ ...user.toObject(), isExclusive });
}));

module.exports = router;
