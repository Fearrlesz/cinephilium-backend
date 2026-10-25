const mongoose = require('mongoose');

// Одноразовый код, который администратор выдаёт вручную.
// Сам код в базе не хранится — только SHA-256, поэтому украденная база
// не даёт возможности зарегистрировать аккаунт. Показать код можно
// ровно один раз, в ответе на создание.
const inviteSchema = new mongoose.Schema({
  codeHash:   { type: String, required: true, unique: true },
  // Первые символы кода: по ним админ узнаёт инвайт в списке, не видя код целиком.
  codePrefix: { type: String, default: '' },
  note:       { type: String, default: '', maxlength: 200, trim: true },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  usedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  usedAt:     { type: Date, default: null },
  revokedAt:  { type: Date, default: null },
  expiresAt:  { type: Date, default: null },
  createdAt:  { type: Date, default: Date.now }
});

inviteSchema.index({ usedAt: 1, revokedAt: 1, expiresAt: 1 });

module.exports = mongoose.model('Invite', inviteSchema);
