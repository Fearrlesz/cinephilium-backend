#!/usr/bin/env node
/**
 * Проверка SMTP без запуска приложения.
 *
 *   node scripts/send-test-email.js you@example.com
 *
 * Скрипт подключается к SMTP из .env, проверяет логин/пароль и отправляет
 * тестовое письмо. Если письмо не уходит, он подсказывает причину по коду ошибки.
 */
require('dotenv').config();

const nodemailer = require('nodemailer');

const HINTS = {
  EAUTH: 'неверный логин или пароль. Для Яндекса/Gmail нужен «пароль приложения», а не пароль от аккаунта.',
  ETIMEDOUT: 'порт недоступен. Проверь SMTP_PORT и SMTP_SECURE: 465 → true, 587 → false.',
  ESOCKET: 'проблема TLS. Обычно SMTP_SECURE не соответствует порту (465 = true, 587 = false).',
  EDNS: 'хост не найден — проверь SMTP_HOST на опечатку.',
  EENVELOPE: 'адрес отправителя отклонён. SMTP_FROM должен быть на домене, подтверждённом у провайдера.',
};

async function main() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  const to = process.argv[2] || SMTP_USER;

  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].filter(name => !process.env[name]);
  if (missing.length > 0) {
    console.error('Не заданы переменные:', missing.join(', '));
    console.error('Пока они пустые, письма не отправляются (в dev код печатается в консоль сервера).');
    process.exitCode = 1;
    return;
  }

  if (!to) {
    console.error('Укажи получателя: node scripts/send-test-email.js you@example.com');
    process.exitCode = 1;
    return;
  }

  const port = Number(SMTP_PORT || 587);
  const secure = String(SMTP_SECURE) === 'true';

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  console.log(`Проверяю ${SMTP_HOST}:${port} (secure=${secure}) как ${SMTP_USER}...`);
  await transport.verify();
  console.log('Соединение и авторизация: OK');

  const info = await transport.sendMail({
    from: SMTP_FROM,
    to,
    subject: 'Cinephilium: проверка почты',
    text: 'Если ты это читаешь — SMTP настроен правильно.',
    html: '<p>Если ты это читаешь — <b>SMTP настроен правильно</b>.</p>',
  });

  console.log('Письмо отправлено:', info.messageId, '→', to);
}

main().catch(error => {
  console.error('Ошибка:', error.code || error.message);
  if (HINTS[error.code]) console.error('Подсказка:', HINTS[error.code]);
  process.exitCode = 1;
});
