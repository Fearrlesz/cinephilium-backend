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

// Инвайт-код человек будет переписывать руками, поэтому алфавит без
// похожих символов (0/O, 1/I/L) и с дефисом для читаемости: ABCD-EFGH.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateInviteCode() {
  const chars = Array.from({ length: 8 }, () => INVITE_ALPHABET[crypto.randomInt(0, INVITE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

// Приводим код к единому виду: регистр, пробелы и дефисы не важны.
function normalizeInviteCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

module.exports = {
  generateNumericCode,
  hashToken,
  generateResetToken,
  generateInviteCode,
  normalizeInviteCode
};