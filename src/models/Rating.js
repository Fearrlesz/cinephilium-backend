const mongoose = require('mongoose');
const { BLOCK_CRITERIA } = require('../config/scoring');

const ratingSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  // vibe — первое впечатление; full — 15 критериев + vibe.
  // DECISION: 1A — даунгрейда нет, full-запись не упрощается.
  completeness: { type: String, enum: ['vibe', 'full'], default: 'full' },
  genrePreset:  { type: String, default: null },
  blockWeights: {
    scenario:   Number,
    characters: Number,
    visual:     Number,
    sound:      Number,
    style:      Number
  },
  // Для vibe-оценки scores нет, поэтому required снимается: полноту
  // гарантирует pre-validate ниже и валидация в роуте.
  scores: {
    scenario: {
      plot:     { type: Number, min: 1, max: 10 },
      ideas:    { type: Number, min: 1, max: 10 },
      dialogue: { type: Number, min: 1, max: 10 }
    },
    characters: {
      depth:         { type: Number, min: 1, max: 10 },
      chemistry:     { type: Number, min: 1, max: 10 },
      functionality: { type: Number, min: 1, max: 10 }
    },
    visual: {
      composition:    { type: Number, min: 1, max: 10 },
      cinematography: { type: Number, min: 1, max: 10 },
      pacing:         { type: Number, min: 1, max: 10 },
      tone:           { type: Number, min: 1, max: 10 }
    },
    sound: {
      music:     { type: Number, min: 1, max: 10 },
      design:    { type: Number, min: 1, max: 10 },
      narrative: { type: Number, min: 1, max: 10 }
    },
    style: {
      originality: { type: Number, min: 1, max: 10 },
      boldness:    { type: Number, min: 1, max: 10 }
    }
  },
  vibe:           { type: Number, min: 1, max: 10, required: true },
  // DECISION: 2A — 0 означает «не вычислено», валидные баллы начинаются с 10.
  technicalScore: { type: Number, min: 0, max: 100 },
  combinedScore:  { type: Number, min: 0, max: 100 },
  textReview:     { type: String, maxlength: 2000, default: '' },
  likes:          [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Анти-накрутка: вес голоса и IP, с которого ставилась оценка.
  weight:         { type: Number, default: 1, min: 0, max: 1 },
  ip:             { type: String, default: '' },
  // Когда именно поставлена vibe-оценка. Нужно для дневного капа и не
  // сбрасывается при апгрейде: создание vibe уже израсходовало слот.
  vibeCreatedAt:  { type: Date, default: null, select: false }
}, { timestamps: true });

ratingSchema.pre('validate', function ensureFullScores() {
  if (this.completeness !== 'full') return;
  for (const [block, criteria] of Object.entries(BLOCK_CRITERIA)) {
    for (const criterion of criteria) {
      const value = this.scores?.[block]?.[criterion];
      if (!Number.isFinite(value) || value < 1 || value > 10) {
        throw new Error(`Полная оценка требует ${block}.${criterion} (1–10)`);
      }
    }
  }
});

ratingSchema.index({ userId: 1, filmId: 1 }, { unique: true });
ratingSchema.index({ filmId: 1 });
ratingSchema.index({ userId: 1 });
ratingSchema.index({ userId: 1, vibeCreatedAt: -1 });

module.exports = mongoose.model('Rating', ratingSchema);
