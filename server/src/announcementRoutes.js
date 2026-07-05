/**
 * @fileoverview API объявлений группы с подтверждением ознакомления.
 * Подключается из `routes.js` через `appendAnnouncementRoutes`.
 */

import { getDb } from './db.js';
import { requireAuth } from './middleware.js';
import { upload, detectKind, normalizePossibleMultipartFilename } from './upload.js';
import { writeAudit } from './auditLog.js';

function sqliteUtcToIso(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) return s;
  if (s.includes('T')) return s.endsWith('Z') ? s : `${s}Z`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return `${s.replace(' ', 'T')}Z`;
  return s;
}

function rowUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    tag: u.tag,
    bio: u.bio || '',
    avatarUrl: u.avatar_file ? `/uploads/${u.avatar_file}` : null,
  };
}

function isBannedMember(db, groupId, userId) {
  const m = db
    .prepare(`SELECT banned_until FROM group_members WHERE group_id = ? AND user_id = ?`)
    .get(groupId, userId);
  if (!m) return false;
  if (!m.banned_until) return false;
  return new Date(m.banned_until) > new Date();
}

function getMembership(db, groupId, userId) {
  return db
    .prepare(`SELECT role, banned_until FROM group_members WHERE group_id = ? AND user_id = ?`)
    .get(groupId, userId);
}

function requireGroupMember(db, groupId, userId, minRole = 'member') {
  const m = getMembership(db, groupId, userId);
  if (!m || isBannedMember(db, groupId, userId)) return { ok: false, error: 'Нет доступа к чату' };
  const order = { member: 0, moderator: 1, admin: 2 };
  if (order[m.role] < order[minRole]) return { ok: false, error: 'Недостаточно прав' };
  return { ok: true, role: m.role };
}

function buildAnnouncementAttachments(db, announcementId) {
  const atts = db
    .prepare(`SELECT * FROM announcement_attachments WHERE announcement_id = ? ORDER BY id`)
    .all(announcementId);
  return atts.map((a) => ({
    id: a.id,
    url: `/uploads/${a.stored_name}`,
    fileName: normalizePossibleMultipartFilename(a.file_name) || a.file_name,
    mimeType: a.mime_type,
    kind: a.kind,
  }));
}

function buildAnnouncementPayload(db, row, viewerUserId, includeMyAck = false) {
  const author = db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.author_id);
  const payload = {
    id: row.id,
    groupId: row.group_id,
    body: row.body || '',
    createdAt: sqliteUtcToIso(row.created_at) ?? row.created_at,
    author: rowUser(author),
    attachments: buildAnnouncementAttachments(db, row.id),
  };
  if (includeMyAck && viewerUserId != null) {
    const ack = db
      .prepare(
        `SELECT status, comment, responded_at FROM announcement_acks WHERE announcement_id = ? AND user_id = ?`
      )
      .get(row.id, viewerUserId);
    payload.myStatus = ack?.status ?? null;
    payload.myComment = ack?.comment ?? null;
    payload.myRespondedAt = ack?.responded_at
      ? sqliteUtcToIso(ack.responded_at) ?? ack.responded_at
      : null;
  }
  return payload;
}

function activeAnnouncementClause(alias = 'ga') {
  return `${alias}.deleted_at IS NULL`;
}

/**
 * @param {import('express').Router} r
 * @param {import('socket.io').Server} io
 */
