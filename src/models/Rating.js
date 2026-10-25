const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  genrePreset:  { type: String, default: null },
  blockWeights: {
    scenario:   Number,
    characters: Number,
    visual:     Number,
    sound:      Number,
    style:      Number
  },
  scores: {
    scenario: {
      plot:     { type: Number, min: 1, max: 10, required: true },
      ideas:    { type: Number, min: 1, max: 10, required: true },
      dialogue: { type: Number, min: 1, max: 10, required: true }
    },
    characters: {
      depth:         { type: Number, min: 1, max: 10, required: true },
      chemistry:     { type: Number, min: 1, max: 10, required: true },
      functionality: { type: Number, min: 1, max: 10, required: true }
    },
    visual: {
      composition:    { type: Number, min: 1, max: 10, required: true },
      cinematography: { type: Number, min: 1, max: 10, required: true },
      pacing:         { type: Number, min: 1, max: 10, required: true },
      tone:           { type: Number, min: 1, max: 10, required: true }
    },
    sound: {
      music:     { type: Number, min: 1, max: 10, required: true },
      design:    { type: Number, min: 1, max: 10, required: true },
      narrative: { type: Number, min: 1, max: 10, required: true }
    },
    style: {
      originality: { type: Number, min: 1, max: 10, required: true },
      boldness:    { type: Number, min: 1, max: 10, required: true }
    }
  },
  vibe:           { type: Number, min: 1, max: 10, required: true },
  technicalScore: { type: Number, min: 10, max: 100 },
  combinedScore:  { type: Number, min: 10, max: 100 },
  textReview:     { type: String, maxlength: 2000, default: '' },
  likes:          [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Анти-накрутка: вес голоса и IP, с которого ставилась оценка.
  weight:         { type: Number, default: 1, min: 0, max: 1 },
  ip:             { type: String, default: '' }
}, { timestamps: true });

ratingSchema.index({ userId: 1, filmId: 1 }, { unique: true });
ratingSchema.index({ filmId: 1 });
ratingSchema.index({ userId: 1 });

module.exports = mongoose.model('Rating', ratingSchema);
