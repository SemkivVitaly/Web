/**
 * @fileoverview Проверка MIME и magic bytes при загрузке; блокировка исполняемых типов.
 */

import fs from 'node:fs';

/** Расширения, которые никогда не принимаем. */
const BLOCKED_EXT = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.msi',
  '.scr',
  '.ps1',
  '.vbs',
  '.js',
  '.jar',
  '.dll',
  '.sh',
  '.app',
  '.deb',
  '.rpm',
]);

/** MIME, которые отклоняем независимо от расширения. */
const BLOCKED_MIME_PREFIXES = ['application/x-msdownload', 'application/x-dosexec', 'application/vnd.microsoft.portable-executable'];

/** Сигнатуры magic bytes → ожидаемый MIME-префикс для изображений. */
const IMAGE_MAGIC = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { mime: 'image/webp', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { mime: 'image/bmp', test: (b) => b[0] === 0x42 && b[1] === 0x4d },
];

/**
 * @param {string} originalName
 * @param {string} [mime]
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateUploadBasics(originalName, mime) {
  const lower = String(originalName || '').toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  if (ext && BLOCKED_EXT.has(ext)) {
    return { ok: false, error: 'Тип файла не разрешён' };
  }
  const m = String(mime || '').toLowerCase();
  if (BLOCKED_MIME_PREFIXES.some((p) => m.startsWith(p))) {
    return { ok: false, error: 'Тип файла не разрешён' };
  }
  return { ok: true };
}

/**
 * Читает первые 16 байт файла и сверяет с заявленным image/* MIME.
 * @param {string} filePath
 * @param {string} declaredMime
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateImageMagicBytes(filePath, declaredMime) {
  const mime = String(declaredMime || '').toLowerCase();
  if (!mime.startsWith('image/')) return { ok: true };
  let buf;
  try {
    const fd = fs.openSync(filePath, 'r');
    buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
  } catch {
    return { ok: false, error: 'Не удалось прочитать файл' };
  }
  const match = IMAGE_MAGIC.find((sig) => sig.test(buf));
  if (!match) {
    return { ok: false, error: 'Файл не является допустимым изображением' };
  }
  if (!mime.startsWith(match.mime.split('/')[0] + '/') && mime !== match.mime) {
    // JPEG/PNG/WebP — допускаем близкие image/* если magic совпал
    const base = match.mime.split('/')[0];
    if (base !== 'image') return { ok: false, error: 'MIME не соответствует содержимому файла' };
  }
  return { ok: true };
}

/** Лимит размера для изображений (байт). Остальные — до multer limits. */
export const MAX_IMAGE_UPLOAD_BYTES = Number(process.env.MAX_IMAGE_UPLOAD_BYTES) || 20 * 1024 * 1024;
