const express = require('express');
const { body } = require('express-validator');
const mongoose = require('mongoose');
const User    = require('../models/User');
const Invite  = require('../models/Invite');
const Comment = require('../models/Comment');
const Review  = require('../models/Review');
const { authenticate, isAdmin } = require('../middleware/auth');
const { addPoints } = require('../utils/points');
const { incCounter } = require('../utils/counters');
const { createEvent, updateAchievements } = require('../utils/helpers');
const { generateInviteCode, hashToken, generateResetToken } = require('../utils/tokens');
const { normalizeTelegram, isValidTelegram } = require('../utils/telegram');
const ContactRequest = require('../models/ContactRequest');
const { PASSWORD_RESET_TTL_MIN, INVITE_TTL_DAYS } = require('../config/env');

const asyncHandler = require('../utils/asyncHandler');
const { NotFoundError, ForbiddenError, AppError } = require('../utils/errors');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// POST /api/admin/make — активация админа через секретный ключ
router.post('/make', [
  body('secretKey').notEmpty().withMessage('Введите секретный ключ')
], authenticate, asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  try {
    const { secretKey } = req.body;
    const adminSecret = process.env.ADMIN_SECRET_KEY;

    if (!adminSecret) {
      throw new Error('ADMIN_SECRET_KEY is not configured');
    }

    if (secretKey !== adminSecret) {
      throw new ForbiddenError('Неверный секретный ключ');
    }

    const user = await User.findById(req.userId);
    if (!user) throw new NotFoundError('Пользователь не найден');

    if (user.isAdmin) {
      return res.json({ message: 'Вы уже являетесь администратором', isAdmin: true });
    }

    user.isAdmin = true;
    await user.save();

    await addPoints(req.userId, req.userId, 'admin_bonus', 100, user._id);
    await updateAchievements(req.userId);

    const updatedUser = await User.findById(req.userId).select('totalPoints');
    res.json({
      message: 'Поздравляю! Вы теперь администратор! 👑',
      isAdmin: true,
      totalPoints: updatedUser.totalPoints
    });
  } catch (error) {
    throw error;
  }
}));

// ─── МОДЕРАЦИЯ ───────────────────────────────────────────

// GET /api/admin/pending/comments
// B8: в ответе есть targetType/targetId — у комментария к рецензии filmId тоже
// заполнен (сервер берёт его из рецензии), поэтому заголовок фильма остаётся
// в контексте, а модератор видит, к какому слою относится комментарий.
router.get('/pending/comments', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const comments = await Comment.find({ status: 'pending' })
      .populate('userId', 'nickname')
      .populate('filmId', 'title');
    res.json(comments);
  } catch (error) {
    throw error;
  }
}));

// GET /api/admin/pending/reviews
// DECISION: B4/5 — рецензия со isSpoiler здесь отдаётся полным текстом: модератор
// обязан прочитать её целиком, иначе не сможет принять решение. Скрытие спойлера —
// только публичный фронт.
router.get('/pending/reviews', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const reviews = await Review.find({ status: 'pending' })
      .populate('userId', 'nickname')
      .populate('filmId', 'title');
    res.json(reviews);
  } catch (error) {
    throw error;
  }
}));

// PUT /api/admin/comments/:id/approve
router.put('/comments/:id/approve', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const before = await Comment.findById(req.params.id).select('status userId').lean();
    if (!before) throw new NotFoundError('Комментарий не найден');
    await Comment.updateOne({ _id: req.params.id }, { $set: { status: 'approved' } });
    const comment = await Comment.findById(req.params.id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title');
    if (before.status !== 'approved') await incCounter(before.userId, 'commentsApproved', 1);

    // Награда начисляется только при переходе в approved, иначе повторное
    // нажатие «одобрить» бесконечно фармит баллы и события.
    if (before.status !== 'approved') {
      const authorIsAdmin = comment.userId?.isAdmin || false;
      const authorPoints = authorIsAdmin ? 10 : 2;

      await addPoints(comment.userId._id, comment.userId._id, 'comment', authorPoints, comment._id);

      // DECISION: B8/7B — событие в ленту только для комментариев к ФИЛЬМУ.
      // Комментарий к рецензии — ответ автору в треде, а не активность для всех:
      // лента не должна забиваться тредами под рецензиями (тот же принцип, что
      // B7/event для лайков). Новый тип события тоже не заводим.
      if ((comment.targetType || 'film') === 'film') {
        await createEvent('comment', {
          userId: comment.userId._id,
          nickname: comment.userId.nickname,
          film: comment.filmId.title,
          filmId: comment.filmId._id,
          contentId: comment._id
        });
      }

      await updateAchievements(comment.userId._id);
    }

    res.json(comment);
  } catch (error) {
    throw error;
  }
}));

