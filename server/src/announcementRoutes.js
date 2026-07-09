/**
 * @fileoverview API объявлений, уведомлений и назначений группы с подтверждением ознакомления.
 * Подключается из `routes.js` через `appendAnnouncementRoutes`.
 */

import { getDb } from './db.js';
import { requireAuth } from './middleware.js';
import { upload, detectKind, normalizePossibleMultipartFilename } from './upload.js';
import { writeAudit } from './auditLog.js';
import { uploadBasenameApiUrl } from './fileAccess.js';

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
    avatarUrl: u.avatar_file ? uploadBasenameApiUrl(u.avatar_file) : null,
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

function taskOwnProgressFromRow(t) {
  if (!t) return 0;
  const target = t.quantity_target;
  const done = t.quantity_done ?? 0;
  if (target != null && target > 0) {
    return Math.min(100, Math.floor((100 * done) / target));
  }
  return Math.min(100, Math.max(0, +(t.progress ?? 0)));
}

function parseRecipientUserIds(body) {
  const raw = body?.recipientUserIds;
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((x) => +x).filter((x) => x > 0);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((x) => +x).filter((x) => x > 0);
    } catch {
      return raw
        .split(/[,;\s]+/)
        .map((x) => +x.trim())
        .filter((x) => x > 0);
    }
  }
  return [];
}

function getRecipientIds(db, ann) {
  if ((ann.audience || 'all') === 'all') {
    return db
      .prepare(
        `SELECT user_id FROM group_members
         WHERE group_id = ?
         AND (banned_until IS NULL OR datetime(banned_until) <= datetime('now'))`
      )
      .all(ann.group_id)
      .map((r) => r.user_id);
  }
  return db
    .prepare(`SELECT user_id FROM announcement_recipients WHERE announcement_id = ?`)
    .all(ann.id)
    .map((r) => r.user_id);
}

function isUserInAudience(db, ann, userId) {
  if ((ann.audience || 'all') === 'all') {
    return !!getMembership(db, ann.group_id, userId) && !isBannedMember(db, ann.group_id, userId);
  }
  return !!db
    .prepare(`SELECT 1 FROM announcement_recipients WHERE announcement_id = ? AND user_id = ?`)
    .get(ann.id, userId);
}

function audienceFilterSql(userIdParam = '?') {
  return `(ga.audience = 'all' OR EXISTS (
    SELECT 1 FROM announcement_recipients ar
    WHERE ar.announcement_id = ga.id AND ar.user_id = ${userIdParam}
  ))`;
}

function buildLinkedTaskSnapshot(db, taskId) {
  if (!taskId) return null;
  const t = db
    .prepare(
      `SELECT t.*, b.id AS board_id, b.name AS board_name
       FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`
    )
    .get(taskId);
  if (!t) return null;
  const assignee = t.assignee_id
    ? rowUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(t.assignee_id))
    : null;
  return {
    id: t.id,
    title: t.title,
    boardId: t.board_id,
    boardName: t.board_name,
    status: t.status,
    progress: taskOwnProgressFromRow(t),
    quantityTarget: t.quantity_target,
    quantityDone: t.quantity_done ?? 0,
    assignee,
  };
}

