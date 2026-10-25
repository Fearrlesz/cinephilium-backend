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

// Согласия фиксируются вместе с аккаунтом: без них пользователь не создаётся.
const consentSchema = new mongoose.Schema({
  personalData: { type: Boolean, default: false },
  cookies: { type: Boolean, default: false },
  version: { type: String, default: '1.0' },
  acceptedAt: Date,
  ip: String
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
  consent:        { type: consentSchema, default: null },
  registeredIp:   { type: String, default: '' },
  // Вес голоса в агрегатах. 0 — оценки аккаунта не влияют на средние
  // (выставляется скриптом flag-sybil-accounts для ферм).
  trustWeight:    { type: Number, default: 1, min: 0, max: 1 },
  flagged:        { type: Boolean, default: false },
  registeredAt:   { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
