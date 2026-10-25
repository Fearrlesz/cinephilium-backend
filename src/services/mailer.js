const nodemailer = require('nodemailer');
const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  EMAIL_CODE_TTL_MIN
} = require('../config/env');
const { AppError } = require('../utils/errors');

const smtpConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_FROM);
const transport = smtpConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    })
  : null;

if (!smtpConfigured) {
  console.warn('SMTP not configured, emails will fail');
}

async function sendMail(email, subject, html, devMessage) {
  if (!transport) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] ${devMessage} for`, email);
      return { ok: true };
    }
    const error = new AppError('EMAIL_SEND_FAILED', 'Не удалось отправить письмо', 502);
    console.error('[EMAIL_SEND_FAILED]', error);
    throw error;
  }

  try {
    await transport.sendMail({ from: SMTP_FROM, to: email, subject, html });
    return { ok: true };
  } catch (cause) {
    console.error('[EMAIL_SEND_FAILED]', cause);
    throw new AppError('EMAIL_SEND_FAILED', 'Не удалось отправить письмо', 502);
  }
}

function sendVerificationCode(email, code) {
  const html = `<p>Ваш код подтверждения: <strong>${code}</strong>.</p><p>Действует ${EMAIL_CODE_TTL_MIN} минут.</p>`;
  return sendMail(email, 'Подтверждение email', html, `code ${code}`);
}

function sendPasswordReset(email, resetUrl) {
  const html = `<p>Для смены пароля перейдите по ссылке:</p><p><a href="${resetUrl}">Сбросить пароль</a></p><p>Если вы не запрашивали сброс, проигнорируйте это письмо.</p>`;
  return sendMail(email, 'Сброс пароля', html, `password reset link ${resetUrl}`);
}

module.exports = { sendVerificationCode, sendPasswordReset };