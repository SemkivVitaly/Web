/**
 * @fileoverview API воркспейса группы: коллаборативные папки и документы (мета, Yjs, импорт),
 * доски задач с паролем, дерево задач с rollup прогресса, комментарии и вложения,
 * элементы канбана (`task_board_canvas_items`) с инкрементальной синхронизацией по сокету.
 *
 * Подключается из `routes.js` через `appendWorkspaceRoutes`. События Socket.IO:
 * `tasks:refresh`, `tasks:canvas-sync`, `collab:tree-refresh`, указатели/перетаскивание на канбане.
 */

import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { requireAuth } from './middleware.js';
import { hashPassword, verifyPassword, verifyToken } from './auth.js';
import { upload, decodeMultipartFilename } from './upload.js';
import { checkCollabDocAccess, getOrCreateYDoc, evictCollabDoc } from './collabSync.js';
import { maskProfanity } from './profanityFilter.js';
import { shouldMaskGroupTextForViewer } from './moderation.js';
import * as Y from 'yjs';
import { writeAudit } from './auditLog.js';

// --- Внутренние хелперы: аудит, маскировка текста, членство, канбан sync/hydrate, дерево задач, удаление коллаб-дерева ---

function auditGroup(db, actorId, groupId, action, meta) {
  writeAudit(db, actorId, action, 'group', groupId, meta);
}

function maskIfNeeded(db, groupId, viewerId, authorId, text) {
  if (text == null || typeof text !== 'string') return text;
  if (!shouldMaskGroupTextForViewer(db, groupId, viewerId, authorId)) return text;
  return maskProfanity(text);
}

function mapTasksForViewer(db, groupId, viewerId, nodes) {
  return nodes.map((t) => ({
    ...t,
    title: maskIfNeeded(db, groupId, viewerId, t.createdById, t.title),
    description: maskIfNeeded(db, groupId, viewerId, t.createdById, t.description),
  }));
}

/** Собственный % задачи: счётчик (done/target) или поле progress. */
function taskOwnProgressFromRow(t) {
  const target = t.quantity_target;
  const done = t.quantity_done ?? 0;
  if (target != null && target > 0) {
    return Math.min(100, Math.floor((100 * done) / target));
  }
  return Math.min(100, Math.max(0, +(t.progress ?? 0)));
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
  if (!m || isBannedMember(db, groupId, userId)) return { ok: false, error: 'Нет доступа' };
  const order = { member: 0, moderator: 1, admin: 2 };
  if (order[m.role] < order[minRole]) return { ok: false, error: 'Недостаточно прав' };
  return { ok: true, role: m.role };
}

/** Меняется при смене пароля — клиент сбрасывает сохранённые пароли */
function pwdFingerprint(passwordHash) {
  if (!passwordHash) return null;
  return crypto.createHash('sha256').update(String(passwordHash)).digest('hex').slice(0, 16);
}

function emitCollabTreeRefresh(io, groupId) {
  io.to(`group:${groupId}`).emit('collab:tree-refresh', { groupId });
}

/** Модератор и админ группы входят в любые папки и документы без пароля */
function collabPasswordBypass(db, groupId, userId) {
  return requireGroupMember(db, groupId, userId, 'moderator').ok;
}

function checkBoardAccess(db, boardId, userId, password) {
  const b = db.prepare(`SELECT * FROM task_boards WHERE id = ?`).get(boardId);
  if (!b) return { ok: false, error: 'Доска не найдена' };
  if (isBannedMember(db, b.group_id, userId) || !getMembership(db, b.group_id, userId))
    return { ok: false, error: 'Нет доступа' };
  if (b.password_hash && (!password || !verifyPassword(String(password), b.password_hash)))
    return { ok: false, error: 'Нужен пароль' };
  return { ok: true, board: b };
}

function emitTasksRefresh(io, groupId, boardId) {
  io.to(`group:${groupId}`).emit('tasks:refresh', { boardId, groupId });
}

function logTaskActivity(db, taskId, userId, action, payload) {
  try {
    db.prepare(`INSERT INTO task_activity (task_id, user_id, action, payload_json) VALUES (?,?,?,?)`).run(
      taskId,
      userId,
      action,
      JSON.stringify(payload ?? {})
    );
  } catch (e) {
    console.error('logTaskActivity', e);
  }
}

function remoteSocketUserId(remote) {
  const t = remote.handshake?.auth?.token ?? remote.handshake?.query?.token;
  const tok = typeof t === 'string' ? t : Array.isArray(t) ? t[0] : null;
  const p = verifyToken(tok);
  return p?.userId ?? null;
}

/** Инкрементальная синхронизация канваса: маскирование текста — под каждого получателя */
function scheduleCanvasSyncUpsert(io, db, groupId, boardId, rowId) {
  void (async () => {
    try {
      const row = db.prepare(`SELECT * FROM task_board_canvas_items WHERE id = ?`).get(rowId);
      if (!row || row.board_id !== boardId) return;
      const socks = await io.in(`group:${groupId}`).fetchSockets();
      for (const sock of socks) {
        const uid = remoteSocketUserId(sock);
        if (!uid) continue;
        const item = hydrateCanvasItem(db, row, groupId, uid);
        sock.emit('tasks:canvas-sync', { boardId, action: 'upsert', item });
      }
    } catch (e) {
      console.error('tasks:canvas-sync upsert', e);
    }
  })();
}

function scheduleCanvasSyncRemove(io, groupId, boardId, itemId) {
  void (async () => {
    try {
      const socks = await io.in(`group:${groupId}`).fetchSockets();
      for (const sock of socks) {
        sock.emit('tasks:canvas-sync', { boardId, action: 'remove', itemId });
      }
    } catch (e) {
      console.error('tasks:canvas-sync remove', e);
    }
  })();
}

function hydrateCanvasItem(db, row, groupId, viewerId) {
  const base = {
    id: row.id,
    boardId: row.board_id,
    kind: row.kind,
    title: row.title || '',
    taskId: row.task_id,
    collabDocumentId: row.collab_document_id,
    fileUrl: row.file_stored_name ? `/uploads/${row.file_stored_name}` : null,
    fileName: row.file_original_name,
    fileMime: row.file_mime,
    parentItemId: row.parent_item_id,
    positionX: row.position_x,
    positionY: row.position_y,
    zIndex: row.z_index,
    pinned: !!row.pinned,
    width: row.width,
    height: row.height,
    createdById: row.created_by,
    updatedAt: row.updated_at,
    displayTitle: '',
    previewLine: '',
    taskPreview: null,
    docPreview: null,
    isImage: false,
    linkUrl: row.link_url || null,
  };
  if (row.kind === 'task' && row.task_id) {
    const t = db
      .prepare(
        `SELECT title, description, status, progress, quantity_target, quantity_done, created_by FROM tasks WHERE id = ?`
      )
      .get(row.task_id);
    if (t) {
      const own = taskOwnProgressFromRow(t);
      const qty =
        t.quantity_target != null && t.quantity_target > 0
          ? ` · ${t.quantity_done ?? 0}/${t.quantity_target}`
          : '';
      base.displayTitle = maskIfNeeded(db, groupId, viewerId, t.created_by, t.title);
      base.previewLine = `${t.status} · ${own}%${qty}`;
      base.taskPreview = {
        description: maskIfNeeded(db, groupId, viewerId, t.created_by, (t.description || '').slice(0, 400)),
        status: t.status,
        progress: own,
      };
    }
  } else if (row.kind === 'collab_doc' && row.collab_document_id) {
    const d = db
      .prepare(`SELECT name, description, doc_type, created_by FROM collab_documents WHERE id = ?`)
      .get(row.collab_document_id);
    if (d) {
      base.displayTitle = maskIfNeeded(db, groupId, viewerId, d.created_by, d.name);
      base.previewLine = d.doc_type === 'spreadsheet' ? 'Таблица' : 'Текстовый документ';
      base.docPreview = {
        description: maskIfNeeded(db, groupId, viewerId, d.created_by, (d.description || '').slice(0, 400)),
        docType: d.doc_type,
      };
    }
  } else if (row.kind === 'upload') {
    base.displayTitle = row.file_original_name || 'Файл';
    base.previewLine = row.file_mime || '';
    base.isImage = !!(row.file_mime && /^image\//i.test(row.file_mime));
  } else if (row.kind === 'folder') {
    base.displayTitle = maskIfNeeded(db, groupId, viewerId, row.created_by, row.title || 'Папка');
    const cnt = db
      .prepare(`SELECT COUNT(*) AS c FROM task_board_canvas_items WHERE parent_item_id = ?`)
      .get(row.id);
    base.previewLine = `${cnt?.c ?? 0} элементов`;
  } else if (row.kind === 'link') {
    const url = row.link_url || '';
    base.displayTitle = (row.title && String(row.title).trim()) || url || 'Ссылка';
    base.previewLine = url;
  }
  return base;
}

/** Автор записи (участник группы) или модератор/админ */
function canDeleteAsAuthorOrModerator(db, groupId, userId, createdByUserId) {
  const m = getMembership(db, groupId, userId);
  if (!m || isBannedMember(db, groupId, userId)) return false;
  if (createdByUserId === userId) return true;
  const order = { member: 0, moderator: 1, admin: 2 };
  return order[m.role] >= order.moderator;
}

/** true, если nodeId совпадает с rootId или лежит внутри поддерева rootId */
function folderSubtreeContains(db, rootId, nodeId) {
  let cur = nodeId;
  const guard = new Set();
  while (cur != null) {
    if (cur === rootId) return true;
    if (guard.has(cur)) break;
    guard.add(cur);
    const r = db.prepare(`SELECT parent_id FROM collab_folders WHERE id = ?`).get(cur);
    cur = r?.parent_id ?? null;
  }
  return false;
}

/** Все id папок в поддереве, включая rootFolderId. */
function collectCollabFolderSubtreeIds(db, rootFolderId) {
  const out = [];
  const queue = [rootFolderId];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const ch = db.prepare(`SELECT id FROM collab_folders WHERE parent_id = ?`).all(id);
    for (const r of ch) queue.push(r.id);
  }
  return out;
}

