const mongoose = require('mongoose');

const actionSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:      { type: String, enum: ['rating', 'review', 'comment', 'like', 'import', 'admin_bonus'], required: true },
  points:    { type: Number, required: true },
  refId:     { type: mongoose.Schema.Types.ObjectId },
  createdAt: { type: Date, default: Date.now }
});

actionSchema.index({ userId: 1, actorId: 1, refId: 1, type: 1 });

module.exports = mongoose.model('Action', actionSchema);
