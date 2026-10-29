// Общие агрегаты фильма: две оси оценки, счётчики и сортировка.
//
// Vibe и полная оценка — две разные оси. Вайб есть у всех, у кого есть мнение,
// поэтому средний вайб считается по всем оценкам. Технический и комбинированный
// баллы существуют только у полных оценок: у vibe там 0 — маркер «не вычислено»
// (DECISION 2A), а не результат. Поэтому эти два средних считаются только по
// completeness: 'full'. Иначе vibe-нули тянут их вниз — баг, который чинит B2.
//
// Одна и та же цепочка стадий используется страницей фильма, каталогом и топом,
// чтобы средние не разъезжались между эндпоинтами.

const { roundTenth } = require('../config/scoring');

// Оси сортировки: параметр запроса → поле ответа.
const SORT_AXES = {
  technical: 'averageTechnical',
  combined:  'averageCombined',
  vibe:      'averageVibe'
};

function sortFieldFor(sort) {
  return SORT_AXES[sort] || SORT_AXES.technical;
}

// Оценки фильма, участвующие в агрегатах.
// weight: { $ne: 0 } — анти-накрутка: помеченные оценки не входят ни в одно
// среднее и ни в один счётчик. Фильтр не убирать.
// completeness нормализуется через $ifNull: миграция P1 проставила поле, но
// восстановление из старого бэкапа не должно превращать полные оценки в vibe.
const RATINGS_LOOKUP = {
  $lookup: {
    from: 'ratings',
    let: { filmId: '$_id' },
    pipeline: [
      { $match: { $expr: { $eq: ['$filmId', '$$filmId'] }, weight: { $ne: 0 } } },
      {
        $project: {
          technicalScore: 1,
          combinedScore: 1,
          vibe: 1,
          completeness: { $ifNull: ['$completeness', 'full'] }
        }
      }
    ],
    as: 'ratings'
  }
};

const FULL_RATINGS = {
  $filter: {
    input: '$ratings',
    as: 'rating',
    cond: { $eq: ['$$rating.completeness', 'full'] }
  }
};

const VIBE_RATINGS = {
  $filter: {
    input: '$ratings',
    as: 'rating',
    cond: { $eq: ['$$rating.completeness', 'vibe'] }
  }
};

const FILM_STATS_STAGES = [
  RATINGS_LOOKUP,
  {
    $addFields: {
      // Вайб — по всем оценкам: его ставят и те, кто прошёл 15 критериев.
      averageVibe: { $avg: '$ratings.vibe' },
      // Технический и комбинированный — только по полным. $avg по пустому
      // массиву даёт null, а не ноль: это «числа нет», а не «ноль баллов».
      averageTechnical: {
        $avg: { $map: { input: FULL_RATINGS, as: 'rating', in: '$$rating.technicalScore' } }
      },
      averageCombined: {
        $avg: { $map: { input: FULL_RATINGS, as: 'rating', in: '$$rating.combinedScore' } }
      },
      // DECISION: B2/4A — votesCount означает «сколько людей оценили фильм»,
      // то есть vibe + full. Разделение живёт в vibesCount и fullCount, иначе
      // подпись «N оценок» врала бы про фильм, у которого есть только вайб.
      votesCount: { $size: '$ratings' },
      vibesCount: { $size: VIBE_RATINGS },
      fullCount: { $size: FULL_RATINGS }
    }
  },
  { $project: { ratings: 0 } }
];

/**
 * Фильтр участника оси: в топ попадает только тот, у кого есть число по ней.
 * null > 0 в агрегации не проходит, поэтому одна проверка закрывает и «нет
 * оценок вообще», и «нет полных оценок» (DECISION B2/6A).
 */
function participantMatch(sortField) {
  return { $match: { $expr: { $gt: [`$${sortField}`, 0] } } };
}

function roundNullable(value) {
  return value === null || value === undefined ? null : roundTenth(value);
}

/**
 * Форма фильма для списков и топов.
 * DECISION: B2/6.1 — в списках отсутствующее среднее отдаётся null, а не нулём:
 * старый фронт рисует null как «—», а 0 нарисовал бы красное «0.0», что читается
 * как «плохо», а не «не оценено». На странице фильма — наоборот, 0 (см. ниже).
 */
function shapeFilmAggregates(film) {
  const averageTechnical = roundNullable(film.averageTechnical);

  return {
    ...film,
    averageTechnical,
    // DECISION: B2/1A — легаси-поле averageRating остаётся алиасом среднего
    // технического, которым оно и было. Удаление — вместе с F1, когда новый
    // фронт перестанет его читать; сейчас удаление сломало бы прод-фронт.
    averageRating: averageTechnical,
    averageVibe: roundNullable(film.averageVibe),
    averageCombined: roundNullable(film.averageCombined),
    votesCount: film.votesCount || 0,
    vibesCount: film.vibesCount || 0,
    fullCount: film.fullCount || 0
  };
}

/**
 * Форма страницы фильма. Отличие от списков ровно одно: отсутствующее среднее
 * здесь 0, а не null — «ноль как маркер» это уже язык B1 (DECISION 2A), и фронт
 * показывает на нём «Нет оценок». Не падаем и не отдаём null.
 */
function shapeFilmDetail(film) {
  const shaped = shapeFilmAggregates(film);
  const averageTechnical = shaped.averageTechnical ?? 0;
  const averageVibe = shaped.averageVibe ?? 0;
  const averageCombined = shaped.averageCombined ?? 0;

  return {
    ...shaped,
    averageTechnical,
    averageRating: averageTechnical,
    averageVibe,
    averageCombined
  };
}

module.exports = {
  SORT_AXES,
  sortFieldFor,
  FILM_STATS_STAGES,
  participantMatch,
  shapeFilmAggregates,
  shapeFilmDetail
};
