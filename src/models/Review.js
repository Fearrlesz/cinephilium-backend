const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  filmId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Film',   required: true },
  ratingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rating', required: true },
  title:    { type: String, required: true, maxlength: 100 },
  text:     { type: String, required: true, minlength: 350, maxlength: 15000 },
  // Спойлер — флаг, а не отдельный статус: модерация идёт как обычно.
  // DECISION: B4/migration — миграция не нужна: default false, а старые документы
  // Mongoose дочитывает как false при гидрации.
  isSpoiler: { type: Boolean, default: false },
  likes:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status:   { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

reviewSchema.index({ filmId: 1, createdAt: -1 });
reviewSchema.index({ userId: 1, filmId: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);
