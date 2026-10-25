#!/usr/bin/env node
/**
 * Защита от утечки секретов в git.
 *
 * Запускается из .githooks/pre-commit, но можно и вручную:
 *   node scripts/check-secrets.js
 *
 * Проверяет только то, что уже добавлено в индекс (git add):
 *   - файлы .env / .env.* (кроме .env.example);
 *   - строки подключения MongoDB с паролем, приватные ключи, AWS/GitHub-токены.
 *
 * Вывод пишется через файловые дескрипторы, а не через пайпы: в песочнице
 * пайпы недоступны, а так скрипт работает одинаково везде.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SECRET_PATTERNS = [
  /mongodb(\+srv)?:\/\/[^\s/]+:[^@\s]+@/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{30,}/
];

function gitOutput(args) {
  const tmp = path.join(process.cwd(), '.git', 'check-secrets.tmp');
  const fd = fs.openSync(tmp, 'w');
  try {
    execFileSync('git', args, { stdio: ['ignore', fd, fd] });
  } catch {
    // git может завершиться с кодом 1, когда сравнивать нечего — это не ошибка.
  } finally {
    fs.closeSync(fd);
  }
  const output = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  return output;
}

function main() {
  const staged = gitOutput(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (staged.length === 0) return 0;

  const problems = [];

  for (const file of staged) {
    const base = path.basename(file);
    const isEnvFile = base === '.env' || (base.startsWith('.env.') && base !== '.env.example');
    if (isEnvFile) problems.push(`В коммит попал env-файл: ${file}`);
  }

  const diff = gitOutput(['diff', '--cached', '-U0', '--diff-filter=ACMR']);
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (SECRET_PATTERNS.some(pattern => pattern.test(line))) {
      problems.push(`В диффе найден секрет: ${line.slice(0, 120)}`);
    }
  }

  if (problems.length === 0) return 0;

  console.error('✖ Коммит отменён:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  console.error('Секреты держим в .env (он в .gitignore), в репозитории — только .env.example.');
  console.error('Убрать файл из индекса: git restore --staged <файл>');
  return 1;
}

process.exitCode = main();