export function appendAnnouncementRoutes(r, io) {
  const db = getDb();
  const annUpload = upload.fields([{ name: 'files', maxCount: 12 }]);

  r.post('/groups/:id/announcements', requireAuth, annUpload, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(db, gid, req.userId, 'moderator');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const body = String(req.body?.body || '').trim();
    const files = req.files?.files || [];
    if (!body && files.length === 0) {
      return res.status(400).json({ error: 'Текст или вложения обязательны' });
    }
    const info = db
      .prepare(`INSERT INTO group_announcements (group_id, author_id, body) VALUES (?,?,?)`)
      .run(gid, req.userId, body);
    const aid = info.lastInsertRowid;
    for (const f of files) {
      const kind = detectKind(f.mimetype);
      const displayName =
        normalizePossibleMultipartFilename(f.originalname) || f.originalname || f.filename;
      db.prepare(
        `INSERT INTO announcement_attachments (announcement_id, file_name, stored_name, mime_type, kind) VALUES (?,?,?,?,?)`
      ).run(aid, displayName, f.filename, f.mimetype || 'application/octet-stream', kind);
    }
    writeAudit(db, req.userId, 'announcement_create', 'group', gid, { announcementId: aid });
    const row = db.prepare(`SELECT * FROM group_announcements WHERE id = ?`).get(aid);
    const payload = buildAnnouncementPayload(db, row, req.userId);
    io.to(`group:${gid}`).emit('announcement:new', payload);
    res.json(payload);
  });

  r.get('/groups/:id/announcements/pending', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT ga.* FROM group_announcements ga
         LEFT JOIN announcement_acks aa ON aa.announcement_id = ga.id AND aa.user_id = ?
         WHERE ga.group_id = ? AND ${activeAnnouncementClause('ga')} AND aa.user_id IS NULL
         ORDER BY ga.id ASC`
      )
      .all(req.userId, gid);
    res.json(rows.map((row) => buildAnnouncementPayload(db, row, req.userId)));
  });

  r.get('/groups/:id/announcements', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT ga.* FROM group_announcements ga WHERE ga.group_id = ? AND ${activeAnnouncementClause('ga')} ORDER BY ga.id DESC`
      )
      .all(gid);
    res.json(rows.map((row) => buildAnnouncementPayload(db, row, req.userId, true)));
  });

  r.post('/announcements/:id/respond', requireAuth, (req, res) => {
    const aid = +req.params.id;
    const ann = db.prepare(`SELECT * FROM group_announcements WHERE id = ?`).get(aid);
    if (!ann || ann.deleted_at) return res.status(404).json({ error: 'Объявление не найдено' });
    const chk = requireGroupMember(db, ann.group_id, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const status = req.body?.status;
    if (status !== 'acknowledged' && status !== 'need_more') {
      return res.status(400).json({ error: 'status: acknowledged или need_more' });
    }
    const commentRaw = req.body?.comment != null ? String(req.body.comment).trim() : '';
    const comment = status === 'need_more' ? commentRaw || null : null;
    db.prepare(
      `INSERT OR REPLACE INTO announcement_acks (announcement_id, user_id, status, comment, responded_at)
       VALUES (?,?,?,?,datetime('now'))`
    ).run(aid, req.userId, status, comment);
    const ackRow = db
      .prepare(
        `SELECT status, comment, responded_at FROM announcement_acks WHERE announcement_id = ? AND user_id = ?`
      )
      .get(aid, req.userId);
    const payload = {
      announcementId: aid,
      groupId: ann.group_id,
      userId: req.userId,
      status: ackRow.status,
      comment: ackRow.comment,
      respondedAt: sqliteUtcToIso(ackRow.responded_at) ?? ackRow.responded_at,
    };
    io.to(`group:${ann.group_id}`).emit('announcement:responded', payload);
    res.json(payload);
  });

  r.get('/announcements/:id/stats', requireAuth, (req, res) => {
    const aid = +req.params.id;
    const ann = db.prepare(`SELECT * FROM group_announcements WHERE id = ?`).get(aid);
    if (!ann || ann.deleted_at) return res.status(404).json({ error: 'Объявление не найдено' });
    const chk = requireGroupMember(db, ann.group_id, req.userId, 'moderator');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT u.id AS user_id, u.display_name, u.tag, u.avatar_file,
                aa.status, aa.comment, aa.responded_at
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         LEFT JOIN announcement_acks aa ON aa.announcement_id = ? AND aa.user_id = gm.user_id
         WHERE gm.group_id = ?
         ORDER BY u.display_name COLLATE NOCASE`
      )
      .all(aid, ann.group_id);
    const members = rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      tag: r.tag,
      avatarUrl: r.avatar_file ? `/uploads/${r.avatar_file}` : null,
      status: r.status === 'acknowledged' ? 'acknowledged' : r.status === 'need_more' ? 'need_more' : 'pending',
      comment: r.comment || null,
      respondedAt: r.responded_at ? sqliteUtcToIso(r.responded_at) ?? r.responded_at : null,
    }));
    const summary = {
      total: members.length,
      acknowledged: members.filter((m) => m.status === 'acknowledged').length,
      needMore: members.filter((m) => m.status === 'need_more').length,
      pending: members.filter((m) => m.status === 'pending').length,
    };
    res.json({
      announcement: buildAnnouncementPayload(db, ann, req.userId),
      summary,
      members,
    });
  });

  r.delete('/announcements/:id', requireAuth, (req, res) => {
    const aid = +req.params.id;
    const ann = db.prepare(`SELECT * FROM group_announcements WHERE id = ?`).get(aid);
    if (!ann || ann.deleted_at) return res.status(404).json({ error: 'Объявление не найдено' });
    const m = getMembership(db, ann.group_id, req.userId);
    if (!m || isBannedMember(db, ann.group_id, req.userId)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    const isAuthor = ann.author_id === req.userId;
    const isAdmin = m.role === 'admin';
    if (!isAuthor && !isAdmin) return res.status(403).json({ error: 'Недостаточно прав' });
    db.prepare(`UPDATE group_announcements SET deleted_at = datetime('now') WHERE id = ?`).run(aid);
    writeAudit(db, req.userId, 'announcement_delete', 'group', ann.group_id, { announcementId: aid });
    io.to(`group:${ann.group_id}`).emit('announcement:deleted', { announcementId: aid, groupId: ann.group_id });
    res.json({ ok: true });
  });
}
