const mongoose = require('mongoose');

const passwordResetSchema = new mongoose.Schema({
  tokenHash: String,
  expiresAt: Date,
  sentAt: Date,
  usedAt: Date,
  // Кто из администраторов выдал ссылку — для аудита.
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { _id: false });

const countersSchema = new mongoose.Schema({
  ratings: { type: Number, default: 0 },
  // Сколько сейчас стоит именно vibe-оценок (без 15 критериев).
  vibes: { type: Number, default: 0 },
  reviews: { type: Number, default: 0 },
  reviewsApproved: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  commentsApproved: { type: Number, default: 0 },
  filmLikes: { type: Number, default: 0 },
  // Сколько записей в дневнике просмотров (B5). Считает все записи, включая
  // пересмотры: это история, а не уникальные фильмы.
  watches: { type: Number, default: 0 },
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

// DECISION: B-PRIVACY/H1 — флаги приватности живут в User.privacy.
// D1: два независимых флага. hideProfile — скрыть страницу профиля,
// hideFromFeed — не показывать события автора в общей ленте.
const privacySchema = new mongoose.Schema({
  hideProfile:  { type: Boolean, default: false },
  hideFromFeed: { type: Boolean, default: false }
}, { _id: false });

const userSchema = new mongoose.Schema({
  // Вход идёт по никнейму: почта больше не нужна и не подтверждается.
  // Поле оставлено необязательным для старых аккаунтов и для связи с админом.
  email: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    lowercase: true,
    maxlength: 100,
    default: undefined,
    match: [/^\S+@\S+\.\S+$/, 'Некорректный email']
  },
  password:       { type: String, required: true },
  nickname:       { type: String, unique: true, required: true, maxlength: 50 },
  avatar:         { type: String, default: '' },
  // Telegram без @ — показывается на странице «Связь с админами».
  telegram:       { type: String, default: '', trim: true, maxlength: 32 },
  isAdmin:        { type: Boolean, default: false },
  // Какой инвайт открыл аккаунт — нужно, чтобы отслеживать фермы и отзывать доступ.
  invitedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  passwordReset:  { type: passwordResetSchema, default: null },
  totalPoints:    { type: Number, default: 0 },
  counters:       { type: countersSchema, default: () => ({}) },
  privacy:        { type: privacySchema, default: () => ({}) },
  // DECISION: B5/3 — дневник по умолчанию открыт, но пользователь может его
  // закрыть. Закрытый дневник не отдаётся другим; счётчик «N просмотров» фильма
  // при этом остаётся агрегатным и продолжает считать все записи (см. роут фильма).
  diaryPrivate:   { type: Boolean, default: false },
  achievements:   { type: [String], default: [] },
  // DECISION: B9/pinned-achievement — закреплённое достижение хранится строкой
  // из `achievements` (например, «🎬 Первый шаг»), а не ObjectId/ссылкой:
  // достижения и так строки, отдельная коллекция не нужна. Без индекса —
  // выборок по этому полю нет, оно читается только вместе с пользователем.
  pinnedAchievement: { type: String, default: null },
  consent:        { type: consentSchema, default: null },
  registeredIp:   { type: String, default: '' },
  // Вес голоса в агрегатах. 0 — оценки аккаунта не влияют на средние
  // (выставляется скриптом flag-sybil-accounts для ферм).
  trustWeight:    { type: Number, default: 1, min: 0, max: 1 },
  flagged:        { type: Boolean, default: false },
  registeredAt:   { type: Date, default: Date.now },
  // Скользящее окно созданных vibe-оценок для дневного капа (50/24ч).
  // Служебное поле, наружу не отдаётся.
  vibeWindow:     { type: [Date], default: undefined, select: false }
});

userSchema.index({ registeredIp: 1, registeredAt: -1 });
userSchema.index({ flagged: 1 });

module.exports = mongoose.model('User', userSchema);
