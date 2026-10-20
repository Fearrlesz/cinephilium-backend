const mongoose = require('mongoose');

const emailVerificationSchema = new mongoose.Schema({
  codeHash: String,
  expiresAt: Date,
  sentAt: Date,
  attempts: { type: Number, default: 0 },
  resendHistory: { type: [Date], default: [] }
}, { _id: false });

const passwordResetSchema = new mongoose.Schema({
  tokenHash: String,
  expiresAt: Date,
  sentAt: Date,
  usedAt: Date
}, { _id: false });

const countersSchema = new mongoose.Schema({
  ratings: { type: Number, default: 0 },
  reviews: { type: Number, default: 0 },
  reviewsApproved: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  commentsApproved: { type: Number, default: 0 },
  filmLikes: { type: Number, default: 0 },
  watchlist: { type: Number, default: 0 },
  followers: { type: Number, default: 0 },
  following: { type: Number, default: 0 },
  likesReceived: { type: Number, default: 0 }
}, { _id: false });

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    unique: true,
    required: true,
    maxlength: 100,
    match: [/^\S+@\S+\.\S+$/, 'Некорректный email']
  },
  password:       { type: String, required: true },
  nickname:       { type: String, unique: true, required: true, maxlength: 50 },
  avatar:         { type: String, default: '' },
  isAdmin:        { type: Boolean, default: false },
  emailVerified:  { type: Boolean, default: false },
  emailVerification: { type: emailVerificationSchema, default: null },
  passwordReset:  { type: passwordResetSchema, default: null },
  totalPoints:    { type: Number, default: 0 },
  counters:       { type: countersSchema, default: () => ({}) },
  achievements:   { type: [String], default: [] },
  registeredAt:   { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
