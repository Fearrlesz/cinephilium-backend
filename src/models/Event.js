const mongoose = require('mongoose');
 
const eventSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['rating', 'vibe', 'review', 'comment', 'film_add', 'achievement']
  },
  user:      { type: String, required: true },
  // DECISION: B-PRIVACY/event-userid (вариант A) — автор события отдельным полем.
  // Ник в `user` оставлен для ленты (он там отображается), но фильтровать
  // приватность по нику нельзя: ник — отображаемое имя, а не связь.
  // Старые события дотягиваются миграцией scripts/add-event-userid.js.
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  film:      { type: String, default: '' },
  filmId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Film' },
  score:     { type: Number, default: null },
  contentId: { type: mongoose.Schema.Types.ObjectId },
  metadata:  { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now }
});

eventSchema.index({ createdAt: -1 });
// Фильтрация ленты по приватности автора: $nin по списку скрытых.
eventSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Event', eventSchema);
