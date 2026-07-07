/**
 * @fileoverview Вставка вложений сообщения: MIME/magic/size, миниатюры для изображений.
 */

import path from 'node:path';
import { detectKind, uploadsDir, normalizePossibleMultipartFilename } from './upload.js';
import { validateImageMagicBytes, MAX_IMAGE_UPLOAD_BYTES } from './uploadSecurity.js';
import { generateImageThumbnail } from './thumbnails.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} messageId
 * @param {Express.Multer.File[]} files
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function insertMessageAttachmentRows(db, messageId, files) {
  for (const f of files) {
    const kind = detectKind(f.mimetype);
    if (kind === 'image' && f.size > MAX_IMAGE_UPLOAD_BYTES) {
      return {
        ok: false,
        status: 400,
        error: `Изображение слишком большое (макс. ${Math.round(MAX_IMAGE_UPLOAD_BYTES / 1024 / 1024)} МБ)`,
      };
    }
    const fp = path.join(uploadsDir, path.basename(f.filename));
    if (kind === 'image') {
      const magic = validateImageMagicBytes(fp, f.mimetype);
      if (!magic.ok) return { ok: false, status: 400, error: magic.error };
    }
    let thumbName = null;
    if (kind === 'image') {
      thumbName = await generateImageThumbnail(f.filename);
    }
    db.prepare(
      `INSERT INTO message_attachments (message_id, file_name, stored_name, thumb_stored_name, mime_type, kind) VALUES (?,?,?,?,?,?)`
    ).run(
      messageId,
      normalizePossibleMultipartFilename(f.originalname) || f.originalname || f.filename,
      f.filename,
      thumbName,
      f.mimetype || 'application/octet-stream',
      kind
    );
  }
  return { ok: true };
}