// PUT /api/admin/comments/:id/reject
router.put('/comments/:id/reject', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const before = await Comment.findById(req.params.id).select('status userId').lean();
    if (!before) throw new NotFoundError('Комментарий не найден');
    await Comment.updateOne({ _id: req.params.id }, { $set: { status: 'rejected' } });
    const comment = await Comment.findById(req.params.id).populate('userId', 'nickname');
    if (before.status === 'approved') await incCounter(before.userId, 'commentsApproved', -1);

    res.json(comment);
  } catch (error) {
    throw error;
  }
}));

// PUT /api/admin/reviews/:id/approve
router.put('/reviews/:id/approve', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const before = await Review.findById(req.params.id).select('status userId').lean();
    if (!before) throw new NotFoundError('Рецензия не найдена');
    await Review.updateOne({ _id: req.params.id }, { $set: { status: 'approved' } });
    const review = await Review.findById(req.params.id)
      .populate('userId', 'nickname isAdmin')
      .populate('filmId', 'title');
    if (before.status !== 'approved') await incCounter(before.userId, 'reviewsApproved', 1);

    if (before.status !== 'approved') {
      const authorIsAdmin = review.userId?.isAdmin || false;
      const authorPoints = authorIsAdmin ? 50 : 30;

      await addPoints(review.userId._id, review.userId._id, 'review', authorPoints, review._id);
      await createEvent('review', {
        userId: review.userId._id,
        nickname: review.userId.nickname,
        film: review.filmId.title,
        filmId: review.filmId._id,
        contentId: review._id
      });
      await updateAchievements(review.userId._id);
    }

    res.json(review);
  } catch (error) {
    throw error;
  }
}));

// PUT /api/admin/reviews/:id/reject
router.put('/reviews/:id/reject', authenticate, isAdmin, asyncHandler(async (req, res, next) => {
  try {
    const before = await Review.findById(req.params.id).select('status userId').lean();
    if (!before) throw new NotFoundError('Рецензия не найдена');
    await Review.updateOne({ _id: req.params.id }, { $set: { status: 'rejected' } });
    const review = await Review.findById(req.params.id)
      .populate('userId', 'nickname')
      .populate('filmId', 'title');
    if (before.status === 'approved') await incCounter(before.userId, 'reviewsApproved', -1);

    res.json(review);
  } catch (error) {
    throw error;
  }
}));

// ─── ИНВАЙТЫ ─────────────────────────────────────────────
// Почта не используется: доступ выдаётся одноразовым кодом вручную.

function inviteStatus(invite, now) {
  if (invite.revokedAt) return 'revoked';
  if (invite.usedAt) return 'used';
  if (invite.expiresAt && invite.expiresAt <= now) return 'expired';
  return 'active';
}

// GET /api/admin/invites — список без самих кодов (в базе только хеши).
router.get('/invites', authenticate, isAdmin, asyncHandler(async (req, res) => {
  const now = new Date();
  const invites = await Invite.find({})
    .sort({ createdAt: -1 })
    .limit(200)
    .populate('usedBy', 'nickname')
    .lean();

  res.json(invites.map(invite => ({
    id: invite._id,
    prefix: invite.codePrefix,
    note: invite.note,
    status: inviteStatus(invite, now),
    usedBy: invite.usedBy?.nickname || null,
    usedAt: invite.usedAt,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt
  })));
}));

