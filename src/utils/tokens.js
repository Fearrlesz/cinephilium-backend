const crypto = require('node:crypto');

function generateNumericCode(length = 6) {
  return Array.from({ length }, () => crypto.randomInt(0, 10)).join('');
}

function hashToken(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { generateNumericCode, hashToken, generateResetToken };