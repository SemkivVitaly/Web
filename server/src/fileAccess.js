/**
 * @fileoverview Проверка доступа к файлам в uploads/ и раздача по API (без публичного static).
 */

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getDb } from './db.js';
import { verifyToken } from './auth.js';
import { uploadsDir } from './upload.js';
import { cleanupOrphanUploadFiles } from './orphanCleanup.js';

/**
 * @param {import('express').Request} req
 * @returns {number | null}
 */
export function userIdFromFileRequest(req) {
  const h = req.headers.authorization;
  const bearer = h?.startsWith('Bearer ') ? h.slice(7) : null;
  const q = typeof req.query.token === 'string' ? req.query.token : null;
  const token = bearer || q;
  if (!token) return null;
  const p = verifyToken(token);
  return p?.userId ?? null;
}

function safeUploadPath(basename) {
  const base = path.basename(String(basename || ''));
  if (!base || base !== String(basename).trim() || base.includes('..')) return null;
  const abs = path.resolve(uploadsDir, base);
  const root = path.resolve(uploadsDir);
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}

function isBannedInGroup(db, groupId, userId) {
  const m = db.prepare(`SELECT banned_until FROM group_members WHERE group_id = ? AND user_id = ?`).get(groupId, userId);
  if (!m?.banned_until) return false;
  return new Date(m.banned_until) > new Date();
}

