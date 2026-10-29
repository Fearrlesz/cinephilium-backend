const mongoose = require('mongoose');

// Комментарий — полиморфная сущность (B8): к фильму или к рецензии.
//
// DECISION: B8/schema — `filmId` остаётся legacy-полем и НЕ удаляется: по нему
// работают старый GET /api/comments/:filmId, профиль и агрегаты. Для targetType
// 'film' он равен targetId; для 'review' сервер проставляет filmId из рецензии,
// чтобы «все комментарии фильма» оставались возможными.
//
// DECISION: B8/legacy-read — отсутствующий targetType читается как 'film'
// (см. фильтры в роутах), чтобы окно «деплой → миграция» не ломало старые данные.
const commentSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  filmId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Film', required: true },
  // DECISION: B8/polymorphism — тип цели и её id. У старых документов поля нет,
  // миграция scripts/migrate-comment-target.js проставит их идемпотентно.
  targetType: { type: String, enum: ['film', 'review'], default: 'film' },
  targetId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  text:       { type: String, required: true, maxlength: 1000 },
  likes:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  parentId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
  status:     { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now }
});

// Страховка для любых путей создания (включая тесты и старый код): у комментария
// к фильму targetId всегда равен filmId. Так новые выборки по targetId находят
// и документы, созданные без явного targetId.
commentSchema.pre('validate', function fillTarget() {
  if (!this.targetType) this.targetType = 'film';
  if (this.targetType === 'film' && !this.targetId) this.targetId = this.filmId;
});

// Старый роут и профиль работают по filmId — индекс остаётся (DECISION B8/5A).
commentSchema.index({ filmId: 1, createdAt: -1 });
// Новый GET /api/comments по targetType+targetId (DECISION B8/5A).
commentSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

module.exports = mongoose.model('Comment', commentSchema);
