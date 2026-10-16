const BLOCK_CRITERIA = {
  scenario:   ['plot', 'ideas', 'dialogue'],
  characters: ['depth', 'chemistry', 'functionality'],
  visual:     ['composition', 'cinematography', 'pacing', 'tone'],
  sound:      ['music', 'design', 'narrative'],
  style:      ['originality', 'boldness']
};

const GENRE_PRESETS = {
  drama:        [25, 20, 20, 15, 20],
  action:       [20, 20, 30, 20, 10],
  comedy:       [30, 30, 15, 15, 10],
  horror:       [25, 20, 20, 25, 10],
  scifi_block:  [25, 20, 25, 20, 10],
  scifi_author: [20, 20, 25, 15, 20],
  musical:      [20, 20, 20, 30, 10],
  biopic:       [30, 30, 20, 15,  5],
  hybrid:       null
};

const DEFAULT_WEIGHTS_ARRAY = [30, 25, 20, 15, 10];
const TECHNICAL_WEIGHT = 0.7;
const VIBE_WEIGHT      = 3;

const roundTenth = n => Math.round(n * 10) / 10;

function calculateTechnicalScore(scores, weights) {
  const blockAvgs = {};
  for (const [block, criteria] of Object.entries(BLOCK_CRITERIA)) {
    let sum = 0;
    for (const name of criteria) {
      const v = scores?.[block]?.[name];
      if (!Number.isFinite(v) || v < 1 || v > 10) {
        throw new Error(`Некорректная оценка: ${block}.${name} = ${v} (нужно 1–10)`);
      }
      sum += v;
    }
    blockAvgs[block] = sum / criteria.length;
  }

  const weightedAvg =
    blockAvgs.scenario   * (weights.scenario   / 100) +
    blockAvgs.characters * (weights.characters / 100) +
    blockAvgs.visual     * (weights.visual     / 100) +
    blockAvgs.sound      * (weights.sound      / 100) +
    blockAvgs.style      * (weights.style      / 100);

  return roundTenth(weightedAvg * 10);
}

function weightsArrayToObject(arr) {
  return {
    scenario:   arr[0],
    characters: arr[1],
    visual:     arr[2],
    sound:      arr[3],
    style:      arr[4]
  };
}

function weightsObjectToArray(obj) {
  return [
    obj?.scenario   ?? 0,
    obj?.characters ?? 0,
    obj?.visual     ?? 0,
    obj?.sound      ?? 0,
    obj?.style      ?? 0
  ];
}

module.exports = {
  BLOCK_CRITERIA,
  GENRE_PRESETS,
  DEFAULT_WEIGHTS_ARRAY,
  TECHNICAL_WEIGHT,
  VIBE_WEIGHT,
  roundTenth,
  calculateTechnicalScore,
  weightsArrayToObject,
  weightsObjectToArray
};
