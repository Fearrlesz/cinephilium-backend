const mongoose = require('mongoose');

// Заявка с сайта «хочу доступ». Контакт — свободный текст: телега, почта, что угодно.
// Админ читает заявку в панели и выдаёт инвайт вручную.
const contactRequestSchema = new mongoose.Schema({
  nickname:  { type: String, required: true, trim: true, maxlength: 50 },
  contact:   { type: String, required: true, trim: true, maxlength: 120 },
  message:   { type: String, default: '', trim: true, maxlength: 500 },
  status:    { type: String, enum: ['new', 'approved', 'rejected'], default: 'new' },
  ip:        { type: String, default: '' },
  userAgent: { type: String, default: '' },
  inviteId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Invite', default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

contactRequestSchema.index({ status: 1, createdAt: -1 });
contactRequestSchema.index({ ip: 1, createdAt: -1 });

module.exports = mongoose.model('ContactRequest', contactRequestSchema);
