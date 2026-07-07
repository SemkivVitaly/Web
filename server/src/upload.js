/**
 * @fileoverview Настройка каталога загрузок и `multer`: дисковое хранилище с UUID-именами, лимит 80 МБ, декодирование имён файлов.
 * Экспорт `uploadsDir` используется health-check и бэкапами.
 */

import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { validateUploadBasics } from './uploadSecurity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Абсолютный путь к каталогу файлов вложений и медиа (health-check, бэкап). */
export const uploadsDir = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

/**
 * UTF-8 байты имени файла, ошибочно представленные как ISO-8859-1 (типично для multer).
 * @param {string} s
 * @returns {string}
 */
function utf8MisreadAsLatin1ToString(s) {
  return Buffer.from(String(s), 'latin1').toString('utf8');
}

/**
 * Исправление `originalname` из multipart и строк `file_name` в БД: multer часто отдаёт UTF-8 как latin1;
 * уже корректную UTF-16 строку не портим (есть кириллица / CJK — оставляем как есть; при U+FFFD после перекода — откат).
 * @param {string | null | undefined} name
 * @returns {string}
 */
export function normalizePossibleMultipartFilename(name) {
  if (name == null) return '';
  const s = String(name);
  if (!s) return s;
  if (/[\u0400-\u04FF\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(s)) return s;
  let dec;
  try {
    dec = utf8MisreadAsLatin1ToString(s);
  } catch {
    return s;
  }
  if (dec.includes('\uFFFD')) return s;
  if (/[\u0400-\u04FF]/.test(dec)) return dec;
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(dec)) return dec;
  return s;
}

/** @deprecated Используйте {@link normalizePossibleMultipartFilename}; оставлено для совместимости импортов. */
export function decodeMultipartFilename(name) {
  return normalizePossibleMultipartFilename(name);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '';
    cb(null, `${uuidv4()}${ext}`);
  },
});

function kindFromMime(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Готовый `multer` с дисковым storage, UUID+расширение, лимит 80 МБ; отклоняет исполняемые типы. */
export const upload = multer({
  storage,
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const check = validateUploadBasics(file.originalname, file.mimetype);
    if (!check.ok) return cb(new Error(check.error));
    cb(null, true);
  },
});

/** Категория вложения: `image` | `video` | `audio` | `file` по MIME. */
export function detectKind(mime) {
  return kindFromMime(mime);
}
