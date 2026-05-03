/**
 * @fileoverview Скрипт резервного копирования: копирует файл SQLite и при наличии каталог `uploads/` в `server/data/backups/<timestamp>/`.
 *
 * Запуск из пакета server: `npm run backup`. Путь к БД задаётся так же, как у процесса API (`SQLITE_PATH`), иначе `data/localchat.db`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(__dirname, '..');
const dataDir = path.join(serverRoot, 'data');
const dbPath = process.env.SQLITE_PATH || path.join(dataDir, 'localchat.db');
const uploadsDir = path.join(serverRoot, 'uploads');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const outDir = path.join(dataDir, 'backups', stamp);

if (!fs.existsSync(dbPath)) {
  console.error('База не найдена:', dbPath);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(dbPath, path.join(outDir, path.basename(dbPath)));

if (fs.existsSync(uploadsDir)) {
  fs.cpSync(uploadsDir, path.join(outDir, 'uploads'), { recursive: true });
  console.log('Скопировано: база + uploads →', outDir);
} else {
  console.log('Скопирована только база (uploads отсутствует) →', outDir);
}
