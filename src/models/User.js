const mongoose = require('mongoose');

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
  totalPoints:    { type: Number, default: 0 },
  achievements:   { type: [String], default: [] },
  registeredAt:   { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