function buildProgressLog(db, announcementId, userId, limit = 20) {
  return db
    .prepare(
      `SELECT id, task_status, progress, quantity_done, note, created_at
       FROM announcement_progress_log
       WHERE announcement_id = ? AND user_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(announcementId, userId, limit)
    .map((r) => ({
      id: r.id,
      taskStatus: r.task_status,
      progress: r.progress,
      quantityDone: r.quantity_done,
      note: r.note,
      createdAt: sqliteUtcToIso(r.created_at) ?? r.created_at,
    }));
}

function buildAnnouncementAttachments(db, announcementId) {
  const atts = db
    .prepare(`SELECT * FROM announcement_attachments WHERE announcement_id = ? ORDER BY id`)
    .all(announcementId);
  return atts.map((a) => ({
    id: a.id,
    url: uploadBasenameApiUrl(a.stored_name),
    fileName: normalizePossibleMultipartFilename(a.file_name) || a.file_name,
    mimeType: a.mime_type,
    kind: a.kind,
  }));
}

function buildAnnouncementPayload(db, row, viewerUserId, includeMyAck = false) {
  const author = db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.author_id);
  const kind = row.kind || 'notice';
  const audience = row.audience || 'all';
  const recipientRows =
    audience === 'selected'
      ? db
          .prepare(
            `SELECT u.* FROM announcement_recipients ar
             JOIN users u ON u.id = ar.user_id
             WHERE ar.announcement_id = ?`
          )
          .all(row.id)
      : [];
  const payload = {
    id: row.id,
    groupId: row.group_id,
    kind,
    audience,
    body: row.body || '',
    createdAt: sqliteUtcToIso(row.created_at) ?? row.created_at,
    dueAt: row.due_at ? sqliteUtcToIso(row.due_at) ?? row.due_at : null,
    quantityTarget: row.quantity_target ?? null,
    author: rowUser(author),
    attachments: buildAnnouncementAttachments(db, row.id),
    recipients: recipientRows.map((u) => rowUser(u)),
    linkedTask: kind === 'linked_task' ? buildLinkedTaskSnapshot(db, row.linked_task_id) : null,
  };
  if (includeMyAck && viewerUserId != null) {
    const ack = db
      .prepare(
        `SELECT status, comment, responded_at, task_status, progress, quantity_done, progress_note
         FROM announcement_acks WHERE announcement_id = ? AND user_id = ?`
      )
      .get(row.id, viewerUserId);
    payload.myStatus = ack?.status ?? null;
    payload.myComment = ack?.comment ?? null;
    payload.myRespondedAt = ack?.responded_at
      ? sqliteUtcToIso(ack.responded_at) ?? ack.responded_at
      : null;
    payload.myTaskStatus = ack?.task_status ?? null;
    payload.myProgress = ack?.progress ?? null;
    payload.myQuantityDone = ack?.quantity_done ?? null;
    payload.myProgressNote = ack?.progress_note ?? null;
  }
  return payload;
}

function activeAnnouncementClause(alias = 'ga') {
  return `${alias}.deleted_at IS NULL`;
}

function emitAnnouncementNew(io, groupId, payload, audience, recipientIds) {
  io.to(`group:${groupId}`).emit('announcement:new', payload);
  if (audience === 'selected') {
    for (const uid of recipientIds) {
      io.to(`user:${uid}`).emit('announcement:new', payload);
    }
  }
}

function assignmentBadgeCount(db, groupId, userId) {
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS c FROM group_announcements ga
       LEFT JOIN announcement_acks aa ON aa.announcement_id = ga.id AND aa.user_id = ?
       WHERE ga.group_id = ? AND ${activeAnnouncementClause('ga')}
       AND aa.user_id IS NULL AND ${audienceFilterSql()}`
    )
    .get(userId, groupId, userId).c;

  const open = db
    .prepare(
      `SELECT COUNT(*) AS c FROM group_announcements ga
       JOIN announcement_acks aa ON aa.announcement_id = ga.id AND aa.user_id = ?
       WHERE ga.group_id = ? AND ${activeAnnouncementClause('ga')}
       AND ga.kind IN ('assignment','linked_task')
       AND ${audienceFilterSql()}
       AND (
         (ga.kind = 'assignment' AND (aa.task_status IS NULL OR aa.task_status != 'done'))
         OR (ga.kind = 'linked_task' AND EXISTS (
           SELECT 1 FROM tasks t WHERE t.id = ga.linked_task_id AND t.status != 'done'
         ))
       )`
    )
    .get(userId, groupId, userId).c;

  return pending + open;
}

/**
 * @param {import('express').Router} r
 * @param {import('socket.io').Server} io
 */
