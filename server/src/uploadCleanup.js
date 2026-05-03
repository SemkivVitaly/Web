/**
 * @fileoverview Безопасное удаление файлов из `uploads/`: только basename внутри каталога загрузок, защита от `..`.
 * Используется при удалении вложений сообщений, когда запись в `message_attachments` больше не ссылается на файл.
 */

import fs from 'node:fs';
import path from 'node:path';
import { uploadsDir } from './upload.js';

/**
 * Удалить файл по `stored_name` из каталога uploads, если имя валидно и путь остаётся под `uploadsDir`.
 * @param {string | null | undefined} storedName — как в БД (`uuid.ext`)
 */
export function safeUnlinkStoredUploadFile(storedName) {
  if (storedName == null || typeof storedName !== 'string') return;
  const base = path.basename(storedName);
  if (!base || base !== String(storedName).trim() || base.includes('..')) return;
  const abs = path.resolve(uploadsDir, base);
  const root = path.resolve(uploadsDir);
  if (!abs.startsWith(root + path.sep)) return;
  try {
    fs.unlinkSync(abs);
  } catch {
    /* нет файла или нет прав */
  }
}

/**
 * Для каждого уникального `stored_name`: если в `message_attachments` не осталось ссылок — удалить файл с диска.
 * @param {import('better-sqlite3').Database} db
 * @param {Iterable<string> | null | undefined} storedNames
 */
export function unlinkOrphanMessageAttachmentFiles(db, storedNames) {
  const uniq = [...new Set((storedNames || []).filter(Boolean))];
  for (const sn of uniq) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM message_attachments WHERE stored_name = ?`).get(sn);
    if (!row || Number(row.c) === 0) safeUnlinkStoredUploadFile(sn);
  }
}
