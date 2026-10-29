const mongoose = require('mongoose');

const filmSchema = new mongoose.Schema({
  tmdbId:      { type: Number, unique: true },
  title:       { type: String, required: true },
  year:        Number,
  posterPath:  { type: String, default: '' },
  poster:      String, // Deprecated; retained for migration compatibility.
  description: { type: String, maxlength: 1000 },
  genres:      [String],
  director:    { type: String, maxlength: 100 },
  actors:      [String],
  trailer:     String,
  createdAt:   { type: Date, default: Date.now },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // DECISION: B7/5C — денормализованный публичный счётчик сердечек.
  // Считает только лайки с weight > 0 (B7/2A); сверяется reconcile-film-likes.js.
  // Это НЕ то же самое, что User.counters.filmLikes (сколько лайков поставил человек).
  likesCount:  { type: Number, default: 0, min: 0 }
});

module.exports = mongoose.model('Film', filmSchema);