// POST /api/admin/invites — выдать новые коды.
// Сами коды возвращаются один раз: в базе хранится только SHA-256.
router.post('/invites', authenticate, isAdmin, [
  body('quantity').optional().isInt({ min: 1, max: 50 }).withMessage('Можно выдать от 1 до 50 кодов'),
  body('note').optional({ nullable: true }).isLength({ max: 200 }).withMessage('Заметка не длиннее 200 символов'),
  body('expiresInDays').optional({ nullable: true }).isInt({ min: 1, max: 365 })
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  const quantity = Number(req.body.quantity || 1);
  const note = String(req.body.note || '').trim();
  const days = Number(req.body.expiresInDays || INVITE_TTL_DAYS || 0);
  const expiresAt = days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;

  const codes = [];
  const docs = [];
  for (let i = 0; i < quantity; i += 1) {
    const code = generateInviteCode();
    codes.push(code);
    docs.push({
      codeHash: hashToken(code.replace('-', '')),
      codePrefix: code.slice(0, 4),
      note,
      createdBy: req.userId,
      expiresAt
    });
  }

  await Invite.insertMany(docs);
  res.status(201).json({
    invites: codes.map(code => ({ code, note, expiresAt })),
    message: 'Коды показываются один раз — сохраните их сейчас'
  });
}));

// DELETE /api/admin/invites/:id — отозвать ещё не использованный код.
router.delete('/invites/:id', authenticate, isAdmin, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new NotFoundError('Инвайт не найден');

  const invite = await Invite.findById(req.params.id);
  if (!invite) throw new NotFoundError('Инвайт не найден');
  if (invite.usedAt) throw new AppError('INVITE_USED', 'Код уже использован — отозвать нельзя', 409);
  if (invite.revokedAt) return res.json({ message: 'Код уже отозван' });

  invite.revokedAt = new Date();
  await invite.save();
  res.json({ message: 'Код отозван' });
}));

// ─── ЗАЯВКИ С САЙТА ─────────────────────────────────────
// Человек оставляет заявку на странице «Связь с админами», админ выдаёт код вручную.

// GET /api/admin/contact-requests?status=new — очередь заявок.
router.get('/contact-requests', authenticate, isAdmin, asyncHandler(async (req, res) => {
  const allowed = ['new', 'approved', 'rejected'];
  const status = allowed.includes(req.query.status) ? req.query.status : 'new';

  const requests = await ContactRequest.find({ status })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.json(requests.map(request => ({
    id: request._id,
    nickname: request.nickname,
    contact: request.contact,
    message: request.message,
    status: request.status,
    createdAt: request.createdAt,
    reviewedAt: request.reviewedAt
  })));
}));

// POST /api/admin/contact-requests/:id/approve — выдать инвайт по заявке.
// Код возвращается один раз: админ копирует его и отправляет по контакту из заявки.
router.post('/contact-requests/:id/approve', authenticate, isAdmin, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new NotFoundError('Заявка не найдена');

  const request = await ContactRequest.findById(req.params.id);
  if (!request) throw new NotFoundError('Заявка не найдена');
  if (request.status !== 'new') throw new AppError('REQUEST_ALREADY_REVIEWED', 'Заявка уже обработана', 409);

  const code = generateInviteCode();
  const expiresAt = INVITE_TTL_DAYS > 0 ? new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000) : null;
  const invite = await Invite.create({
    codeHash: hashToken(code.replace('-', '')),
    codePrefix: code.slice(0, 4),
    note: `заявка: ${request.nickname}`,
    createdBy: req.userId,
    expiresAt
  });

  request.status = 'approved';
  request.inviteId = invite._id;
  request.reviewedBy = req.userId;
  request.reviewedAt = new Date();
  await request.save();

  res.json({
    code,
    nickname: request.nickname,
    contact: request.contact,
    expiresAt,
    message: 'Код показывается один раз — отправь его по контакту из заявки'
  });
}));

// POST /api/admin/contact-requests/:id/reject — отклонить заявку.
router.post('/contact-requests/:id/reject', authenticate, isAdmin, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new NotFoundError('Заявка не найдена');

  const request = await ContactRequest.findById(req.params.id);
  if (!request) throw new NotFoundError('Заявка не найдена');
  if (request.status !== 'new') throw new AppError('REQUEST_ALREADY_REVIEWED', 'Заявка уже обработана', 409);

  request.status = 'rejected';
  request.reviewedBy = req.userId;
  request.reviewedAt = new Date();
  await request.save();

  res.json({ id: request._id, status: request.status });
}));

