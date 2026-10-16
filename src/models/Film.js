const mongoose = require('mongoose');

const filmSchema = new mongoose.Schema({
  tmdbId:      { type: Number, unique: true },
  title:       { type: String, required: true },
  year:        Number,
  poster:      String,
  description: { type: String, maxlength: 1000 },
  genres:      [String],
  director:    { type: String, maxlength: 100 },
  actors:      [String],
  trailer:     String,
  createdAt:   { type: Date, default: Date.now },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

module.exports = mongoose.model('Film', filmSchema);
