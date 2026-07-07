/**
 * @fileoverview Генерация JPEG-миниатюр для вложений-изображений (sharp).
 */

import path from 'node:path';
import fs from 'node:fs';
import { uploadsDir } from './upload.js';

let sharpMod = null;

async function getSharp() {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = (await import('sharp')).default;
  } catch {
    sharpMod = null;
  }
  return sharpMod;
}

/**
 * Создаёт `_thumb.jpg` рядом с исходником; возвращает basename или null.
 * @param {string} storedName — имя файла в uploads (как в БД)
 * @returns {Promise<string | null>}
 */
export async function generateImageThumbnail(storedName) {
  const base = path.basename(String(storedName || ''));
  if (!base || base.includes('..')) return null;
  const srcPath = path.join(uploadsDir, base);
  if (!fs.existsSync(srcPath)) return null;
  const sharp = await getSharp();
  if (!sharp) return null;
  const stem = base.replace(/\.[^.]+$/, '') || base;
  const thumbName = `${stem}_thumb.jpg`;
  const thumbPath = path.join(uploadsDir, thumbName);
  try {
    await sharp(srcPath)
      .rotate()
      .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(thumbPath);
    return thumbName;
  } catch (e) {
    console.warn('[thumbnails]', base, e?.message || e);
    try {
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    } catch {
      /* ignore */
    }
    return null;
  }
}
