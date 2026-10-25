const express = require('express');
const { body } = require('express-validator');
const User = require('../models/User');
const ContactRequest = require('../models/ContactRequest');
const { contactLimiter } = require('../middleware/security');
const { ADMIN_TELEGRAMS } = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const { checkValidation } = require('../utils/validate');

const router = express.Router();

// GET /api/contact/admins — кого показывать на странице «Связь с админами».
// Берём телеграмы админов из базы и добавляем запасные из ADMIN_TELEGRAMS:
// контакты видны, даже пока ни у одного админа не заполнен профиль.
router.get('/admins', asyncHandler(async (req, res) => {
  const admins = await User.find({ isAdmin: true, telegram: { $nin: ['', null] } })
    .select('nickname telegram')
    .lean();

  const list = [];
  const seen = new Set();

  for (const admin of admins) {
    const key = admin.telegram.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ nickname: admin.nickname, telegram: admin.telegram });
  }

  for (const handle of ADMIN_TELEGRAMS) {
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ nickname: null, telegram: handle });
  }

  res.json({ admins: list });
}));

// POST /api/contact/request — заявка «хочу доступ».
// Письма никуда не уходят: заявка ложится в админку, дальше админ пишет сам.
router.post('/request', contactLimiter, [
  body('nickname').trim().isLength({ min: 2, max: 50 }).withMessage('Никнейм от 2 до 50 символов'),
  body('contact').trim().isLength({ min: 3, max: 120 }).withMessage('Укажи контакт: телеграм, почту или ссылку'),
  body('message').optional({ nullable: true }).isLength({ max: 500 }).withMessage('Сообщение не длиннее 500 символов')
  // Ловушка для ботов (website) проверяется вручную ниже: настоящий человек
  // этого поля не видит, а боту отвечаем «успехом», чтобы он не перебирал.
], asyncHandler(async (req, res, next) => {
  if (checkValidation(req, next)) return;

  // Бот заполнил скрытое поле — делаем вид, что всё хорошо, но ничего не сохраняем.
  if (req.body.website) {
    return res.status(201).json({ message: 'Заявка отправлена' });
  }

  await ContactRequest.create({
    nickname: req.body.nickname,
    contact: req.body.contact,
    message: req.body.message || '',
    ip: req.ip,
    userAgent: req.get('user-agent') || ''
  });

  return res.status(201).json({
    message: 'Заявка отправлена. Админ свяжется с тобой по указанному контакту.'
  });
}));

module.exports = router;
