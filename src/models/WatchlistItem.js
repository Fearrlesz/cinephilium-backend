const mongoose = require('mongoose');

// Watchlist — «хочу посмотреть». Состояние, а не история: одна запись на пару
// user+film. DECISION: B6/unique — уникальность (userId, filmId) это фича,
// а не ограничение: добавить дважды нельзя, «пересмотреть список» нечего.
//
// Это НЕ поле-массив в User: массив ломает пагинацию, populate и лимиты.
const watchlistItemSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  addedAt: { type: Date, default: Date.now }
});

// Уникальность — она же защита от двойного клика и от гонки двух POST.
watchlistItemSchema.index({ userId: 1, filmId: 1 }, { unique: true });
// Свой список: сортировка по дате добавления.
watchlistItemSchema.index({ userId: 1, addedAt: -1 });
// Задел под будущие агрегаты «сколько хотят посмотреть» (в B6 не используются).
watchlistItemSchema.index({ filmId: 1 });

module.exports = mongoose.model('WatchlistItem', watchlistItemSchema);