/** Удалить папку и всё поддерево: документы и папки снизу вверх. */
function deleteCollabFolderTreeWithContents(db, rootFolderId) {
  const subtree = collectCollabFolderSubtreeIds(db, rootFolderId);
  const pending = new Set(subtree);
  while (pending.size) {
    let leaf = null;
    for (const folderId of pending) {
      const kids = db.prepare(`SELECT id FROM collab_folders WHERE parent_id = ?`).all(folderId);
      const hasChildInSubtree = kids.some((k) => pending.has(k.id));
      if (!hasChildInSubtree) {
        leaf = folderId;
        break;
      }
    }
    if (leaf == null) break;
    const docs = db.prepare(`SELECT id FROM collab_documents WHERE folder_id = ?`).all(leaf);
    for (const d of docs) {
      evictCollabDoc(d.id);
      db.prepare(`DELETE FROM collab_documents WHERE id = ?`).run(d.id);
    }
    db.prepare(`DELETE FROM collab_folders WHERE id = ?`).run(leaf);
    pending.delete(leaf);
  }
}

/** Прямые дочерние папки и документы переносятся к родителю удаляемой папки (или в корень). */
function promoteCollabFolderChildrenToParent(db, folderId, newParentId) {
  db.prepare(
    `UPDATE collab_folders SET parent_id = ?, updated_at = datetime('now') WHERE parent_id = ?`
  ).run(newParentId, folderId);
  db.prepare(
    `UPDATE collab_documents SET folder_id = ?, updated_at = datetime('now') WHERE folder_id = ?`
  ).run(newParentId, folderId);
}

function buildTaskTreeWithRollup(rows, db) {
  const rawById = Object.fromEntries(rows.map((t) => [t.id, t]));
  const byId = Object.fromEntries(
    rows.map((t) => {
      const own = taskOwnProgressFromRow(t);
      return [
        t.id,
        {
          id: t.id,
          boardId: t.board_id,
          parentId: t.parent_id,
          title: t.title,
          description: t.description,
          status: t.status,
          progress: own,
          quantityTarget: t.quantity_target != null && t.quantity_target > 0 ? t.quantity_target : null,
          quantityDone: t.quantity_done ?? 0,
          effectiveProgress: own,
          assigneeId: t.assignee_id,
          createdById: t.created_by ?? null,
          assignee: t.assignee_id ? rowUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(t.assignee_id)) : null,
          sortOrder: t.sort_order,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        },
      ];
    })
  );
  const children = {};
  for (const t of rows) {
    const p = t.parent_id || 0;
    if (!children[p]) children[p] = [];
    children[p].push(t.id);
  }
  /** Эффективный %: не выше собственного и не выше «узкого места» среди подзадач (все должны дойти до 100%). */
  function dfs(id) {
    const row = rawById[id];
    const own = taskOwnProgressFromRow(row);
    byId[id].progress = own;
    const subs = children[id] || [];
    if (!subs.length) {
      byId[id].effectiveProgress = own;
      return own;
    }
    const childEffs = subs.map((cid) => dfs(cid));
    const childRollup = Math.min(...childEffs);
    const eff = Math.min(own, childRollup);
    byId[id].effectiveProgress = eff;
    return eff;
  }
  for (const t of rows) {
    if (!t.parent_id) dfs(t.id);
  }
  return Object.values(byId);
}

/**
 * Регистрирует на `r` все маршруты воркспейса (пути без отдельного префикса — тот же API-роутер, что в `createApiRouter`).
 *
 * @param {import('express').Router} r
 * @param {import('socket.io').Server} io — push для досок, канбана и дерева коллаба
 */
