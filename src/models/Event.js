const mongoose = require('mongoose');
 
const eventSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['rating', 'review', 'comment', 'film_add', 'achievement']
  },
  user:      { type: String, required: true },
  film:      { type: String, default: '' },
  filmId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Film' },
  score:     { type: Number, default: null },
  contentId: { type: mongoose.Schema.Types.ObjectId },
  metadata:  { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now }
});

eventSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Event', eventSchema);