export function appendAnnouncementRoutes(r, io) {
  const db = getDb();
  const annUpload = upload.fields([{ name: 'files', maxCount: 12 }]);

  r.get('/chats/assignment-badges', requireAuth, (req, res) => {
    const uid = req.userId;
    const groupRows = db
      .prepare(
        `SELECT gm.group_id AS id FROM group_members gm
         WHERE gm.user_id = ?
         AND (gm.banned_until IS NULL OR datetime(gm.banned_until) <= datetime('now'))`
      )
      .all(uid);
    const groups = {};
    for (const { id } of groupRows) {
      groups[id] = assignmentBadgeCount(db, id, uid);
    }
    res.json({ groups });
  });

  r.post('/groups/:id/announcements', requireAuth, annUpload, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(db, gid, req.userId, 'moderator');
    if (!chk.ok) return res.status(403).json({ error: chk.error });

    const kind = String(req.body?.kind || 'notice');
    if (!['notice', 'assignment', 'linked_task'].includes(kind)) {
      return res.status(400).json({ error: 'kind: notice, assignment или linked_task' });
    }
    const audience = String(req.body?.audience || 'all');
    if (!['all', 'selected'].includes(audience)) {
      return res.status(400).json({ error: 'audience: all или selected' });
    }
    const recipientUserIds = parseRecipientUserIds(req.body);
    if (audience === 'selected' && recipientUserIds.length === 0) {
      return res.status(400).json({ error: 'Выберите хотя бы одного получателя' });
    }

    const body = String(req.body?.body || '').trim();
    const files = req.files?.files || [];
    const linkedTaskId = req.body?.linkedTaskId != null ? +req.body.linkedTaskId : null;
    const dueAt = req.body?.dueAt ? String(req.body.dueAt).trim() || null : null;
    const quantityTarget =
      req.body?.quantityTarget != null && req.body.quantityTarget !== ''
        ? +req.body.quantityTarget
        : null;
    const setAssignee = req.body?.setAssignee === 'true' || req.body?.setAssignee === true;

    if (kind === 'linked_task') {
      if (!linkedTaskId) return res.status(400).json({ error: 'linkedTaskId обязателен' });
      const taskRow = db
        .prepare(
          `SELECT t.id, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`
        )
        .get(linkedTaskId);
      if (!taskRow || taskRow.group_id !== gid) {
        return res.status(400).json({ error: 'Задача не найдена в этой группе' });
      }
    }

    if (!body && files.length === 0 && kind !== 'linked_task') {
      return res.status(400).json({ error: 'Текст или вложения обязательны' });
    }

    for (const uid of recipientUserIds) {
      const m = getMembership(db, gid, uid);
      if (!m || isBannedMember(db, gid, uid)) {
        return res.status(400).json({ error: `Пользователь ${uid} не является участником группы` });
      }
    }

    const info = db
      .prepare(
        `INSERT INTO group_announcements
         (group_id, author_id, body, kind, audience, linked_task_id, due_at, quantity_target)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        gid,
        req.userId,
        body,
        kind,
        audience,
        kind === 'linked_task' ? linkedTaskId : null,
        dueAt,
        kind === 'assignment' && quantityTarget != null && quantityTarget > 0 ? quantityTarget : null
      );
    const aid = info.lastInsertRowid;

    if (audience === 'selected') {
      const ins = db.prepare(
        `INSERT INTO announcement_recipients (announcement_id, user_id) VALUES (?,?)`
      );
      for (const uid of recipientUserIds) ins.run(aid, uid);
    }

    if (kind === 'linked_task' && setAssignee && recipientUserIds.length === 1) {
      db.prepare(`UPDATE tasks SET assignee_id = ? WHERE id = ?`).run(recipientUserIds[0], linkedTaskId);
    }

    for (const f of files) {
      const fileKind = detectKind(f.mimetype);
      const displayName =
        normalizePossibleMultipartFilename(f.originalname) || f.originalname || f.filename;
      db.prepare(
        `INSERT INTO announcement_attachments (announcement_id, file_name, stored_name, mime_type, kind) VALUES (?,?,?,?,?)`
      ).run(aid, displayName, f.filename, f.mimetype || 'application/octet-stream', fileKind);
    }

    const auditAction =
      kind === 'notice' ? 'announcement_create' : 'assignment_create';
    writeAudit(db, req.userId, auditAction, 'group', gid, {
      announcementId: aid,
      kind,
      audience,
      recipientCount: audience === 'selected' ? recipientUserIds.length : null,
    });

    const row = db.prepare(`SELECT * FROM group_announcements WHERE id = ?`).get(aid);
    const payload = buildAnnouncementPayload(db, row, req.userId);
    const recipients = audience === 'selected' ? recipientUserIds : getRecipientIds(db, row);
    emitAnnouncementNew(io, gid, payload, audience, recipients);
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
         AND ${audienceFilterSql()}
         ORDER BY ga.id ASC`
      )
      .all(req.userId, gid, req.userId);
    res.json(rows.map((row) => buildAnnouncementPayload(db, row, req.userId)));
  });

  r.get('/groups/:id/announcements/my-assignments', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT ga.* FROM group_announcements ga
         JOIN announcement_acks aa ON aa.announcement_id = ga.id AND aa.user_id = ?
         WHERE ga.group_id = ? AND ${activeAnnouncementClause('ga')}
         AND ga.kind IN ('assignment','linked_task')
         AND ${audienceFilterSql()}
         AND (
           (ga.kind = 'assignment' AND (aa.task_status IS NULL OR aa.task_status != 'done'))
           OR (ga.kind = 'linked_task' AND EXISTS (
             SELECT 1 FROM tasks t WHERE t.id = ga.linked_task_id AND t.status != 'done'
           ))
         )
         ORDER BY ga.id ASC`
      )
      .all(req.userId, gid, req.userId);

    res.json(
      rows.map((row) => {
        const payload = buildAnnouncementPayload(db, row, req.userId, true);
        payload.progressLog = buildProgressLog(db, row.id, req.userId);
        return payload;
      })
    );
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
    if (!isUserInAudience(db, ann, req.userId)) {
      return res.status(403).json({ error: 'Вы не в списке получателей' });
    }

    const kind = ann.kind || 'notice';
    const status = req.body?.status;
    if (status !== 'acknowledged' && status !== 'need_more') {
      return res.status(400).json({ error: 'status: acknowledged или need_more' });
    }
    if (kind !== 'notice' && status === 'need_more') {
      return res.status(400).json({ error: 'Для назначений доступно только подтверждение' });
    }

    const commentRaw = req.body?.comment != null ? String(req.body.comment).trim() : '';
    const comment = status === 'need_more' ? commentRaw || null : null;
    const taskStatus = kind !== 'notice' && status === 'acknowledged' ? 'todo' : null;
    const progress = kind === 'assignment' && status === 'acknowledged' ? 0 : null;
    const quantityDone = kind === 'assignment' && status === 'acknowledged' ? 0 : null;

    db.prepare(
      `INSERT INTO announcement_acks
       (announcement_id, user_id, status, comment, responded_at, task_status, progress, quantity_done)
       VALUES (?,?,?,?,datetime('now'),?,?,?)
       ON CONFLICT(announcement_id, user_id) DO UPDATE SET
         status = excluded.status,
         comment = excluded.comment,
         responded_at = excluded.responded_at,
         task_status = COALESCE(excluded.task_status, announcement_acks.task_status),
         progress = COALESCE(excluded.progress, announcement_acks.progress),
         quantity_done = COALESCE(excluded.quantity_done, announcement_acks.quantity_done)`
    ).run(aid, req.userId, status, comment, taskStatus, progress, quantityDone);

    const ackRow = db
      .prepare(
        `SELECT status, comment, responded_at, task_status, progress, quantity_done
         FROM announcement_acks WHERE announcement_id = ? AND user_id = ?`
      )
      .get(aid, req.userId);
    const payload = {
      announcementId: aid,
      groupId: ann.group_id,
      userId: req.userId,
      status: ackRow.status,
      comment: ackRow.comment,
      respondedAt: sqliteUtcToIso(ackRow.responded_at) ?? ackRow.responded_at,
      taskStatus: ackRow.task_status,
      progress: ackRow.progress,
      quantityDone: ackRow.quantity_done,
    };
    io.to(`group:${ann.group_id}`).emit('announcement:responded', payload);
    res.json(payload);
  });

  r.post('/announcements/:id/progress', requireAuth, (req, res) => {
    const aid = +req.params.id;
    const ann = db.prepare(`SELECT * FROM group_announcements WHERE id = ?`).get(aid);
    if (!ann || ann.deleted_at) return res.status(404).json({ error: 'Объявление не найдено' });
    if ((ann.kind || 'notice') !== 'assignment') {
      return res.status(400).json({ error: 'Прогресс можно обновлять только для быстрых задач' });
    }
    const chk = requireGroupMember(db, ann.group_id, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    if (!isUserInAudience(db, ann, req.userId)) {
      return res.status(403).json({ error: 'Вы не в списке получателей' });
    }

    const ack = db
      .prepare(`SELECT 1 FROM announcement_acks WHERE announcement_id = ? AND user_id = ?`)
      .get(aid, req.userId);
    if (!ack) return res.status(400).json({ error: 'Сначала подтвердите назначение' });

    const taskStatus = req.body?.taskStatus;
    if (taskStatus != null && !['todo', 'in_progress', 'done'].includes(taskStatus)) {
      return res.status(400).json({ error: 'taskStatus: todo, in_progress или done' });
    }
    let progress =
      req.body?.progress != null && req.body.progress !== '' ? +req.body.progress : undefined;
    if (progress != null) progress = Math.min(100, Math.max(0, progress));
    const quantityDone =
      req.body?.quantityDone != null && req.body.quantityDone !== ''
        ? Math.max(0, +req.body.quantityDone)
        : undefined;
    const note = req.body?.note != null ? String(req.body.note).trim() || null : null;

    const cur = db
      .prepare(
        `SELECT task_status, progress, quantity_done FROM announcement_acks WHERE announcement_id = ? AND user_id = ?`
      )
      .get(aid, req.userId);

    const newTaskStatus = taskStatus ?? cur.task_status ?? 'todo';
    let newProgress = progress ?? cur.progress ?? 0;
    const newQty = quantityDone ?? cur.quantity_done ?? 0;

    if (ann.quantity_target != null && ann.quantity_target > 0 && quantityDone != null) {
      newProgress = Math.min(100, Math.floor((100 * newQty) / ann.quantity_target));
    }
    if (newTaskStatus === 'done') newProgress = 100;

    db.prepare(
      `UPDATE announcement_acks SET task_status = ?, progress = ?, quantity_done = ?, progress_note = ?, responded_at = datetime('now')
       WHERE announcement_id = ? AND user_id = ?`
    ).run(newTaskStatus, newProgress, newQty, note, aid, req.userId);

    db.prepare(
      `INSERT INTO announcement_progress_log (announcement_id, user_id, task_status, progress, quantity_done, note)
       VALUES (?,?,?,?,?,?)`
    ).run(aid, req.userId, newTaskStatus, newProgress, newQty, note);

    writeAudit(db, req.userId, 'assignment_progress', 'group', ann.group_id, {
      announcementId: aid,
      taskStatus: newTaskStatus,
      progress: newProgress,
    });

    const payload = {
      announcementId: aid,
      groupId: ann.group_id,
      userId: req.userId,
      taskStatus: newTaskStatus,
      progress: newProgress,
      quantityDone: newQty,
      note,
    };
    io.to(`group:${ann.group_id}`).emit('announcement:progress', payload);
    res.json(payload);
  });

  r.get('/announcements/:id/stats', requireAuth, (req, res) => {
    const aid = +req.params.id;
    const ann = db.prepare(`SELECT * FROM group_announcements WHERE id = ?`).get(aid);
    if (!ann || ann.deleted_at) return res.status(404).json({ error: 'Объявление не найдено' });
    const chk = requireGroupMember(db, ann.group_id, req.userId, 'moderator');
    if (!chk.ok) return res.status(403).json({ error: chk.error });

    const kind = ann.kind || 'notice';
    const audience = ann.audience || 'all';
    let rows;
    if (audience === 'selected') {
      rows = db
        .prepare(
          `SELECT u.id AS user_id, u.display_name, u.tag, u.avatar_file,
                  aa.status, aa.comment, aa.responded_at, aa.task_status, aa.progress,
                  aa.quantity_done, aa.progress_note
           FROM announcement_recipients ar
           JOIN users u ON u.id = ar.user_id
           LEFT JOIN announcement_acks aa ON aa.announcement_id = ? AND aa.user_id = ar.user_id
           WHERE ar.announcement_id = ?
           ORDER BY u.display_name COLLATE NOCASE`
        )
        .all(aid, aid);
    } else {
      rows = db
        .prepare(
          `SELECT u.id AS user_id, u.display_name, u.tag, u.avatar_file,
                  aa.status, aa.comment, aa.responded_at, aa.task_status, aa.progress,
                  aa.quantity_done, aa.progress_note
           FROM group_members gm
           JOIN users u ON u.id = gm.user_id
           LEFT JOIN announcement_acks aa ON aa.announcement_id = ? AND aa.user_id = gm.user_id
           WHERE gm.group_id = ?
           AND (gm.banned_until IS NULL OR datetime(gm.banned_until) <= datetime('now'))
           ORDER BY u.display_name COLLATE NOCASE`
        )
        .all(aid, ann.group_id);
    }

    const linkedTask = kind === 'linked_task' ? buildLinkedTaskSnapshot(db, ann.linked_task_id) : null;

    const members = rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      tag: r.tag,
      avatarUrl: r.avatar_file ? uploadBasenameApiUrl(r.avatar_file) : null,
      status:
        r.status === 'acknowledged'
          ? 'acknowledged'
          : r.status === 'need_more'
            ? 'need_more'
            : 'pending',
      comment: r.comment || null,
      respondedAt: r.responded_at ? sqliteUtcToIso(r.responded_at) ?? r.responded_at : null,
      taskStatus: r.task_status || null,
      progress: r.progress ?? null,
      quantityDone: r.quantity_done ?? null,
      progressNote: r.progress_note || null,
    }));

    const summary = {
      total: members.length,
      acknowledged: members.filter((m) => m.status === 'acknowledged').length,
      needMore: members.filter((m) => m.status === 'need_more').length,
      pending: members.filter((m) => m.status === 'pending').length,
      inProgress: members.filter((m) => m.taskStatus === 'in_progress').length,
      done: members.filter((m) => m.taskStatus === 'done').length,
    };

    res.json({
      announcement: buildAnnouncementPayload(db, ann, req.userId),
      linkedTask,
      summary,
      members,
    });
  });

  r.get('/announcements/:id/progress-log', requireAuth, (req, res) => {
    const aid = +req.params.id;
    const ann = db.prepare(`SELECT * FROM group_announcements WHERE id = ?`).get(aid);
    if (!ann || ann.deleted_at) return res.status(404).json({ error: 'Не найдено' });
    const chk = requireGroupMember(db, ann.group_id, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });

    const targetUserId = req.query.userId != null ? +req.query.userId : req.userId;
    const isMod = requireGroupMember(db, ann.group_id, req.userId, 'moderator').ok;
    if (targetUserId !== req.userId && !isMod) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    if (!isUserInAudience(db, ann, targetUserId)) {
      return res.status(400).json({ error: 'Пользователь не в аудитории' });
    }

    res.json(buildProgressLog(db, aid, targetUserId, 50));
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
    const deletedPayload = { announcementId: aid, groupId: ann.group_id };
    io.to(`group:${ann.group_id}`).emit('announcement:deleted', deletedPayload);
    if ((ann.audience || 'all') === 'selected') {
      const recipientIds = db
        .prepare(`SELECT user_id FROM announcement_recipients WHERE announcement_id = ?`)
        .all(aid)
        .map((r) => r.user_id);
      for (const uid of recipientIds) {
        io.to(`user:${uid}`).emit('announcement:deleted', deletedPayload);
      }
    }
    res.json({ ok: true });
  });
}