// ─── ПОЛЬЗОВАТЕЛИ И СБРОС ПАРОЛЯ ─────────────────────────

// GET /api/admin/users?query= — поиск по никнейму, чтобы найти кому выдать ссылку.
router.get('/users', authenticate, isAdmin, asyncHandler(async (req, res) => {
  const query = String(req.query.query || '').trim();
  const filter = query
    ? { nickname: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
    : {};

  const users = await User.find(filter)
    .sort({ registeredAt: -1 })
    .limit(20)
    .select('nickname isAdmin email telegram registeredAt flagged')
    .lean();

  res.json(users.map(user => ({
    id: user._id,
    nickname: user.nickname,
    isAdmin: user.isAdmin,
    telegram: user.telegram || '',
    hasEmail: Boolean(user.email),
    flagged: Boolean(user.flagged),
    registeredAt: user.registeredAt
  })));
}));

// POST /api/admin/users/:id/telegram — задать телеграм пользователя.
// Именно он показывается на странице «Связь с админами».
router.post('/users/:id/telegram', authenticate, isAdmin, [
  body('telegram').optional({ nullable: true }).isString()
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;
  if (!mongoose.isValidObjectId(req.params.id)) throw new NotFoundError('Пользователь не найден');

  const handle = normalizeTelegram(req.body.telegram);
  if (handle && !isValidTelegram(handle)) {
    throw new AppError('INVALID_TELEGRAM', 'Телеграм должен быть вида @nickname (3–32 символа)', 400);
  }

  const user = await User.findById(req.params.id);
  if (!user) throw new NotFoundError('Пользователь не найден');

  user.telegram = handle;
  await user.save();

  res.json({ id: user._id, nickname: user.nickname, telegram: user.telegram });
}));

// POST /api/admin/users/:id/admin — выдать или снять права администратора.
// Действует только админ; снять права с самого себя нельзя, как и оставить сайт без админов.
router.post('/users/:id/admin', authenticate, isAdmin, [
  body('isAdmin').optional().isBoolean().withMessage('isAdmin должен быть true или false')
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;
  if (!mongoose.isValidObjectId(req.params.id)) throw new NotFoundError('Пользователь не найден');

  const target = await User.findById(req.params.id);
  if (!target) throw new NotFoundError('Пользователь не найден');

  const makeAdmin = req.body.isAdmin !== false;

  if (!makeAdmin) {
    if (String(target._id) === String(req.userId)) {
      throw new AppError('CANNOT_DEMOTE_SELF', 'Нельзя снять права с самого себя', 400);
    }
    const admins = await User.countDocuments({ isAdmin: true });
    if (admins <= 1) {
      throw new AppError('LAST_ADMIN', 'Это последний администратор — снять права нельзя', 400);
    }
  }

  if (target.isAdmin !== makeAdmin) {
    target.isAdmin = makeAdmin;
    await target.save();
  }

  res.json({ id: target._id, nickname: target.nickname, isAdmin: target.isAdmin });
}));

// POST /api/admin/users/:id/reset-link — одноразовая ссылка сброса пароля.
// Админ копирует её и передаёт пользователю любым способом: почта не участвует.
router.post('/users/:id/reset-link', authenticate, isAdmin, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new NotFoundError('Пользователь не найден');

  const user = await User.findById(req.params.id);
  if (!user) throw new NotFoundError('Пользователь не найден');

  const token = generateResetToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MIN * 60 * 1000);
  user.passwordReset = {
    tokenHash: hashToken(token),
    expiresAt,
    sentAt: new Date(),
    usedAt: null,
    issuedBy: req.userId
  };
  await user.save();

  const clientUrl = (process.env.CLIENT_URL || process.env.CORS_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');
  res.json({
    nickname: user.nickname,
    url: `${clientUrl}/reset-password?token=${encodeURIComponent(token)}`,
    expiresAt,
    message: `Ссылка действует ${PASSWORD_RESET_TTL_MIN} минут и срабатывает один раз`
  });
}));

module.exports = router;
