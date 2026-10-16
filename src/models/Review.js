const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  filmId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Film',   required: true },
  ratingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rating', required: true },
  title:    { type: String, required: true, maxlength: 100 },
  text:     { type: String, required: true, maxlength: 5000 },
  likes:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  status:   { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

reviewSchema.index({ filmId: 1, createdAt: -1 });
reviewSchema.index({ userId: 1, filmId: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);
