const mongoose = require('mongoose');

// Сердечко фильма — четвёртая ось («мне нравится») рядом с дневником,
// оценкой и watchlist. Одна запись на пару user+film: кнопка — toggle.
// DECISION: B7/unique — уникальность это фича toggle, а не ограничение.
//
// Не массив в Film и не массив в User: массив ломает пагинацию, canViewProfile
// и reconciliation публичного счётчика.
const filmLikeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  // DECISION: B7/weight — снимок User.trustWeight на момент лайка, тот же паттерн,
  // что Rating.weight: лайк фермы не должен красить публичный счётчик, даже если
  // аккаунт пометят позже.
  weight: { type: Number, default: 1, min: 0, max: 1 },
  addedAt: { type: Date, default: Date.now }
});

// Toggle и защита от гонки двойного клика.
filmLikeSchema.index({ userId: 1, filmId: 1 }, { unique: true });
// Список «Понравившиеся» в профиле.
filmLikeSchema.index({ userId: 1, addedAt: -1 });
// Film.likesCount и reconciliation: count по filmId с фильтром weight.
filmLikeSchema.index({ filmId: 1, weight: 1 });

module.exports = mongoose.model('FilmLike', filmLikeSchema);
