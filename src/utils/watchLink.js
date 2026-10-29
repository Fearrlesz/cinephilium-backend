// Связь «оценка/рецензия ↔ запись дневника».
//
// DECISION: B5/2 — связь ставится только по явному watchId в теле запроса на
// создание оценки или рецензии. Автопривязки нет: при нескольких просмотрах
// непонятно, к какому приклеивать, а неявное поведение потом невозможно объяснить.
// Направление ссылки — в Watch (ratingId/reviewId); схемы Rating и Review не меняются.

const Watch = require('../models/Watch');

/**
 * Ищет запись дневника этого пользователя именно для этого фильма.
 * Чужой watchId или запись другого фильма не проходят — наружу это 400.
 */
async function findOwnWatch(watchId, userId, filmId) {
  return Watch.findOne({ _id: watchId, userId, filmId });
}

/**
 * Ставит ссылку на оценку/рецензию в запись дневника.
 * Одна цель — одна запись: прежняя привязка у других записей этого фильма
 * снимается, чтобы повторное сохранение не оставило две ссылки на одну оценку.
 *
 * @param {{ watchId: object|string, userId: object|string, filmId: object|string,
 *           field: 'ratingId'|'reviewId', targetId: object|string }} params
 * @returns {Promise<boolean>} true, если запись обновлена
 */
async function setWatchLink({ watchId, userId, filmId, field, targetId }) {
  await Watch.updateMany(
    { userId, filmId, [field]: targetId },
    { $set: { [field]: null } }
  );

  const result = await Watch.updateOne(
    { _id: watchId, userId, filmId },
    { $set: { [field]: targetId } }
  );

  return result.modifiedCount === 1;
}

module.exports = { findOwnWatch, setWatchLink };
