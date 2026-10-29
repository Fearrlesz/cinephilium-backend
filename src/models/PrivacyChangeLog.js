const mongoose = require('mongoose');

// Лог изменений приватности. Отдельная коллекция (решение G2), а не поле в User:
// записей может быть много, и они нужны для разбора спорных ситуаций.
const privacyChangeLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  field: { type: String, enum: ['hideProfile', 'hideFromFeed'], required: true },
  oldValue: { type: Boolean, default: null },
  newValue: { type: Boolean, default: null },
  changedAt: { type: Date, default: Date.now },
  ip: { type: String, default: '' }
});

// DECISION: B-PRIVACY/log-ttl — храним 180 дней: этого хватает, чтобы разобрать
// жалобу, и не превращает лог в вечный архив поведения пользователя.
privacyChangeLogSchema.index({ changedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
privacyChangeLogSchema.index({ userId: 1, changedAt: -1 });

module.exports = mongoose.model('PrivacyChangeLog', privacyChangeLogSchema);
