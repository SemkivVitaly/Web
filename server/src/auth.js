/**
 * @fileoverview Пароли (bcrypt), JWT сессии (`JWT_SECRET`, срок 7d), спец-токены OnlyOffice (скачивание / conversion import),
 * генерация уникального `tag` для пользователя.
 *
 * В production процесс завершится, если `JWT_SECRET` не задан или совпадает с dev-заглушкой.
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';

const DEV_JWT_SECRET = 'localchat-dev-change-me';
const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_SECRET;
const JWT_EXPIRES = '7d';

if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET?.trim()) {
    console.error('[FATAL] В production задайте JWT_SECRET (случайная длинная строка).');
    process.exit(1);
  }
  if (JWT_SECRET === DEV_JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET не должен совпадать со значением по умолчанию для разработки.');
    process.exit(1);
  }
}

/** Хэш пароля для хранения в БД (bcrypt cost 10). */
export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

/** Проверка пароля против сохранённого bcrypt-хэша. */
export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

/** JWT для заголовка `Authorization: Bearer` (payload обычно содержит `userId`). */
export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

/** Декод JWT или `null` при невалидном/просроченном токене. */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/** JWT для URL скачивания файла документа Document Server'ом (≈10 мин). */
export function signOoDownloadToken(docId) {
  return jwt.sign({ typ: 'oo-dl', docId: +docId }, JWT_SECRET, { expiresIn: '10m' });
}

/** Проверка oo-dl токена; `{ docId }` или `null`. */
export function verifyOoDownloadToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p?.typ !== 'oo-dl' || p.docId == null) return null;
    return { docId: +p.docId };
  } catch {
    return null;
  }
}

/** JWT для одноразового импорта через Conversion API (идентификатор временного файла, ≈20 мин). */
export function signOoImportToken(importId) {
  return jwt.sign({ typ: 'oo-imp', importId: String(importId) }, JWT_SECRET, { expiresIn: '20m' });
}

/** Проверка oo-imp токена; `{ importId }` или `null`. */
export function verifyOoImportToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p?.typ !== 'oo-imp' || !p.importId) return null;
    return { importId: String(p.importId) };
  } catch {
    return null;
  }
}

/**
 * JWT для URL скачивания вложения чата Document Server'ом (OnlyOffice).
 * @param {object} [opts]
 * @param {boolean} [opts.longLived] — дольше живёт токен при длительном редактировании в редакторе
 */
export function signOoChatAttachmentToken(attachmentId, opts = {}) {
  const long = !!opts.longLived;
  return jwt.sign({ typ: 'oo-chat-att', attId: +attachmentId }, JWT_SECRET, {
    expiresIn: long ? '8h' : '15m',
  });
}

/** Проверка oo-chat-att; `{ attId }` или `null`. */
export function verifyOoChatAttachmentToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p?.typ !== 'oo-chat-att' || p.attId == null) return null;
    return { attId: +p.attId };
  } catch {
    return null;
  }
}

/** JWT для URL скачивания вложения объявления Document Server'ом (OnlyOffice). */
export function signOoAnnouncementAttachmentToken(attachmentId, opts = {}) {
  const long = !!opts.longLived;
  return jwt.sign({ typ: 'oo-ann-att', attId: +attachmentId }, JWT_SECRET, {
    expiresIn: long ? '8h' : '15m',
  });
}

/** Проверка oo-ann-att; `{ attId }` или `null`. */
export function verifyOoAnnouncementAttachmentToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p?.typ !== 'oo-ann-att' || p.attId == null) return null;
    return { attId: +p.attId };
  } catch {
    return null;
  }
}

/**
 * Случайный суффикс 8 hex-символов (~4e9 вариантов) — низкая вероятность коллизии при UNIQUE в БД.
 */
export function generateTag(seed) {
  const base = String(seed ?? 'user')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 10) || 'user';
  const suffix = randomBytes(4).toString('hex');
  return `${base}_${suffix}`;
}