function canAccessGroup(db, groupId, userId) {
  const m = db.prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?`).get(groupId, userId);
  if (!m) return false;
  return !isBannedInGroup(db, groupId, userId);
}

/**
 * @returns {{ ok: true, filePath: string, mime: string } | { ok: false, status: number, error: string }}
 */
export function resolveAttachmentFileAccess(db, attachmentId, userId, wantThumb) {
  const att = db.prepare(`SELECT * FROM message_attachments WHERE id = ?`).get(attachmentId);
  if (!att) return { ok: false, status: 404, error: 'not found' };
  const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(att.message_id);
  if (!msg) return { ok: false, status: 404, error: 'not found' };
  if (msg.group_id != null) {
    if (!canAccessGroup(db, msg.group_id, userId)) return { ok: false, status: 403, error: 'forbidden' };
  } else if (msg.direct_id != null) {
    const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
    if (!d || (d.user_low_id !== userId && d.user_high_id !== userId))
      return { ok: false, status: 403, error: 'forbidden' };
  } else return { ok: false, status: 403, error: 'forbidden' };

  const stored =
    wantThumb && att.thumb_stored_name ? att.thumb_stored_name : att.stored_name;
  const fp = safeUploadPath(stored);
  if (!fp || !fs.existsSync(fp)) return { ok: false, status: 404, error: 'missing file' };
  const mime =
    wantThumb && att.thumb_stored_name ? 'image/jpeg' : att.mime_type || 'application/octet-stream';
  return { ok: true, filePath: fp, mime };
}

function serveBasenameIfExists(base, mime) {
  const fp = safeUploadPath(base);
  if (!fp || !fs.existsSync(fp)) return { ok: false, status: 404, error: 'missing file' };
  return { ok: true, filePath: fp, mime: mime || 'application/octet-stream' };
}

/**
 * @returns {{ ok: true, filePath: string, mime: string } | { ok: false, status: number, error: string }}
 */
export function resolveBasenameFileAccess(db, basename, userId) {
  const base = path.basename(String(basename || ''));
  if (!base) return { ok: false, status: 400, error: 'bad name' };

  const avatar = db.prepare(`SELECT 1 FROM users WHERE avatar_file = ? LIMIT 1`).get(base);
  if (avatar) return serveBasenameIfExists(base, 'image/jpeg');

  const msgAtt = db
    .prepare(
      `SELECT a.id, a.mime_type, a.stored_name, a.thumb_stored_name FROM message_attachments a
       WHERE a.stored_name = ? OR a.thumb_stored_name = ? LIMIT 1`
    )
    .get(base, base);
  if (msgAtt) {
    return resolveAttachmentFileAccess(db, msgAtt.id, userId, msgAtt.thumb_stored_name === base);
  }

  const taskAtt = db
    .prepare(
      `SELECT ta.mime_type, b.group_id FROM task_attachments ta
       JOIN tasks t ON t.id = ta.task_id JOIN task_boards b ON b.id = t.board_id
       WHERE ta.stored_name = ? LIMIT 1`
    )
    .get(base);
  if (taskAtt) {
    if (!canAccessGroup(db, taskAtt.group_id, userId)) return { ok: false, status: 403, error: 'forbidden' };
    return serveBasenameIfExists(base, taskAtt.mime_type);
  }

  const ann = db
    .prepare(
      `SELECT aa.mime_type, ga.group_id, ga.deleted_at FROM announcement_attachments aa
       JOIN group_announcements ga ON ga.id = aa.announcement_id
       WHERE aa.stored_name = ? LIMIT 1`
    )
    .get(base);
  if (ann) {
    if (ann.deleted_at) return { ok: false, status: 404, error: 'not found' };
    if (!canAccessGroup(db, ann.group_id, userId)) return { ok: false, status: 403, error: 'forbidden' };
    return serveBasenameIfExists(base, ann.mime_type);
  }

  const prev = db
    .prepare(`SELECT group_id FROM collab_documents WHERE preview_stored_name = ? LIMIT 1`)
    .get(base);
  if (prev) {
    if (!canAccessGroup(db, prev.group_id, userId)) return { ok: false, status: 403, error: 'forbidden' };
    return serveBasenameIfExists(base, 'image/jpeg');
  }

  const canvas = db
    .prepare(
      `SELECT c.file_mime, b.group_id FROM task_board_canvas_items c
       JOIN task_boards b ON b.id = c.board_id
       WHERE c.file_stored_name = ? LIMIT 1`
    )
    .get(base);
  if (canvas) {
    if (!canAccessGroup(db, canvas.group_id, userId)) return { ok: false, status: 403, error: 'forbidden' };
    return serveBasenameIfExists(base, canvas.file_mime);
  }

  return { ok: false, status: 404, error: 'not found' };
}

/** URL для вложения сообщения в JSON API. */
export function attachmentApiUrl(attachmentId) {
  return `/api/files/attachment/${attachmentId}`;
}

/** URL для произвольного файла по stored basename (аватар, задачи, превью). */
export function uploadBasenameApiUrl(basename) {
  if (!basename) return null;
  return `/api/files/by-name/${encodeURIComponent(path.basename(basename))}`;
}

/**
 * @param {express.Router} r — роутер API (префикс /api уже снаружи)
 */
export function appendFileRoutes(r) {
  r.get('/files/attachment/:id', (req, res) => {
    const userId = userIdFromFileRequest(req);
    if (!userId) return res.status(401).json({ error: 'Требуется авторизация' });
    const attId = +req.params.id;
    if (!Number.isFinite(attId) || attId <= 0) return res.status(400).json({ error: 'bad id' });
    const db = getDb();
    const wantThumb = req.query.thumb === '1';
    const access = resolveAttachmentFileAccess(db, attId, userId, wantThumb);
    if (!access.ok) {
      if (access.status === 403) return res.status(403).json({ error: 'Нет доступа' });
      if (access.status === 404) return res.status(404).json({ error: 'Не найдено' });
      return res.status(access.status).json({ error: access.error });
    }
    res.setHeader('Content-Type', access.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(access.filePath);
  });

  r.get('/files/by-name/:basename', (req, res) => {
    const userId = userIdFromFileRequest(req);
    if (!userId) return res.status(401).json({ error: 'Требуется авторизация' });
    const db = getDb();
    const access = resolveBasenameFileAccess(db, req.params.basename, userId);
    if (!access.ok) {
      if (access.status === 403) return res.status(403).json({ error: 'Нет доступа' });
      return res.status(404).json({ error: 'Не найдено' });
    }
    res.setHeader('Content-Type', access.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(access.filePath);
  });

  r.post('/admin/cleanup-orphan-uploads', (req, res) => {
    const userId = userIdFromFileRequest(req);
    if (!userId) return res.status(401).json({ error: 'Требуется авторизация' });
    const removed = cleanupOrphanUploadFiles();
    res.json({ ok: true, removed });
  });
}
