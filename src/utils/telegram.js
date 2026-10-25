// Приводим телеграм к единому виду: можно прислать @handle, t.me/handle
// или полную ссылку — в базе всегда хранится чистый handle без @.
const TELEGRAM_RE = /^[A-Za-z0-9_]{3,32}$/;

function normalizeTelegram(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?(t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '')
    .trim();
}

function isValidTelegram(handle) {
  return TELEGRAM_RE.test(handle);
}

module.exports = { normalizeTelegram, isValidTelegram };