export function appendWorkspaceRoutes(r, io) {
  const db = getDb();
  const w = express.Router();

  // --- Коллаб: папки (список, создание, PATCH, удаление с переносом детей) ---

  w.get('/groups/:groupId/collab-folders', requireAuth, (req, res) => {
    const gid = +req.params.groupId;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT id, parent_id, name, password_hash, created_by, created_at, updated_at FROM collab_folders WHERE group_id = ? ORDER BY name`
      )
      .all(gid);
    res.json(
      rows.map((x) => ({
        id: x.id,
        parentId: x.parent_id,
        name: maskIfNeeded(db, gid, req.userId, x.created_by, x.name),
        hasPassword: !!x.password_hash,
        passwordFingerprint: pwdFingerprint(x.password_hash),
        createdById: x.created_by,
        createdAt: x.created_at,
        updatedAt: x.updated_at,
      }))
    );
  });

  w.post('/groups/:groupId/collab-folders', requireAuth, (req, res) => {
    const gid = +req.params.groupId;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const { name, parentId, password, parentFolderPassword } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name' });
    let parent_id = null;
    if (parentId != null && parentId !== '') {
      parent_id = +parentId;
      const p = db.prepare(`SELECT * FROM collab_folders WHERE id = ? AND group_id = ?`).get(parent_id, gid);
      if (!p) return res.status(400).json({ error: 'Родительская папка не найдена' });
      if (
        !collabPasswordBypass(db, gid, req.userId) &&
        p.password_hash &&
        (!parentFolderPassword || !verifyPassword(String(parentFolderPassword), p.password_hash))
      )
        return res.status(403).json({ error: 'Нужен пароль родительской папки' });
    }
    const password_hash = password ? hashPassword(String(password)) : null;
    const info = db
      .prepare(
        `INSERT INTO collab_folders (group_id, parent_id, name, password_hash, created_by) VALUES (?,?,?,?,?)`
      )
      .run(gid, parent_id, String(name).trim(), password_hash, req.userId);
    const newFid = info.lastInsertRowid;
    auditGroup(db, req.userId, gid, 'collab_folder_create', {
      folderId: newFid,
      name: String(name).trim(),
      parentId: parent_id,
      hasPassword: !!password_hash,
    });
    emitCollabTreeRefresh(io, gid);
    res.json({ id: newFid });
  });

  w.patch('/collab-folders/:folderId', requireAuth, (req, res) => {
    const fid = +req.params.folderId;
    const row = db.prepare(`SELECT * FROM collab_folders WHERE id = ?`).get(fid);
    if (!row) return res.status(404).json({ error: 'Папка не найдена' });
    const gid = row.group_id;
    const {
      name,
      password,
      clearPassword,
      parentId,
      targetParentFolderPassword,
      sourceFolderPassword,
    } = req.body || {};

    const onlyParentMove =
      parentId !== undefined &&
      name === undefined &&
      password === undefined &&
      !clearPassword;

    if (onlyParentMove) {
      const chk = requireGroupMember(db, gid, req.userId);
      if (!chk.ok) return res.status(403).json({ error: chk.error });
      if (!canDeleteAsAuthorOrModerator(db, gid, req.userId, row.created_by))
        return res.status(403).json({ error: 'Перемещать может автор папки или модератор/админ группы' });
      if (
        !collabPasswordBypass(db, gid, req.userId) &&
        row.password_hash &&
        (!sourceFolderPassword || !verifyPassword(String(sourceFolderPassword), row.password_hash))
      )
        return res.status(403).json({ error: 'Нужен пароль папки, чтобы переместить её' });
      const pid = parentId === null || parentId === 'null' || parentId === '' ? null : +parentId;
      if (pid != null) {
        if (pid === fid) return res.status(400).json({ error: 'Некорректная папка назначения' });
        const parentRow = db.prepare(`SELECT * FROM collab_folders WHERE id = ? AND group_id = ?`).get(pid, gid);
        if (!parentRow) return res.status(400).json({ error: 'Родительская папка не найдена' });
        if (folderSubtreeContains(db, fid, pid))
          return res.status(400).json({ error: 'Нельзя переместить папку внутрь самой себя' });
        if (
          !collabPasswordBypass(db, gid, req.userId) &&
          parentRow.password_hash &&
          (!targetParentFolderPassword ||
            !verifyPassword(String(targetParentFolderPassword), parentRow.password_hash))
        )
          return res.status(403).json({ error: 'Нужен пароль папки назначения' });
      }
      db.prepare(`UPDATE collab_folders SET parent_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
        pid,
        fid
      );
      auditGroup(db, req.userId, gid, 'collab_folder_move', { folderId: fid, parentId: pid });
      emitCollabTreeRefresh(io, gid);
      return res.json({ ok: true });
    }

    if (!canDeleteAsAuthorOrModerator(db, gid, req.userId, row.created_by))
      return res.status(403).json({ error: 'Редактировать может автор папки или модератор/админ группы' });
    let password_hash = row.password_hash;
    if (clearPassword) password_hash = null;
    else if (password) password_hash = hashPassword(String(password));
    const newName = name !== undefined ? String(name).trim() : row.name;
    if (!newName) return res.status(400).json({ error: 'Пустое имя' });
    let newParentId = row.parent_id;
    if (parentId !== undefined) {
      const pid = parentId === null || parentId === 'null' || parentId === '' ? null : +parentId;
      if (pid != null) {
        if (pid === fid) return res.status(400).json({ error: 'Некорректная папка назначения' });
        const parentRow = db.prepare(`SELECT * FROM collab_folders WHERE id = ? AND group_id = ?`).get(pid, gid);
        if (!parentRow) return res.status(400).json({ error: 'Родительская папка не найдена' });
        if (folderSubtreeContains(db, fid, pid))
          return res.status(400).json({ error: 'Нельзя переместить папку внутрь самой себя' });
        if (
          !collabPasswordBypass(db, gid, req.userId) &&
          parentRow.password_hash &&
          (!targetParentFolderPassword ||
            !verifyPassword(String(targetParentFolderPassword), parentRow.password_hash))
        )
          return res.status(403).json({ error: 'Нужен пароль папки назначения' });
      }
      newParentId = pid;
    }
    db.prepare(
      `UPDATE collab_folders SET name = ?, password_hash = ?, parent_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(newName, password_hash, newParentId, fid);
    const hadPw = !!row.password_hash;
    auditGroup(db, req.userId, gid, 'collab_folder_update', {
      folderId: fid,
      nameChanged: newName !== row.name,
      parentChanged: newParentId !== row.parent_id,
      passwordSet: !hadPw && !!password_hash,
      passwordCleared: hadPw && !password_hash,
      passwordChanged: !!(password && hadPw),
    });
    emitCollabTreeRefresh(io, gid);
    res.json({ ok: true });
  });

  w.delete('/collab-folders/:folderId', requireAuth, (req, res) => {
    const fid = +req.params.folderId;
    const row = db.prepare(`SELECT * FROM collab_folders WHERE id = ?`).get(fid);
    if (!row) return res.status(404).json({ error: 'Папка не найдена' });
    if (!canDeleteAsAuthorOrModerator(db, row.group_id, req.userId, row.created_by))
      return res.status(403).json({ error: 'Удалять может автор папки или модератор/админ группы' });
    // Защита содержимого паролем: автор без знания пароля не должен сносить дерево. Модераторы
    // и админы по политике приложения имеют bypass (как в других местах workspaceRoutes.js).
    const isMod = requireGroupMember(db, row.group_id, req.userId, 'moderator').ok;
    if (row.password_hash && !isMod) {
      const sourceFolderPassword =
        (req.body && req.body.sourceFolderPassword) || (req.query && req.query.sourceFolderPassword);
      if (!sourceFolderPassword || !verifyPassword(String(sourceFolderPassword), row.password_hash))
        return res.status(403).json({ error: 'Нужен пароль папки' });
    }
    const gid = row.group_id;
    const q = req.query || {};
    const deleteContents =
      q.deleteContents === '1' ||
      q.deleteContents === 'true' ||
      (req.body && req.body.deleteContents === true);
    const txn = db.transaction(() => {
      if (deleteContents) {
        deleteCollabFolderTreeWithContents(db, fid);
      } else {
        promoteCollabFolderChildrenToParent(db, fid, row.parent_id);
        db.prepare(`DELETE FROM collab_folders WHERE id = ?`).run(fid);
      }
    });
    txn();
    auditGroup(db, req.userId, gid, 'collab_folder_delete', {
      folderId: fid,
      name: row.name,
      deleteContents: !!deleteContents,
    });
    emitCollabTreeRefresh(io, gid);
    res.json({ ok: true });
  });

  // --- Коллаб: плоский список документов, выбор задачи для чата, дерево документов, создание ---

  w.get('/groups/:groupId/collab-docs-flat', requireAuth, (req, res) => {
    const gid = +req.params.groupId;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT id, folder_id, name, doc_type, created_by, password_hash, description, preview_stored_name FROM collab_documents WHERE group_id = ? AND COALESCE(task_board_only, 0) = 0 ORDER BY name COLLATE NOCASE`
      )
      .all(gid);
    const imageExtRe = /\.(jpe?g|png|gif|webp|bmp|svg|avif|tiff?)$/i;
    res.json(
      rows.map((x) => {
        const rawDesc = String(x.description || '');
        const importMatch = rawDesc.match(/Импорт из файла\s+(.+?)\s*$/i);
        const importFile = importMatch ? importMatch[1].trim() : '';
        const prevBase = x.preview_stored_name ? path.basename(String(x.preview_stored_name)) : '';
        const previewImageUrl =
          prevBase &&
          prevBase === String(x.preview_stored_name).trim() &&
          !prevBase.includes('..')
            ? `/uploads/${prevBase}`
            : null;
        const imageDocument =
          x.doc_type === 'richtext' &&
          (!!previewImageUrl || (!!importFile && imageExtRe.test(importFile)));
        return {
          id: x.id,
          folderId: x.folder_id,
          name: maskIfNeeded(db, gid, req.userId, x.created_by, x.name),
          docType: x.doc_type,
          hasPassword: !!x.password_hash,
          passwordFingerprint: pwdFingerprint(x.password_hash),
          previewImageUrl,
          imageDocument,
        };
      })
    );
  });

  /** Задачи группы для # в чате: все задачи; доска с паролем помечается boardHasPassword (значок замка в UI). */
  w.get('/groups/:groupId/tasks-for-chat-picker', requireAuth, (req, res) => {
    const gid = +req.params.groupId;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT t.id, t.title, t.board_id, t.created_by, b.name AS board_name, b.password_hash, b.created_by AS board_created_by
         FROM tasks t
         JOIN task_boards b ON b.id = t.board_id
         WHERE b.group_id = ?
         ORDER BY b.name COLLATE NOCASE, (t.parent_id IS NOT NULL), t.title COLLATE NOCASE`
      )
      .all(gid);
    res.json(
      rows.map((x) => ({
        id: x.id,
        title: maskIfNeeded(db, gid, req.userId, x.created_by, x.title),
        boardId: x.board_id,
        boardName: maskIfNeeded(db, gid, req.userId, x.board_created_by, x.board_name),
        boardHasPassword: !!x.password_hash,
      }))
    );
  });

  w.get('/groups/:groupId/collab-docs', requireAuth, (req, res) => {
    const gid = +req.params.groupId;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    let folderId = req.query.folderId;
    if (folderId === undefined || folderId === '' || folderId === 'null') folderId = null;
    else folderId = +folderId;
    if (folderId != null) {
      const f = db.prepare(`SELECT * FROM collab_folders WHERE id = ? AND group_id = ?`).get(folderId, gid);
      if (!f) return res.status(404).json({ error: 'Папка не найдена' });
      if (
        !collabPasswordBypass(db, gid, req.userId) &&
        f.password_hash &&
        (!req.query.folderPassword ||
          !verifyPassword(String(req.query.folderPassword), f.password_hash))
      )
        return res.status(403).json({ error: 'Нужен пароль папки' });
    }
    const rows =
      folderId == null
        ? db
            .prepare(
              `SELECT id, folder_id, name, description, doc_type, password_hash, updated_at, created_by FROM collab_documents WHERE group_id = ? AND folder_id IS NULL AND COALESCE(task_board_only, 0) = 0 ORDER BY name`
            )
            .all(gid)
        : db
            .prepare(
              `SELECT id, folder_id, name, description, doc_type, password_hash, updated_at, created_by FROM collab_documents WHERE group_id = ? AND folder_id = ? AND COALESCE(task_board_only, 0) = 0 ORDER BY name`
            )
            .all(gid, folderId);
    res.json(
      rows.map((x) => ({
        id: x.id,
        folderId: x.folder_id,
        name: maskIfNeeded(db, gid, req.userId, x.created_by, x.name),
        description: maskIfNeeded(db, gid, req.userId, x.created_by, x.description || ''),
        docType: x.doc_type,
        hasPassword: !!x.password_hash,
        passwordFingerprint: pwdFingerprint(x.password_hash),
        updatedAt: x.updated_at,
        createdById: x.created_by,
      }))
    );
  });

  w.post('/groups/:groupId/collab-docs', requireAuth, (req, res) => {
    const gid = +req.params.groupId;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const { name, docType, password, description, folderId, folderPassword, taskBoardOnly } = req.body || {};
    if (!name || !['richtext', 'spreadsheet'].includes(docType))
      return res.status(400).json({ error: 'name и docType (richtext|spreadsheet)' });
    const tbo =
      taskBoardOnly === true || taskBoardOnly === 1 || taskBoardOnly === '1' || taskBoardOnly === 'true';
    let folder_id = null;
    if (!tbo && folderId != null && folderId !== '') {
      folder_id = +folderId;
      const fold = db.prepare(`SELECT * FROM collab_folders WHERE id = ? AND group_id = ?`).get(folder_id, gid);
      if (!fold) return res.status(400).json({ error: 'Папка не найдена' });
      if (
        !collabPasswordBypass(db, gid, req.userId) &&
        fold.password_hash &&
        (!folderPassword || !verifyPassword(String(folderPassword), fold.password_hash))
      )
        return res.status(403).json({ error: 'Нужен пароль папки' });
    }
    const password_hash = password ? hashPassword(String(password)) : null;
    const desc = description != null ? String(description) : '';
    const info = db
      .prepare(
        `INSERT INTO collab_documents (group_id, folder_id, name, description, doc_type, password_hash, created_by, task_board_only) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(gid, folder_id, String(name).trim(), desc, docType, password_hash, req.userId, tbo ? 1 : 0);
    const newDid = info.lastInsertRowid;
    auditGroup(db, req.userId, gid, 'collab_document_create', {
      documentId: newDid,
      name: String(name).trim(),
      docType,
      folderId: folder_id,
      taskBoardOnly: tbo,
      hasPassword: !!password_hash,
    });
    emitCollabTreeRefresh(io, gid);
    res.json({ id: newDid });
  });

  // --- Коллаб-документ: мета, доступ, файлы в rich text, state/Yjs seed, PATCH, DELETE ---

  w.get('/collab-docs/:id/meta', requireAuth, (req, res) => {
    const id = +req.params.id;
    const row = db.prepare(`SELECT * FROM collab_documents WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Не найден' });
    const chk = requireGroupMember(db, row.group_id, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    let folderHasPassword = false;
    let folderName = null;
    let folderPasswordFingerprint = null;
    if (row.folder_id) {
      const fold = db
        .prepare(`SELECT name, password_hash, created_by FROM collab_folders WHERE id = ? AND group_id = ?`)
        .get(row.folder_id, row.group_id);
      if (fold) {
        folderHasPassword = !!fold.password_hash;
        folderName = maskIfNeeded(db, row.group_id, req.userId, fold.created_by, fold.name);
        folderPasswordFingerprint = pwdFingerprint(fold.password_hash);
      }
    }
    const officeRevision = Number(row.office_revision ?? 0);
    const yStateLen = row.y_state ? row.y_state.length : 0;
    /** Документ с данными только в Yjs (импорт y-seed и т.п.): OnlyOffice смотрит на пустой шаблон на диске — открывать встроенный редактор. */
    const preferBuiltinEditor = officeRevision === 0 && yStateLen > 0;
    const rawDesc = String(row.description || '');
    const importMatch = rawDesc.match(/Импорт из файла\s+(.+?)\s*$/i);
    const importFileName = importMatch ? importMatch[1].trim() : '';
    const imageExtRe = /\.(jpe?g|png|gif|webp|bmp|svg|avif|tiff?)$/i;
    const previewBase = row.preview_stored_name ? path.basename(String(row.preview_stored_name)) : '';
    const previewImageUrl =
      previewBase && previewBase === String(row.preview_stored_name).trim() && !previewBase.includes('..')
        ? `/uploads/${previewBase}`
        : null;
    const imageDocument =
      row.doc_type === 'richtext' &&
      (!!previewImageUrl || (!!importFileName && imageExtRe.test(importFileName)));

    res.json({
      id: row.id,
      groupId: row.group_id,
      folderId: row.folder_id,
      folderHasPassword,
      folderName,
      folderPasswordFingerprint,
      name: maskIfNeeded(db, row.group_id, req.userId, row.created_by, row.name),
      description: maskIfNeeded(db, row.group_id, req.userId, row.created_by, row.description || ''),
      docType: row.doc_type,
      hasPassword: !!row.password_hash,
      passwordFingerprint: pwdFingerprint(row.password_hash),
      updatedAt: row.updated_at,
      createdById: row.created_by,
      officeRevision,
      preferBuiltinEditor,
      imageDocument,
      previewImageUrl,
    });
  });

  /** Проверка паролей папки и документа (переход из чата и т.п.) */
  w.post('/collab-docs/:id/verify-access', requireAuth, (req, res) => {
    const id = +req.params.id;
    const { password, folderPassword } = req.body || {};
    const pw = password !== undefined && String(password).length > 0 ? String(password) : undefined;
    const fpw =
      folderPassword !== undefined && String(folderPassword).length > 0 ? String(folderPassword) : undefined;
    const a = checkCollabDocAccess(db, id, req.userId, pw, fpw);
    if (!a.ok) return res.status(403).json({ error: a.error });
    res.json({ ok: true });
  });

  /**
   * Сохраняет изображение в uploads и возвращает URL для y-seed.
   * Так в Yjs не кладётся огромный data:, что ломало Socket.IO / отображение.
   */
  w.post('/collab-docs/:id/collab-image-upload', requireAuth, upload.single('file'), (req, res) => {
    const id = +req.params.id;
    const row = db.prepare(`SELECT * FROM collab_documents WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Не найден' });
    const { password, folderPassword } = req.body || {};
    const a = checkCollabDocAccess(db, id, req.userId, password, folderPassword);
    if (!a.ok) return res.status(403).json({ error: a.error });
    if (!req.file) return res.status(400).json({ error: 'file' });
    const mime = String(req.file.mimetype || '').toLowerCase();
    if (!mime.startsWith('image/')) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* noop */
      }
      return res.status(400).json({ error: 'Нужен файл изображения' });
    }
    const name = path.basename(req.file.filename);
    if (!name || name.includes('..')) return res.status(500).json({ error: 'file' });
    db.prepare(`UPDATE collab_documents SET preview_stored_name = ? WHERE id = ?`).run(name, id);
    res.json({ url: `/uploads/${name}` });
  });

  w.get('/collab-docs/:id/state', requireAuth, (req, res) => {
    const id = +req.params.id;
    const password = req.query.password || undefined;
    const folderPassword = req.query.folderPassword || undefined;
    const a = checkCollabDocAccess(db, id, req.userId, password, folderPassword);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const ydoc = getOrCreateYDoc(id);
    const state = Y.encodeStateAsUpdate(ydoc);
    res.json({ state: Buffer.from(state).toString('base64') });
  });

  /** Однократная запись начального y_state в пустой документ (импорт с диска). */
  w.post('/collab-docs/:id/y-seed', requireAuth, (req, res) => {
    const id = +req.params.id;
    const row = db.prepare(`SELECT * FROM collab_documents WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Не найден' });
    const { password, folderPassword, initialStateBase64 } = req.body || {};
    const a = checkCollabDocAccess(db, id, req.userId, password, folderPassword);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const existing = row.y_state;
    if (existing != null && existing.length > 0)
      return res.status(409).json({ error: 'Документ уже содержит данные' });
    if (!initialStateBase64 || typeof initialStateBase64 !== 'string')
      return res.status(400).json({ error: 'initialStateBase64' });
    let bytes;
    try {
      bytes = Buffer.from(initialStateBase64, 'base64');
    } catch {
      return res.status(400).json({ error: 'Некорректный base64' });
    }
    const MAX_SEED = 14 * 1024 * 1024;
    if (!bytes.length) return res.status(400).json({ error: 'Пустое состояние' });
    if (bytes.length > MAX_SEED) return res.status(400).json({ error: 'Слишком большой объём данных' });
    try {
      const test = new Y.Doc();
      Y.applyUpdate(test, new Uint8Array(bytes));
      test.destroy();
    } catch {
      return res.status(400).json({ error: 'Некорректный Yjs state' });
    }
    db.prepare(`UPDATE collab_documents SET y_state = ?, updated_at = datetime('now') WHERE id = ?`).run(
      bytes,
      id
    );
    evictCollabDoc(id);
    auditGroup(db, req.userId, row.group_id, 'collab_document_import_yjs', {
      documentId: id,
      name: row.name,
      docType: row.doc_type,
      bytes: bytes.length,
    });
    emitCollabTreeRefresh(io, row.group_id);
    res.json({ ok: true });
  });

  w.patch('/collab-docs/:id', requireAuth, (req, res) => {
    const id = +req.params.id;
    const row = db.prepare(`SELECT * FROM collab_documents WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Не найден' });
    const gid = row.group_id;
    const { name, password, clearPassword, description, folderId, targetFolderPassword, sourceDocPassword } =
      req.body || {};

    const onlyMove =
      folderId !== undefined &&
      name === undefined &&
      description === undefined &&
      password === undefined &&
      !clearPassword;

    if (onlyMove) {
      const chk = requireGroupMember(db, gid, req.userId);
      if (!chk.ok) return res.status(403).json({ error: chk.error });
      if (!canDeleteAsAuthorOrModerator(db, gid, req.userId, row.created_by))
        return res.status(403).json({ error: 'Перемещать может автор документа или модератор/админ группы' });
      if (Number(row.task_board_only ?? 0) === 1)
        return res.status(403).json({
          error: 'Документ с доски задач нельзя переносить в раздел «Документы»',
        });
      if (
        !collabPasswordBypass(db, gid, req.userId) &&
        row.password_hash &&
        (!sourceDocPassword || !verifyPassword(String(sourceDocPassword), row.password_hash))
      )
        return res.status(403).json({ error: 'Нужен пароль документа, чтобы переместить его' });
      const fid = folderId === null || folderId === 'null' || folderId === '' ? null : +folderId;
      if (fid != null) {
        const fold = db.prepare(`SELECT * FROM collab_folders WHERE id = ? AND group_id = ?`).get(fid, gid);
        if (!fold) return res.status(400).json({ error: 'Папка не найдена' });
        if (
          !collabPasswordBypass(db, gid, req.userId) &&
          fold.password_hash &&
          (!targetFolderPassword || !verifyPassword(String(targetFolderPassword), fold.password_hash))
        )
          return res.status(403).json({ error: 'Нужен пароль целевой папки' });
      }
      db.prepare(`UPDATE collab_documents SET folder_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
        fid,
        id
      );
      auditGroup(db, req.userId, gid, 'collab_document_move', { documentId: id, folderId: fid });
      emitCollabTreeRefresh(io, gid);
      return res.json({ ok: true });
    }

    const canEditMeta = canDeleteAsAuthorOrModerator(db, gid, req.userId, row.created_by);
    if (!canEditMeta) return res.status(403).json({ error: 'Нет доступа' });
    let password_hash = row.password_hash;
    if (clearPassword) password_hash = null;
    else if (password) password_hash = hashPassword(String(password));
    const newName = name !== undefined ? String(name).trim() : row.name;
    const newDesc = description !== undefined ? String(description) : row.description ?? '';
    let newFolderId = row.folder_id;
    if (folderId !== undefined) {
      const fid = folderId === null || folderId === 'null' || folderId === '' ? null : +folderId;
      if (Number(row.task_board_only ?? 0) === 1 && fid != null)
        return res.status(403).json({
          error: 'Документ с доски задач нельзя поместить в папки раздела «Документы»',
        });
      if (fid != null) {
        const fold = db.prepare(`SELECT * FROM collab_folders WHERE id = ? AND group_id = ?`).get(fid, gid);
        if (!fold) return res.status(400).json({ error: 'Папка не найдена' });
        if (
          !collabPasswordBypass(db, gid, req.userId) &&
          fold.password_hash &&
          (!targetFolderPassword || !verifyPassword(String(targetFolderPassword), fold.password_hash))
        )
          return res.status(403).json({ error: 'Нужен пароль целевой папки' });
      }
      newFolderId = fid;
    }
    db.prepare(
      `UPDATE collab_documents SET name = ?, description = ?, password_hash = ?, folder_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(newName, newDesc, password_hash, newFolderId, id);
    const hadPw = !!row.password_hash;
    auditGroup(db, req.userId, gid, 'collab_document_update', {
      documentId: id,
      nameChanged: newName !== row.name,
      descriptionChanged: newDesc !== (row.description ?? ''),
      folderChanged: newFolderId !== row.folder_id,
      passwordSet: !hadPw && !!password_hash,
      passwordCleared: hadPw && !password_hash,
      passwordChanged: !!(password && hadPw),
    });
    emitCollabTreeRefresh(io, gid);
    res.json({ ok: true });
  });

  w.delete('/collab-docs/:id', requireAuth, (req, res) => {
    const id = +req.params.id;
    const row = db.prepare(`SELECT * FROM collab_documents WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Не найден' });
    if (!canDeleteAsAuthorOrModerator(db, row.group_id, req.userId, row.created_by))
      return res.status(403).json({ error: 'Удалять может автор документа или модератор/админ группы' });
    const gid = row.group_id;
    auditGroup(db, req.userId, gid, 'collab_document_delete', { documentId: id, name: row.name });
    db.prepare(`DELETE FROM collab_documents WHERE id = ?`).run(id);
    evictCollabDoc(id);
    emitCollabTreeRefresh(io, gid);
    res.json({ ok: true });
  });

  // --- Доски задач: список, создание, PATCH, удаление ---

  w.get('/groups/:groupId/task-boards', requireAuth, (req, res) => {
    const gid = +req.params.groupId;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db.prepare(`SELECT id, name, password_hash, created_at, created_by FROM task_boards WHERE group_id = ?`).all(gid);
    res.json(
      rows.map((x) => ({
        id: x.id,
        name: maskIfNeeded(db, gid, req.userId, x.created_by, x.name),
        hasPassword: !!x.password_hash,
        passwordFingerprint: pwdFingerprint(x.password_hash),
        createdAt: x.created_at,
        createdById: x.created_by,
      }))
    );
  });

  w.post('/groups/:groupId/task-boards', requireAuth, (req, res) => {
    const gid = +req.params.groupId;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const { name, password } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name' });
    const password_hash = password ? hashPassword(String(password)) : null;
    const info = db
      .prepare(`INSERT INTO task_boards (group_id, name, password_hash, created_by) VALUES (?,?,?,?)`)
      .run(gid, String(name).trim(), password_hash, req.userId);
    const newBid = info.lastInsertRowid;
    auditGroup(db, req.userId, gid, 'task_board_create', {
      boardId: newBid,
      name: String(name).trim(),
      hasPassword: !!password_hash,
    });
    emitTasksRefresh(io, gid, newBid);
    res.json({ id: newBid });
  });

  w.patch('/task-boards/:boardId', requireAuth, (req, res) => {
    const bid = +req.params.boardId;
    const b = db.prepare(`SELECT * FROM task_boards WHERE id = ?`).get(bid);
    if (!b) return res.status(404).json({ error: 'Нет доски' });
    if (!canDeleteAsAuthorOrModerator(db, b.group_id, req.userId, b.created_by))
      return res.status(403).json({ error: 'Изменять может автор доски или модератор/админ группы' });
    const { name, password, clearPassword } = req.body || {};
    let password_hash = b.password_hash;
    if (clearPassword) password_hash = null;
    else if (password) password_hash = hashPassword(String(password));
    db.prepare(`UPDATE task_boards SET name = COALESCE(?, name), password_hash = ? WHERE id = ?`).run(
      name != null ? String(name).trim() : null,
      password_hash,
      bid
    );
    const hadPw = !!b.password_hash;
    const newName = name != null ? String(name).trim() : b.name;
    auditGroup(db, req.userId, b.group_id, 'task_board_update', {
      boardId: bid,
      nameChanged: name != null && newName !== b.name,
      passwordSet: !hadPw && !!password_hash,
      passwordCleared: hadPw && !password_hash,
      passwordChanged: !!(password && hadPw),
    });
    emitTasksRefresh(io, b.group_id, bid);
    res.json({ ok: true });
  });

  w.delete('/task-boards/:boardId', requireAuth, (req, res) => {
    const bid = +req.params.boardId;
    const password = req.query.password || req.body?.password;
    const b = db.prepare(`SELECT * FROM task_boards WHERE id = ?`).get(bid);
    if (!b) return res.status(404).json({ error: 'Доска не найдена' });
    if (!canDeleteAsAuthorOrModerator(db, b.group_id, req.userId, b.created_by))
      return res.status(403).json({ error: 'Удалять может автор доски или модератор/админ группы' });
    const a = checkBoardAccess(db, bid, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    auditGroup(db, req.userId, b.group_id, 'task_board_delete', { boardId: bid, name: b.name });
    db.prepare(`DELETE FROM task_boards WHERE id = ?`).run(bid);
    emitTasksRefresh(io, b.group_id, bid);
    res.json({ ok: true });
  });

  // --- Задачи: навигация из чата, проверка пароля доски, дерево, создание ---

  /** Для перехода из чата: доска и группа задачи (пароль доски — подсказка клиенту). */
  w.get('/tasks/:taskId/nav-meta', requireAuth, (req, res) => {
    const tid = +req.params.taskId;
    const row = db
      .prepare(
        `SELECT t.id AS task_id, t.board_id, b.group_id, b.name AS board_name, b.password_hash, b.created_by AS board_created_by
         FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`
      )
      .get(tid);
    if (!row) return res.status(404).json({ error: 'Задача не найдена' });
    const chk = requireGroupMember(db, row.group_id, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    res.json({
      taskId: row.task_id,
      boardId: row.board_id,
      groupId: row.group_id,
      boardHasPassword: !!row.password_hash,
      boardPasswordFingerprint: pwdFingerprint(row.password_hash),
      boardName: maskIfNeeded(db, row.group_id, req.userId, row.board_created_by, row.board_name),
    });
  });

  w.post('/task-boards/:boardId/verify-password', requireAuth, (req, res) => {
    const bid = +req.params.boardId;
    const { password } = req.body || {};
    const a = checkBoardAccess(db, bid, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    res.json({ ok: true });
  });

  w.get('/task-boards/:boardId/tasks', requireAuth, (req, res) => {
    const bid = +req.params.boardId;
    const password = req.query.password || undefined;
    const a = checkBoardAccess(db, bid, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const rows = db
      .prepare(
        `SELECT t.* FROM tasks t WHERE t.board_id = ?
         ORDER BY CASE WHEN t.parent_id IS NULL THEN 0 ELSE 1 END, t.parent_id, t.sort_order, t.id`
      )
      .all(bid);
    const list = mapTasksForViewer(db, a.board.group_id, req.userId, buildTaskTreeWithRollup(rows, db));
    res.json(list);
  });

  w.post('/task-boards/:boardId/tasks', requireAuth, (req, res) => {
    const bid = +req.params.boardId;
    const { password, parentId, title, description, status, progress, assigneeId, quantityTarget } =
      req.body || {};
    const a = checkBoardAccess(db, bid, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    if (!title) return res.status(400).json({ error: 'title' });
    if (parentId) {
      const p = db.prepare(`SELECT id FROM tasks WHERE id = ? AND board_id = ?`).get(parentId, bid);
      if (!p) return res.status(400).json({ error: 'Неверный parentId' });
    }
    let qtyTarget = null;
    let qtyDone = 0;
    if (quantityTarget != null && quantityTarget !== '') {
      const qt = +quantityTarget;
      if (!Number.isFinite(qt) || qt < 1) return res.status(400).json({ error: 'quantityTarget' });
      qtyTarget = Math.floor(qt);
    }
    const st = status && ['todo', 'in_progress', 'review', 'done'].includes(status) ? status : 'todo';
    const prog =
      qtyTarget != null ? 0 : progress != null ? Math.min(100, Math.max(0, +progress)) : 0;
    if (st === 'done') {
      if (qtyTarget != null && qtyDone < qtyTarget) {
        return res.status(400).json({ error: 'Счётчик: выполните все единицы' });
      }
    }
    const info = db
      .prepare(
        `INSERT INTO tasks (board_id, parent_id, title, description, status, progress, quantity_target, quantity_done, assignee_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        bid,
        parentId || null,
        String(title).trim(),
        String(description || ''),
        st,
        prog,
        qtyTarget,
        qtyDone,
        assigneeId || null,
        req.userId
      );
    emitTasksRefresh(io, a.board.group_id, bid);
    const newTid = info.lastInsertRowid;
    logTaskActivity(db, newTid, req.userId, 'task_created', {
      title: String(title).trim(),
      quantityTarget: qtyTarget,
      parentId: parentId || null,
    });
    auditGroup(db, req.userId, a.board.group_id, 'task_create', {
      taskId: newTid,
      boardId: bid,
      title: String(title).trim(),
      parentId: parentId || null,
    });
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(newTid);
    const node = buildTaskTreeWithRollup([t], db)[0];
    res.json(mapTasksForViewer(db, a.board.group_id, req.userId, [node])[0]);
  });

  // --- Задачи: журнал активности, PATCH, удаление ---

  w.get('/tasks/:taskId/activity', requireAuth, (req, res) => {
    const tid = +req.params.taskId;
    const row = db.prepare(`SELECT t.board_id, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`).get(tid);
    if (!row) return res.status(404).json({ error: 'Нет' });
    const password = req.query.password || undefined;
    const a = checkBoardAccess(db, row.board_id, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const rows = db
      .prepare(
        `SELECT a.id, a.action, a.payload_json, a.created_at, a.user_id,
                u.username, u.display_name, u.tag, u.avatar_file, u.bio
         FROM task_activity a
         JOIN users u ON u.id = a.user_id
         WHERE a.task_id = ?
         ORDER BY a.id DESC
         LIMIT 120`
      )
      .all(tid);
    res.json(
      rows.map((x) => {
        let payload = {};
        try {
          payload = x.payload_json ? JSON.parse(x.payload_json) : {};
        } catch {
          payload = {};
        }
        return {
          id: x.id,
          action: x.action,
          payload,
          createdAt: x.created_at,
          author: rowUser({
            id: x.user_id,
            username: x.username,
            display_name: x.display_name,
            tag: x.tag,
            avatar_file: x.avatar_file,
            bio: x.bio,
          }),
        };
      })
    );
  });

  w.patch('/tasks/:taskId', requireAuth, (req, res) => {
    const tid = +req.params.taskId;
    const row = db.prepare(`SELECT t.*, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`).get(tid);
    if (!row) return res.status(404).json({ error: 'Нет задачи' });
    const {
      password,
      title,
      description,
      status,
      progress,
      assigneeId,
      parentId,
      sortOrder,
      quantityTarget,
      quantityAdd,
    } = req.body || {};
    const a = checkBoardAccess(db, row.board_id, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    if (parentId !== undefined && parentId !== null) {
      if (parentId === tid) return res.status(400).json({ error: 'Цикл' });
      const p = db.prepare(`SELECT id FROM tasks WHERE id = ? AND board_id = ?`).get(parentId, row.board_id);
      if (!p) return res.status(400).json({ error: 'parentId' });
    }
    const titleN = title !== undefined ? String(title) : row.title;
    const descN = description !== undefined ? String(description) : row.description;
    let statusN =
      status !== undefined && ['todo', 'in_progress', 'review', 'done'].includes(status) ? status : row.status;

    let qtyTarget = row.quantity_target ?? null;
    let qtyDone = row.quantity_done ?? 0;
    const qtyDoneBeforePatch = qtyDone;
    if (quantityTarget !== undefined) {
      if (quantityTarget === null || quantityTarget === '' || quantityTarget === 'null') {
        qtyTarget = null;
        qtyDone = 0;
      } else {
        const qt = +quantityTarget;
        if (!Number.isFinite(qt) || qt < 1) return res.status(400).json({ error: 'quantityTarget' });
        qtyTarget = Math.floor(qt);
        qtyDone = Math.min(qtyDone, qtyTarget);
      }
    }
    if (quantityAdd !== undefined) {
      const addN = +quantityAdd;
      if (qtyTarget == null || qtyTarget < 1) {
        return res.status(400).json({ error: 'У задачи нет цели по количеству' });
      }
      if (!Number.isFinite(addN) || addN <= 0) return res.status(400).json({ error: 'quantityAdd' });
      qtyDone = Math.min(qtyTarget, qtyDone + Math.floor(addN));
    }

    let progN = row.progress;
    if (qtyTarget != null && qtyTarget > 0) {
      progN = Math.min(100, Math.floor((100 * qtyDone) / qtyTarget));
    } else if (progress !== undefined) {
      progN = Math.min(100, Math.max(0, +progress));
    }

    const progressWasUpdated = progress !== undefined;
    if (quantityAdd !== undefined && statusN !== 'done') {
      statusN = 'in_progress';
    }
    if (statusN !== 'done') {
      const counterFull = qtyTarget != null && qtyTarget > 0 && qtyDone >= qtyTarget && progN >= 100;
      const sliderAt100 =
        (qtyTarget == null || qtyTarget < 1) && progressWasUpdated && progN >= 100;
      if (counterFull || sliderAt100) {
        statusN = 'review';
      }
    }

    if (statusN === 'done') {
      if (qtyTarget != null && qtyTarget > 0 && qtyDone < qtyTarget) {
        return res.status(400).json({ error: 'Счётчик: отметьте все единицы' });
      }
      const openKids = db
        .prepare(
          `SELECT COUNT(*) AS c FROM tasks WHERE parent_id = ? AND board_id = ? AND status != 'done'`
        )
        .get(tid, row.board_id);
      if (openKids.c > 0) {
        return res.status(400).json({ error: 'Сначала завершите все подзадачи' });
      }
    }

    const assigneeN = assigneeId !== undefined ? assigneeId : row.assignee_id;
    const parentN = parentId !== undefined ? parentId : row.parent_id;
    const sortN = sortOrder !== undefined ? +sortOrder : row.sort_order;
    db.prepare(
      `UPDATE tasks SET title=?, description=?, status=?, progress=?, quantity_target=?, quantity_done=?, assignee_id=?, parent_id=?, sort_order=?, updated_at=datetime('now') WHERE id=?`
    ).run(titleN, descN, statusN, progN, qtyTarget, qtyDone, assigneeN, parentN, sortN, tid);

    if (titleN !== row.title) {
      logTaskActivity(db, tid, req.userId, 'title', { before: row.title, after: titleN });
    }
    if (descN !== row.description) {
      logTaskActivity(db, tid, req.userId, 'description', {});
    }
    if (statusN !== row.status) {
      logTaskActivity(db, tid, req.userId, 'status', { from: row.status, to: statusN });
    }
    if (progress !== undefined && (row.quantity_target == null || row.quantity_target < 1) && progN !== row.progress) {
      logTaskActivity(db, tid, req.userId, 'progress', { from: row.progress, to: progN });
    }
    if (quantityAdd !== undefined) {
      logTaskActivity(db, tid, req.userId, 'quantity_add', {
        add: Math.floor(+quantityAdd),
        doneBefore: qtyDoneBeforePatch,
        doneAfter: qtyDone,
        target: qtyTarget,
      });
    }
    if (quantityTarget !== undefined) {
      const qtOld = row.quantity_target ?? null;
      if (qtOld !== qtyTarget) {
        logTaskActivity(db, tid, req.userId, 'quantity_target', {
          before: qtOld,
          after: qtyTarget,
          done: qtyDone,
        });
      }
    }
    if (assigneeId !== undefined && assigneeN !== row.assignee_id) {
      logTaskActivity(db, tid, req.userId, 'assignee', { from: row.assignee_id, to: assigneeN });
    }
    if (parentId !== undefined && parentN !== row.parent_id) {
      logTaskActivity(db, tid, req.userId, 'parent', { from: row.parent_id, to: parentN });
    }

    emitTasksRefresh(io, row.group_id, row.board_id);
    const canvasForTask = db
      .prepare(
        `SELECT id FROM task_board_canvas_items WHERE board_id = ? AND task_id = ? AND kind = 'task'`
      )
      .all(row.board_id, tid);
    for (const c of canvasForTask) {
      scheduleCanvasSyncUpsert(io, db, row.group_id, row.board_id, c.id);
    }
    const t = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(tid);
    const node = buildTaskTreeWithRollup([t], db)[0];
    res.json(mapTasksForViewer(db, row.group_id, req.userId, [node])[0]);
  });

  w.delete('/tasks/:taskId', requireAuth, (req, res) => {
    const tid = +req.params.taskId;
    const row = db.prepare(`SELECT t.*, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`).get(tid);
    if (!row) return res.status(404).json({ error: 'Нет' });
    const password = req.query.password || undefined;
    const a = checkBoardAccess(db, row.board_id, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const authorId = row.created_by;
    const isMod = requireGroupMember(db, row.group_id, req.userId, 'moderator').ok;
    if (!isMod && authorId !== req.userId)
      return res.status(403).json({ error: 'Удалять задачу может автор или модератор/админ' });
    auditGroup(db, req.userId, row.group_id, 'task_delete', {
      taskId: tid,
      boardId: row.board_id,
      title: row.title,
    });
    const canvasForTask = db
      .prepare(
        `SELECT id FROM task_board_canvas_items WHERE board_id = ? AND task_id = ? AND kind = 'task'`
      )
      .all(row.board_id, tid);
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(tid);
    for (const c of canvasForTask) {
      scheduleCanvasSyncRemove(io, row.group_id, row.board_id, c.id);
    }
    emitTasksRefresh(io, row.group_id, row.board_id);
    res.json({ ok: true });
  });

  // --- Задачи: комментарии и вложения ---

  w.get('/tasks/:taskId/comments', requireAuth, (req, res) => {
    const tid = +req.params.taskId;
    const row = db.prepare(`SELECT t.board_id, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`).get(tid);
    if (!row) return res.status(404).json({ error: 'Нет' });
    const password = req.query.password || undefined;
    const a = checkBoardAccess(db, row.board_id, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const rows = db
      .prepare(
        `SELECT c.id, c.body, c.created_at, c.user_id, u.username, u.display_name, u.tag, u.avatar_file, u.bio
         FROM task_comments c
         JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id`
      )
      .all(tid);
    res.json(
      rows.map((c) => ({
        id: c.id,
        body: maskIfNeeded(db, row.group_id, req.userId, c.user_id, c.body),
        createdAt: c.created_at,
        author: rowUser({
          id: c.user_id,
          username: c.username,
          display_name: c.display_name,
          tag: c.tag,
          avatar_file: c.avatar_file,
          bio: c.bio,
        }),
      }))
    );
  });

  w.post('/tasks/:taskId/comments', requireAuth, (req, res) => {
    const tid = +req.params.taskId;
    const row = db.prepare(`SELECT t.board_id, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`).get(tid);
    if (!row) return res.status(404).json({ error: 'Нет' });
    const { password, body } = req.body || {};
    const a = checkBoardAccess(db, row.board_id, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body' });
    const bodyTrim = String(body).trim();
    const info = db
      .prepare(`INSERT INTO task_comments (task_id, user_id, body) VALUES (?,?,?)`)
      .run(tid, req.userId, bodyTrim);
    logTaskActivity(db, tid, req.userId, 'comment_add', { preview: bodyTrim.slice(0, 160) });
    emitTasksRefresh(io, row.group_id, row.board_id);
    res.json({ id: info.lastInsertRowid });
  });

  w.delete('/tasks/:taskId/comments/:commentId', requireAuth, (req, res) => {
    const tid = +req.params.taskId;
    const cid = +req.params.commentId;
    const password = req.query.password || req.body?.password;
    const row = db.prepare(`SELECT t.board_id, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`).get(tid);
    if (!row) return res.status(404).json({ error: 'Нет задачи' });
    const a = checkBoardAccess(db, row.board_id, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const comment = db
      .prepare(`SELECT id, user_id FROM task_comments WHERE id = ? AND task_id = ?`)
      .get(cid, tid);
    if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });
    const isMod = requireGroupMember(db, row.group_id, req.userId, 'moderator').ok;
    if (!isMod && comment.user_id !== req.userId)
      return res.status(403).json({ error: 'Удалить может автор или модератор/админ' });
    db.prepare(`DELETE FROM task_comments WHERE id = ?`).run(cid);
    emitTasksRefresh(io, row.group_id, row.board_id);
    res.json({ ok: true });
  });

  w.post('/tasks/:taskId/attachments', requireAuth, upload.single('file'), (req, res) => {
    const tid = +req.params.taskId;
    const row = db.prepare(`SELECT t.board_id, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`).get(tid);
    if (!row) return res.status(404).json({ error: 'Нет' });
    const password = req.body?.password;
    const a = checkBoardAccess(db, row.board_id, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    if (!req.file) return res.status(400).json({ error: 'file' });
    const origName = decodeMultipartFilename(req.file.originalname) || req.file.filename;
    const info = db
      .prepare(
        `INSERT INTO task_attachments (task_id, file_name, stored_name, mime_type, uploaded_by) VALUES (?,?,?,?,?)`
      )
      .run(tid, origName, req.file.filename, req.file.mimetype || 'application/octet-stream', req.userId);
    logTaskActivity(db, tid, req.userId, 'attachment_add', { fileName: origName });
    auditGroup(db, req.userId, row.group_id, 'task_attachment_upload', {
      taskId: tid,
      boardId: row.board_id,
      fileName: origName,
      attachmentId: info.lastInsertRowid,
    });
    emitTasksRefresh(io, row.group_id, row.board_id);
    res.json({
      id: info.lastInsertRowid,
      url: `/uploads/${req.file.filename}`,
      fileName: origName,
      mimeType: req.file.mimetype,
    });
  });

  w.get('/tasks/:taskId/attachments', requireAuth, (req, res) => {
    const tid = +req.params.taskId;
    const row = db.prepare(`SELECT t.board_id FROM tasks t WHERE t.id = ?`).get(tid);
    if (!row) return res.status(404).json({ error: 'Нет' });
    const password = req.query.password || undefined;
    const a = checkBoardAccess(db, row.board_id, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const rows = db.prepare(`SELECT * FROM task_attachments WHERE task_id = ?`).all(tid);
    res.json(
      rows.map((x) => ({
        id: x.id,
        url: `/uploads/${x.stored_name}`,
        fileName: x.file_name,
        mimeType: x.mime_type,
        createdAt: x.created_at,
      }))
    );
  });

  // --- Канбан: элементы доски (карточки на канвасе), загрузка файлов, PATCH/DELETE ---

  w.get('/task-boards/:boardId/canvas-items', requireAuth, (req, res) => {
    const bid = +req.params.boardId;
    const password = req.query.password || undefined;
    const a = checkBoardAccess(db, bid, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const gid = a.board.group_id;
    const rows = db
      .prepare(`SELECT * FROM task_board_canvas_items WHERE board_id = ? ORDER BY z_index, id`)
      .all(bid);
    res.json(rows.map((row) => hydrateCanvasItem(db, row, gid, req.userId)));
  });

  w.post('/task-boards/:boardId/canvas-items', requireAuth, (req, res) => {
    const bid = +req.params.boardId;
    const {
      password,
      kind,
      title,
      taskId,
      collabDocumentId,
      linkUrl: linkUrlRaw,
      positionX,
      positionY,
      parentItemId,
      width,
      height,
    } = req.body || {};
    const a = checkBoardAccess(db, bid, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const gid = a.board.group_id;
    if (!['folder', 'task', 'collab_doc', 'link'].includes(kind)) return res.status(400).json({ error: 'kind' });
    let parent_id = parentItemId != null && parentItemId !== '' ? +parentItemId : null;
    if (parent_id) {
      const p = db
        .prepare(`SELECT id, kind FROM task_board_canvas_items WHERE id = ? AND board_id = ?`)
        .get(parent_id, bid);
      if (!p || p.kind !== 'folder') return res.status(400).json({ error: 'parentItemId' });
    }
    const px = positionX != null && Number.isFinite(+positionX) ? +positionX : 48;
    const py = positionY != null && Number.isFinite(+positionY) ? +positionY : 48;
    const w0 = width != null && Number.isFinite(+width) ? Math.max(80, +width) : 220;
    const h0 = height != null && Number.isFinite(+height) ? Math.max(72, +height) : 132;
    let task_id = null;
    let collab_id = null;
    let link_url = null;
    let tit = title != null ? String(title).trim() : '';
    if (kind === 'folder') {
      if (!tit) return res.status(400).json({ error: 'Название папки' });
    } else if (kind === 'task') {
      const tid = +taskId;
      if (!Number.isFinite(tid)) return res.status(400).json({ error: 'taskId' });
      const t = db.prepare(`SELECT id FROM tasks WHERE id = ? AND board_id = ?`).get(tid, bid);
      if (!t) return res.status(404).json({ error: 'Задача не на этой доске' });
      task_id = tid;
    } else if (kind === 'collab_doc') {
      const did = +collabDocumentId;
      if (!Number.isFinite(did)) return res.status(400).json({ error: 'collabDocumentId' });
      const d = db.prepare(`SELECT id FROM collab_documents WHERE id = ? AND group_id = ?`).get(did, gid);
      if (!d) return res.status(404).json({ error: 'Документ не найден в группе' });
      collab_id = did;
    } else if (kind === 'link') {
      let u = String(linkUrlRaw || '').trim();
      if (!u) return res.status(400).json({ error: 'Укажите ссылку (linkUrl)' });
      if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
      try {
        new URL(u);
      } catch {
        return res.status(400).json({ error: 'Некорректный URL' });
      }
      link_url = u;
    }
    const zi = db.prepare(`SELECT COALESCE(MAX(z_index),0)+1 AS n FROM task_board_canvas_items WHERE board_id = ?`).get(bid);
    const nextZ = zi?.n ?? 1;
    const info = db
      .prepare(
        `INSERT INTO task_board_canvas_items (board_id, kind, title, task_id, collab_document_id, file_stored_name, file_original_name, file_mime, link_url, parent_item_id, position_x, position_y, z_index, pinned, width, height, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        bid,
        kind,
        tit,
        task_id,
        collab_id,
        null,
        null,
        null,
        link_url,
        parent_id,
        px,
        py,
        nextZ,
        0,
        w0,
        h0,
        req.userId
      );
    emitTasksRefresh(io, gid, bid);
    const row = db.prepare(`SELECT * FROM task_board_canvas_items WHERE id = ?`).get(info.lastInsertRowid);
    scheduleCanvasSyncUpsert(io, db, gid, bid, info.lastInsertRowid);
    res.json(hydrateCanvasItem(db, row, gid, req.userId));
  });

  w.post('/task-boards/:boardId/canvas-upload', requireAuth, upload.single('file'), (req, res) => {
    const bid = +req.params.boardId;
    const password = req.body?.password;
    const a = checkBoardAccess(db, bid, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    if (!req.file) return res.status(400).json({ error: 'file' });
    const gid = a.board.group_id;
    let parent_id =
      req.body?.parentItemId != null && req.body?.parentItemId !== '' ? +req.body.parentItemId : null;
    if (parent_id) {
      const p = db
        .prepare(`SELECT id, kind FROM task_board_canvas_items WHERE id = ? AND board_id = ?`)
        .get(parent_id, bid);
      if (!p || p.kind !== 'folder') return res.status(400).json({ error: 'parentItemId' });
    }
    const px = req.body?.positionX != null && Number.isFinite(+req.body.positionX) ? +req.body.positionX : 48;
    const py = req.body?.positionY != null && Number.isFinite(+req.body.positionY) ? +req.body.positionY : 48;
    const zi = db.prepare(`SELECT COALESCE(MAX(z_index),0)+1 AS n FROM task_board_canvas_items WHERE board_id = ?`).get(bid);
    const nextZ = zi?.n ?? 1;
    const origName = decodeMultipartFilename(req.file.originalname) || req.file.filename;
    const info = db
      .prepare(
        `INSERT INTO task_board_canvas_items (board_id, kind, title, file_stored_name, file_original_name, file_mime, link_url, parent_item_id, position_x, position_y, z_index, pinned, width, height, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        bid,
        'upload',
        origName,
        req.file.filename,
        origName,
        req.file.mimetype || 'application/octet-stream',
        null,
        parent_id,
        px,
        py,
        nextZ,
        0,
        220,
        132,
        req.userId
      );
    const itemId = info.lastInsertRowid;
    auditGroup(db, req.userId, gid, 'task_board_canvas_file_upload', {
      boardId: bid,
      itemId,
      fileName: origName,
      mime: req.file.mimetype || 'application/octet-stream',
    });
    emitTasksRefresh(io, gid, bid);
    const row = db.prepare(`SELECT * FROM task_board_canvas_items WHERE id = ?`).get(itemId);
    scheduleCanvasSyncUpsert(io, db, gid, bid, itemId);
    res.json(hydrateCanvasItem(db, row, gid, req.userId));
  });

  w.patch('/task-board-canvas/:itemId', requireAuth, (req, res) => {
    const id = +req.params.itemId;
    const row = db.prepare(`SELECT * FROM task_board_canvas_items WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Нет' });
    const { password, positionX, positionY, zIndex, pinned, parentItemId, width, height, title, linkUrl } =
      req.body || {};
    const a = checkBoardAccess(db, row.board_id, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const gid = a.board.group_id;
    let parent_id = row.parent_item_id;
    if (parentItemId !== undefined) {
      if (parentItemId === null || parentItemId === '') parent_id = null;
      else {
        const pid = +parentItemId;
        if (pid === id) return res.status(400).json({ error: 'parentItemId' });
        const p = db
          .prepare(`SELECT id, kind FROM task_board_canvas_items WHERE id = ? AND board_id = ?`)
          .get(pid, row.board_id);
        if (!p || p.kind !== 'folder') return res.status(400).json({ error: 'parentItemId' });
        parent_id = pid;
      }
    }
    const px = positionX !== undefined ? +positionX : row.position_x;
    const py = positionY !== undefined ? +positionY : row.position_y;
    const zi = zIndex !== undefined ? +zIndex : row.z_index;
    const pin = pinned !== undefined ? (pinned ? 1 : 0) : row.pinned;
    const wv = width !== undefined ? Math.max(80, +width) : row.width;
    const hv = height !== undefined ? Math.max(72, +height) : row.height;
    let tit = row.title;
    if (title !== undefined && (row.kind === 'folder' || row.kind === 'link')) tit = String(title).trim();
    let link_u = row.link_url;
    if (linkUrl !== undefined && row.kind === 'link') {
      const raw = String(linkUrl || '').trim();
      if (raw) {
        let u = raw;
        if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
        try {
          new URL(u);
        } catch {
          return res.status(400).json({ error: 'Некорректный URL' });
        }
        link_u = u;
      }
    }
    db.prepare(
      `UPDATE task_board_canvas_items SET parent_item_id=?, position_x=?, position_y=?, z_index=?, pinned=?, width=?, height=?, title=?, link_url=?, updated_at=datetime('now') WHERE id=?`
    ).run(parent_id, px, py, zi, pin, wv, hv, tit, link_u, id);
    emitTasksRefresh(io, gid, row.board_id);
    const r2 = db.prepare(`SELECT * FROM task_board_canvas_items WHERE id = ?`).get(id);
    scheduleCanvasSyncUpsert(io, db, gid, row.board_id, id);
    res.json(hydrateCanvasItem(db, r2, gid, req.userId));
  });

  w.delete('/task-board-canvas/:itemId', requireAuth, (req, res) => {
    const id = +req.params.itemId;
    const row = db.prepare(`SELECT * FROM task_board_canvas_items WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Нет' });
    const password = req.query.password || req.body?.password;
    const a = checkBoardAccess(db, row.board_id, req.userId, password);
    if (!a.ok) return res.status(403).json({ error: a.error });
    const gid = a.board.group_id;
    if (!canDeleteAsAuthorOrModerator(db, gid, req.userId, row.created_by))
      return res.status(403).json({ error: 'Удалять может автор или модератор' });
    db.prepare(`DELETE FROM task_board_canvas_items WHERE id = ?`).run(id);
    emitTasksRefresh(io, gid, row.board_id);
    scheduleCanvasSyncRemove(io, gid, row.board_id, id);
    res.json({ ok: true });
  });

  r.use(w);
}
