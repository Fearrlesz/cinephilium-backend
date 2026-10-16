const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  text:      { type: String, required: true, maxlength: 1000 },
  likes:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  parentId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
  status:    { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

commentSchema.index({ filmId: 1, createdAt: -1 });

module.exports = mongoose.model('Comment', commentSchema);
