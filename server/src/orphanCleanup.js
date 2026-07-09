/**
 * @fileoverview Удаление файлов из uploads/, на которые нет ссылок в БД (старт сервера / admin).
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { uploadsDir } from './upload.js';
import { safeUnlinkStoredUploadFile } from './uploadCleanup.js';

/**
 * Собирает все referenced stored names из SQLite.
 * @param {import('better-sqlite3').Database} db
 * @returns {Set<string>}
 */
function collectReferencedUploadNames(db) {
  const refs = new Set();
  const add = (name) => {
    if (name && typeof name === 'string') refs.add(path.basename(name));
  };
  for (const r of db.prepare(`SELECT stored_name, thumb_stored_name FROM message_attachments`).all()) {
    add(r.stored_name);
    add(r.thumb_stored_name);
  }
  for (const r of db.prepare(`SELECT stored_name FROM task_attachments`).all()) add(r.stored_name);
  for (const r of db.prepare(`SELECT stored_name FROM announcement_attachments`).all()) add(r.stored_name);
  for (const r of db.prepare(`SELECT avatar_file FROM users WHERE avatar_file IS NOT NULL`).all()) add(r.avatar_file);
  for (const r of db.prepare(`SELECT preview_stored_name FROM collab_documents WHERE preview_stored_name IS NOT NULL`).all())
    add(r.preview_stored_name);
  for (const r of db
    .prepare(`SELECT file_stored_name FROM task_board_canvas_items WHERE file_stored_name IS NOT NULL`)
    .all()) add(r.file_stored_name);
  return refs;
}

/**
 * Удаляет осиротевшие файлы в uploads/. Возвращает число удалённых.
 * @param {{ dryRun?: boolean }} [opts]
 */
export function cleanupOrphanUploadFiles(opts = {}) {
  const db = getDb();
  const refs = collectReferencedUploadNames(db);
  if (!fs.existsSync(uploadsDir)) return 0;
  let removed = 0;
  for (const ent of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
    // Каталог archives/ — постоянный архив для админа сервера, не трогаем.
    if (ent.isDirectory()) continue;
    if (!ent.isFile()) continue;
    const name = ent.name;
    if (refs.has(name)) continue;
    if (opts.dryRun) {
      removed++;
      continue;
    }
    safeUnlinkStoredUploadFile(name);
    removed++;
  }
  if (removed > 0) {
    console.log(`[orphanCleanup] ${opts.dryRun ? 'would remove' : 'removed'} ${removed} orphan file(s) in uploads/`);
  }
  return removed;
}
