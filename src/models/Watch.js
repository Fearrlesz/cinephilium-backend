const mongoose = require('mongoose');

// Дневник просмотров: «я посмотрел этот фильм такого-то числа».
//
// Это НЕ Rating и не поле в нём: у оценки одна запись на пару user+film
// (unique), а просмотров может быть много — пересмотры. Дневник отвечает
// на вопрос «когда я видел», оценка — «что я думаю». Держать их врозь —
// сознательное решение B5, а не промежуточное состояние.
const watchSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  // Дата просмотра: может быть в прошлом (задним числом), но не в будущем.
  watchedAt: { type: Date, required: true, default: Date.now },
  // DECISION: B5/4 — пересмотр ставит пользователь. Автоопределение сломалось бы
  // на вводе старых просмотров задним числом: «уже есть запись» там ничего не значит.
  isRewatch: { type: Boolean, default: false },
  // DECISION: B5/1 — теги не проходят премодерацию: это классификация, а не
  // высказывание. Лимиты и нормализация — в роуте (1–30 символов, до 10 штук,
  // trim, дедуп без учёта регистра).
  tags: { type: [String], default: [] },
  // DECISION: B5/2 — связь с оценкой/рецензией ставится только по явному
  // watchId в теле запроса на создание оценки/рецензии. Автопривязки нет:
  // при нескольких просмотрах непонятно, к какому приклеивать.
  // Ссылки живут здесь, схема Rating/Review не меняется.
  ratingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rating', default: null },
  reviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', default: null }
}, { timestamps: true });

// Своя лента (сортировка по дате) и публичный дневник.
watchSchema.index({ userId: 1, watchedAt: -1 });
// Счётчик «N просмотров» на странице фильма.
watchSchema.index({ filmId: 1 });
// Проверки «есть ли запись этого фильма у пользователя» (привязка watchId).
watchSchema.index({ userId: 1, filmId: 1 });

module.exports = mongoose.model('Watch', watchSchema);
