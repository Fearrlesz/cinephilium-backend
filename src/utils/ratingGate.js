// Гейтинг «сначала оцени, потом говори».
//
// Оценка — вход в обсуждение: vibe стоит один клик и уже означает «я смотрел,
// у меня есть мнение». Требовать 15 критериев нельзя — это превратило бы
// обсуждение в клуб избранных. Рецензии живут по другому порогу (B4), поэтому
// фильтр по completeness здесь параметризован, а не зашит.

const mongoose = require('mongoose');
const Rating = require('../models/Rating');
const { AppError } = require('./errors');
const asyncHandler = require('./asyncHandler');

/**
 * Есть ли у пользователя оценка этого фильма.
 *
 * DECISION: B3/2A — годится любая оценка, включая weight: 0. Гейтинг отвечает
 * на вопрос «смотрел ли человек», а не «доверяем ли мы его голосу»: анти-накрутка
 * живёт в агрегатах, а спам-комментарии всё равно проходят через модерацию.
 * Помеченный аккаунт не получает молчаливого бана на всё сразу.
 *
 * @param {string|object} userId
 * @param {string|object} filmId
 * @param {{ completeness?: 'vibe'|'full' }} [options] — B4 попросит 'full'
 * @returns {Promise<boolean>}
 */
async function hasRatingForFilm(userId, filmId, { completeness } = {}) {
  const filter = { userId, filmId };
  if (completeness) filter.completeness = completeness;
  return Boolean(await Rating.exists(filter));
}

/**
 * Middleware: пускает создавать контент только тому, кто оценил фильм.
 *
 * Ставится ПОСЛЕ authenticate и ДО обработчика. Валидаторы к этому моменту уже
 * собрали ошибки, но ещё не ответили (checkValidation живёт в обработчике),
 * поэтому 403 побеждает 400: «тебе нельзя писать» важнее «текст длинный».
 *
 * DECISION: B3/3A — админ не исключение: правила одинаковы для всех, иначе
 * «админ не как все» быстро становится лазейкой. Цена решения: служебный ответ
 * потребует оценки, которая попадёт в агрегаты обычным голосом.
 */
function requireRatingForFilm({
  completeness,
  code = 'RATING_REQUIRED_FOR_COMMENT',
  message = 'Сначала оцените фильм — потом можно комментировать'
} = {}) {
  return asyncHandler(async (req, res, next) => {
    const filmId = req.body?.filmId;

    // Кривой filmId — забота валидации тела: гейт не должен подменять 400 на 403,
    // иначе клиент получит «оцените фильм» вместо «некорректный id».
    if (!mongoose.Types.ObjectId.isValid(String(filmId || ''))) return next();

    const allowed = await hasRatingForFilm(req.userId, filmId, { completeness });
    if (!allowed) throw new AppError(code, message, 403);

    return next();
  });
}

module.exports = { hasRatingForFilm, requireRatingForFilm };
