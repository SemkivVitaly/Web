/**
 * @fileoverview Основной HTTP API LocalChat (REST под префиксом `/api`).
 *
 * Регистрирует маршруты: публичные ping/health, auth, профиль, коллеги, группы (в т.ч. аудит и экспорт),
 * личные чаты, настройки чатов, непрочитанные, сообщения (лента, вложения, реакции, треды, поиск),
 * ссылки сообщений на задачи/документы. Тяжёлая логика задач/коллаба вынесена в `workspaceRoutes.js`,
 * OnlyOffice — в `onlyOfficeRoutes.js`.
 *
 * Фабрика {@link createApiRouter} принимает `io` (Socket.IO) для push в комнаты `group:*`, `direct:*`, `user:*`.
 */

import express from 'express';
import fs from 'node:fs';
import { randomBytes } from 'crypto';
import { getDb } from './db.js';
import { hashPassword, verifyPassword, signToken, generateTag } from './auth.js';
import { requireAuth } from './middleware.js';
import { parseMentionTags, parseExtraMentionUserIdsFromBody } from './mentions.js';
import { upload, detectKind, uploadsDir, normalizePossibleMultipartFilename } from './upload.js';
import { appendWorkspaceRoutes } from './workspaceRoutes.js';
import { writeAudit } from './auditLog.js';
import { appendOnlyOfficeRoutes } from './onlyOfficeRoutes.js';
import { maskProfanity } from './profanityFilter.js';
import { shouldMaskGroupTextForViewer } from './moderation.js';
import { createRateLimiter } from './rateLimit.js';
import { unlinkOrphanMessageAttachmentFiles } from './uploadCleanup.js';

/** Срабатывание UNIQUE в SQLite (в т.ч. обёрнутое в SQLITE_CONSTRAINT). */
function isSqliteUniqueViolation(e) {
  const code = e?.code;
  const msg = String(e?.message || '').toLowerCase();
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || (code === 'SQLITE_CONSTRAINT' && msg.includes('unique'));
}

/**
 * Привязки задачи/документа к сообщению при отправке (multipart `workspaceLinks` — JSON-массив).
 * @param {Record<string, unknown>} body — `req.body`
 * @returns {{ kind: 'task' | 'collab_document', entityId: number }[]}
 */
function parseWorkspaceLinksFromComposeBody(body) {
  const wsRaw = body?.workspaceLinks ?? body?.workspace_links;
  if (wsRaw == null || wsRaw === '') return [];
  try {
    const j = typeof wsRaw === 'string' ? JSON.parse(wsRaw) : wsRaw;
    if (!Array.isArray(j)) return [];
    const out = [];
    const seen = new Set();
    for (const x of j) {
      const kind =
        x?.kind === 'collab_document'
          ? 'collab_document'
          : x?.kind === 'task'
            ? 'task'
            : null;
      const entityId = +x?.entityId;
      if (!kind || !Number.isFinite(entityId) || entityId <= 0) continue;
      const key = `${kind}:${entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, entityId });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Вставка одной строки `message_workspace_links` с проверкой принадлежности сущности группе.
 */
function tryInsertMessageWorkspaceLink(dbConn, mid, gid, userId, kind, entityId) {
  if (kind === 'task') {
    const t = dbConn
      .prepare(`SELECT t.id, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`)
      .get(entityId);
    if (!t || t.group_id !== gid) return;
  } else {
    const doc = dbConn.prepare(`SELECT id, group_id FROM collab_documents WHERE id = ?`).get(entityId);
    if (!doc || doc.group_id !== gid) return;
  }
  try {
    dbConn
      .prepare(
        `INSERT INTO message_workspace_links (message_id, link_kind, entity_id, created_by) VALUES (?,?,?,?)`
      )
      .run(mid, kind, entityId, userId);
  } catch (e) {
    if (!isSqliteUniqueViolation(e)) throw e;
  }
}

function insertMessageWorkspaceLinkRaw(dbConn, messageId, linkKind, entityId, userId) {
  try {
    dbConn
      .prepare(
        `INSERT INTO message_workspace_links (message_id, link_kind, entity_id, created_by) VALUES (?,?,?,?)`
      )
      .run(messageId, linkKind, entityId, userId);
  } catch (e) {
    if (!isSqliteUniqueViolation(e)) throw e;
  }
}

function getFirstTaskBoardIdInGroup(dbConn, groupId) {
  const r = dbConn.prepare(`SELECT id FROM task_boards WHERE group_id = ? ORDER BY id LIMIT 1`).get(groupId);
  return r ? r.id : null;
}

function isBannedInGroupConn(dbConn, groupId, userId) {
  const m = dbConn
    .prepare(`SELECT banned_until FROM group_members WHERE group_id = ? AND user_id = ?`)
    .get(groupId, userId);
  if (!m?.banned_until) return false;
  return new Date(m.banned_until) > new Date();
}

function emitTasksRefreshForBoard(dbConn, io, boardId) {
  const b = dbConn.prepare(`SELECT group_id FROM task_boards WHERE id = ?`).get(boardId);
  if (b) io.to(`group:${b.group_id}`).emit('tasks:refresh', { boardId, groupId: b.group_id });
}

/**
 * Копия задачи для пересылки: новая строка в целевой группе (та же доска, если группа совпадает, иначе первая доска).
 * @returns {number | null} id новой задачи
 */
function cloneTaskForForward(dbConn, io, sourceTaskId, destGroupId, userId) {
  const t = dbConn
    .prepare(
      `SELECT t.*, b.group_id AS board_group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`
    )
    .get(sourceTaskId);
  if (!t) return null;
  const mem = dbConn.prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?`).get(destGroupId, userId);
  if (!mem || isBannedInGroupConn(dbConn, destGroupId, userId)) return null;

  let destBoardId =
    t.board_group_id === destGroupId ? t.board_id : getFirstTaskBoardIdInGroup(dbConn, destGroupId);
  if (destBoardId == null) return null;

  const sortRow = dbConn
    .prepare(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM tasks WHERE board_id = ? AND parent_id IS NULL`
    )
    .get(destBoardId);
  const sortOrder = sortRow?.n ?? 0;

  const rawTitle = String(t.title || '').trim();
  const title = (rawTitle ? `${rawTitle} (копия)` : 'Задача (копия)').slice(0, 500);
  const description = String(t.description || '');
  const qtyTarget = t.quantity_target;
  const qtyDone = qtyTarget != null && qtyTarget > 0 ? 0 : t.quantity_done ?? 0;
  const progress = qtyTarget != null && qtyTarget > 0 ? 0 : Math.min(100, Math.max(0, t.progress ?? 0));
  const status =
    qtyTarget != null && qtyTarget > 0 && String(t.status) === 'done' ? 'todo' : String(t.status || 'todo');

  const info = dbConn
    .prepare(
      `INSERT INTO tasks (board_id, parent_id, title, description, status, progress, quantity_target, quantity_done, assignee_id, created_by, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      destBoardId,
      null,
      title,
      description,
      status,
      progress,
      qtyTarget,
      qtyDone,
      null,
      userId,
      sortOrder
    );
  const newId = info.lastInsertRowid;
  emitTasksRefreshForBoard(dbConn, io, destBoardId);
  return newId;
}

/**
 * Копия коллаб-документа (Yjs/мета): новый документ в корне целевой группы, без пароля и превью-файла.
 * @returns {number | null}
 */
function cloneCollabDocForForward(dbConn, io, sourceDocId, destGroupId, userId) {
  const row = dbConn.prepare(`SELECT * FROM collab_documents WHERE id = ?`).get(sourceDocId);
  if (!row) return null;
  const mem = dbConn.prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?`).get(destGroupId, userId);
  if (!mem || isBannedInGroupConn(dbConn, destGroupId, userId)) return null;

  const baseName = String(row.name || 'Документ').trim();
  const name = (baseName ? `${baseName} (копия)` : 'Документ (копия)').slice(0, 200);
  const description = String(row.description || '');
  const docType = row.doc_type;
  const yState = row.y_state ?? null;
  const officeRev = Number(row.office_revision ?? 0);

  const info = dbConn
    .prepare(
      `INSERT INTO collab_documents (group_id, folder_id, name, description, doc_type, password_hash, y_state, created_by, task_board_only, office_revision, preview_stored_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(destGroupId, null, name, description, docType, null, yState, userId, 0, officeRev, null);

  const newId = info.lastInsertRowid;
  io.to(`group:${destGroupId}`).emit('collab:tree-refresh', { groupId: destGroupId });
  return newId;
}

/**
 * При пересылке сообщений привязки # дают новые задачи/документы (копии), а не ссылку на оригинал.
 */
function cloneWorkspaceLinksForForwardedMessage(dbConn, io, newMid, targetKind, targetGroupId, userId, sourceMessageIds) {
  const seen = new Set();
  for (const srcMid of sourceMessageIds) {
    const rows = dbConn
      .prepare(`SELECT link_kind, entity_id FROM message_workspace_links WHERE message_id = ?`)
      .all(srcMid);
    for (const r of rows) {
      const key = `${r.link_kind}:${r.entity_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let destGroupId = null;
      if (targetKind === 'group') {
        destGroupId = targetGroupId;
      } else if (r.link_kind === 'task') {
        const t = dbConn
          .prepare(`SELECT b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`)
          .get(r.entity_id);
        destGroupId = t?.group_id ?? null;
      } else {
        const d = dbConn.prepare(`SELECT group_id FROM collab_documents WHERE id = ?`).get(r.entity_id);
        destGroupId = d?.group_id ?? null;
      }
      if (destGroupId == null) continue;

      let newEntityId = null;
      if (r.link_kind === 'task') {
        newEntityId = cloneTaskForForward(dbConn, io, r.entity_id, destGroupId, userId);
      } else if (r.link_kind === 'collab_document') {
        newEntityId = cloneCollabDocForForward(dbConn, io, r.entity_id, destGroupId, userId);
      }
      if (newEntityId != null) {
        insertMessageWorkspaceLinkRaw(dbConn, newMid, r.link_kind, newEntityId, userId);
      }
    }
  }
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Уникальные http(s) URL из текста сообщения (для индекса ссылок в чате). */
function extractUrlsFromText(text) {
  const s = String(text || '');
  const out = [];
  let m;
  URL_IN_TEXT_RE.lastIndex = 0;
  while ((m = URL_IN_TEXT_RE.exec(s)) !== null) {
    out.push(m[0]);
  }
  return [...new Set(out)];
}

/** SQLite datetime('now') хранит UTC как "YYYY-MM-DD HH:MM:SS" без часового пояса; без Z браузер часто считает это локальным временем. */
function sqliteUtcToIso(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) return s;
  if (s.includes('T')) return s.endsWith('Z') ? s : `${s}Z`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return `${s.replace(' ', 'T')}Z`;
  return s;
}

/**
 * Создаёт `express.Router` со всеми маршрутами API и замыканиями на БД + `io`.
 *
 * @param {import('socket.io').Server} io — сервер Socket.IO (раздача событий клиентам)
 * @returns {express.Router}
 */
export function createApiRouter(io) {
  const db = getDb();
  const r = express.Router();

  // --- Внутренние хелперы: удаление сообщения, лимиты, публичные проверки ---

  /** Удаляет сообщение и файлы вложений, если больше ни на одном сообщении не используются. */
  function deleteMessageWithAttachmentCleanup(messageId) {
    const rows = db.prepare(`SELECT stored_name FROM message_attachments WHERE message_id = ?`).all(messageId);
    const names = rows.map((x) => x.stored_name);
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(messageId);
    unlinkOrphanMessageAttachmentFiles(db, names);
  }

  /**
   * Лимиты. Разделены login и register, чтобы перебор одного не «съедал» бюджет другого. Также
   * отдельные лимиты на поиск пользователей, запросы в друзья, пересылку — раньше их не было.
   */
  const ipKey = (req) => req.ip || req.socket?.remoteAddress || 'x';
  const loginIpLimit = createRateLimiter({
    windowMs: 60_000,
    max: 20,
    keyFn: (req) => `login:${ipKey(req)}`,
  });
  const registerIpLimit = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    keyFn: (req) => `register:${ipKey(req)}`,
  });
  const msgUserLimit = createRateLimiter({
    windowMs: 60_000,
    max: 120,
    keyFn: (req) => `msg:${req.userId}`,
  });
  const forwardUserLimit = createRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyFn: (req) => `fwd:${req.userId}`,
  });
  const searchUserLimit = createRateLimiter({
    windowMs: 60_000,
    max: 45,
    keyFn: (req) => `search:${req.userId}`,
  });
  const userSearchLimit = createRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyFn: (req) => `usersearch:${req.userId}`,
  });
  const friendReqLimit = createRateLimiter({
    windowMs: 60_000,
    max: 20,
    keyFn: (req) => `friendreq:${req.userId}`,
  });
  const meUserLimit = createRateLimiter({
    windowMs: 60_000,
    max: 40,
    keyFn: (req) => `me:${req.userId}`,
  });

  r.get('/public/ping', (_req, res) => {
    res.json({ ok: true, name: 'LocalChat' });
  });

  r.get('/public/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      const uploadsOk = fs.existsSync(uploadsDir);
      res.json({
        ok: true,
        name: 'LocalChat',
        database: 'ok',
        uploadsDir: uploadsOk ? 'ok' : 'missing',
        uptimeSec: Math.floor(process.uptime()),
        rssBytes: process.memoryUsage().rss,
      });
    } catch (e) {
      // Не раскрываем деталей ошибки публично (DB path, stack). Логируем у себя.
      console.error('[public/health]', e);
      res.status(503).json({ ok: false, error: 'unhealthy' });
    }
  });

  // --- Утилиты ответа: пользователь в JSON, время, разрешение тега → userId ---

  const emitToUser = (userId, event, data) => {
    io.to(`user:${userId}`).emit(event, data);
  };

  function rowUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      tag: u.tag,
      bio: u.bio || '',
      avatarUrl: u.avatar_file ? `/uploads/${u.avatar_file}` : null,
      createdAt: u.created_at,
    };
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /** Тег: без @, регистр не важен. Альтернатива — числовой userId в теле запроса. */
  function resolveTargetUserId(body, currentUserId, { tagKey = 'tag', userIdKey = 'userId' } = {}) {
    const rawTag = String(body?.[tagKey] ?? '')
      .trim()
      .replace(/^@+/, '')
      .trim();
    if (rawTag.length > 0) {
      const u = db.prepare(`SELECT id FROM users WHERE tag = ? COLLATE NOCASE`).get(rawTag);
      if (!u) return { error: 'Пользователь с таким тегом не найден' };
      if (u.id === currentUserId) return { error: 'Нельзя указать себя' };
      return { userId: u.id };
    }
    const id = body?.[userIdKey];
    if (id == null || id === '') return { error: 'Укажите тег (например @nickname) или userId' };
    const num = +id;
    if (!Number.isFinite(num) || num <= 0) return { error: 'Некорректный userId' };
    if (num === currentUserId) return { error: 'Нельзя указать себя' };
    const peer = db.prepare(`SELECT id FROM users WHERE id = ?`).get(num);
    if (!peer) return { error: 'Пользователь не найден' };
    return { userId: num };
  }

  function isBannedMember(groupId, userId) {
    const m = db
      .prepare(
        `SELECT banned_until FROM group_members WHERE group_id = ? AND user_id = ?`
      )
      .get(groupId, userId);
    if (!m) return false;
    if (!m.banned_until) return false;
    return new Date(m.banned_until) > new Date();
  }

  function getMembership(groupId, userId) {
    return db
      .prepare(
        `SELECT role, banned_until FROM group_members WHERE group_id = ? AND user_id = ?`
      )
      .get(groupId, userId);
  }

  function requireGroupMember(groupId, userId, minRole = 'member') {
    const m = getMembership(groupId, userId);
    if (!m || isBannedMember(groupId, userId)) return { ok: false, error: 'Нет доступа к чату' };
    const order = { member: 0, moderator: 1, admin: 2 };
    if (order[m.role] < order[minRole]) return { ok: false, error: 'Недостаточно прав' };
    return { ok: true, role: m.role };
  }

  function areFriends(a, b) {
    const row = db
      .prepare(
        `SELECT status FROM friendships 
         WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
         AND status = 'accepted'`
      )
      .get(a, b, b, a);
    return !!row;
  }

  function ensureDirect(userId, peerId) {
    if (userId === peerId) return null;
    const low = Math.min(userId, peerId);
    const high = Math.max(userId, peerId);
    let conv = db
      .prepare(`SELECT id FROM direct_conversations WHERE user_low_id = ? AND user_high_id = ?`)
      .get(low, high);
    if (!conv) {
      const info = db
        .prepare(
          `INSERT INTO direct_conversations (user_low_id, user_high_id) VALUES (?, ?)`
        )
        .run(low, high);
      conv = { id: info.lastInsertRowid };
    }
    return conv.id;
  }

  function clearDirectHiddenForBoth(directId) {
    const d = db
      .prepare(`SELECT user_low_id, user_high_id FROM direct_conversations WHERE id = ?`)
      .get(directId);
    if (!d) return;
    db.prepare(
      `UPDATE user_chat_prefs SET hidden = 0 WHERE chat_kind = 'direct' AND chat_id = ? AND user_id IN (?, ?)`
    ).run(directId, d.user_low_id, d.user_high_id);
  }

  function runGroupJoin(g, req, res) {
    const gid = g.id;
    const already = getMembership(gid, req.userId);
    if (already && !isBannedMember(gid, req.userId))
      return res.status(409).json({ error: 'Вы уже в группе' });
    if (isBannedMember(gid, req.userId)) return res.status(403).json({ error: 'Вы забанены' });
    if (g.password_hash) {
      const { password } = req.body || {};
      if (!password || !verifyPassword(String(password), g.password_hash))
        return res.status(403).json({ error: 'Неверный пароль' });
    }
    db.prepare(
      `INSERT OR REPLACE INTO group_members (group_id, user_id, role, banned_until) VALUES (?,?, 'member', NULL)`
    ).run(gid, req.userId);
    emitGroupMemberJoinedChatAndSocket(gid, req.userId);
    res.json({ ok: true, groupId: gid });
  }

  function canUserInviteToGroup(groupId, userId) {
    const m = getMembership(groupId, userId);
    if (!m || isBannedMember(groupId, userId)) return false;
    const g = db.prepare(`SELECT invite_policy FROM groups WHERE id = ?`).get(groupId);
    const policy = g?.invite_policy || 'all';
    const order = { member: 0, moderator: 1, admin: 2 };
    if (policy === 'all') return true;
    if (policy === 'admin_moderator') return order[m.role] >= order.moderator;
    if (policy === 'admin_only') return m.role === 'admin';
    return true;
  }

  // --- Auth ---
  r.post('/auth/register', registerIpLimit, (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (!username || !password || !displayName)
      return res.status(400).json({ error: 'username, password, displayName обязательны' });
    const exists = db.prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`).get(username);
    if (exists) return res.status(409).json({ error: 'Имя пользователя занято' });
    const password_hash = hashPassword(password);
    const uname = String(username).trim();
    const dname = String(displayName).trim();
    let userId = null;
    for (let attempt = 0; attempt < 64; attempt++) {
      const tag =
        attempt === 0
          ? generateTag(username)
          : generateTag(`${username}_${randomBytes(3).toString('hex')}`);
      try {
        const info = db
          .prepare(
            `INSERT INTO users (username, password_hash, display_name, tag) VALUES (?,?,?,?)`
          )
          .run(uname, password_hash, dname, tag);
        userId = info.lastInsertRowid;
        break;
      } catch (e) {
        if (isSqliteUniqueViolation(e)) {
          if (String(e.message).toLowerCase().includes('users.username'))
            return res.status(409).json({ error: 'Имя пользователя занято' });
          if (String(e.message).toLowerCase().includes('users.tag')) continue;
        }
        throw e;
      }
    }
    if (!userId)
      return res.status(500).json({ error: 'Не удалось назначить уникальный тег — повторите регистрацию' });
    const token = signToken({ userId });
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    res.json({ token, user: rowUser(user) });
  });

  r.post('/auth/login', loginIpLimit, (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
    const user = db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`).get(username);
    if (!user || !verifyPassword(password, user.password_hash))
      return res.status(401).json({ error: 'Неверные данные' });
    res.json({ token: signToken({ userId: user.id }), user: rowUser(user) });
  });

  r.get('/me', requireAuth, (req, res) => {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(rowUser(user));
  });

  r.patch('/me', requireAuth, meUserLimit, upload.single('avatar'), (req, res) => {
    const { displayName, bio } = req.body || {};
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.userId);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    let avatar_file = user.avatar_file;
    if (req.file) avatar_file = req.file.filename;
    db.prepare(
      `UPDATE users SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio), avatar_file = ? WHERE id = ?`
    ).run(
      displayName != null ? String(displayName).trim() : null,
      bio != null ? String(bio) : null,
      avatar_file,
      req.userId
    );
    const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.userId);
    res.json(rowUser(u));
  });

  r.patch('/me/tag', requireAuth, meUserLimit, (req, res) => {
    const { tag } = req.body || {};
    if (!tag || typeof tag !== 'string') return res.status(400).json({ error: 'Укажите tag' });
    const clean = tag.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (clean.length < 3 || clean.length > 32)
      return res.status(400).json({ error: 'Тег 3–32 символа: латиница, цифры, _ (уникален для всей системы)' });
    const clash = db.prepare(`SELECT id FROM users WHERE tag = ? COLLATE NOCASE AND id != ?`).get(clean, req.userId);
    if (clash) return res.status(409).json({ error: 'Такой тег уже существует — выберите другой' });
    try {
      db.prepare(`UPDATE users SET tag = ? WHERE id = ?`).run(clean, req.userId);
    } catch (e) {
      if (isSqliteUniqueViolation(e) && String(e.message).toLowerCase().includes('tag'))
        return res.status(409).json({ error: 'Такой тег уже существует — выберите другой' });
      throw e;
    }
    const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.userId);
    res.json(rowUser(u));
  });

  r.get('/users/search', requireAuth, userSearchLimit, (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 1) return res.json([]);
    const like = `%${q.replace(/%/g, '')}%`;
    const rows = db
      .prepare(
        `SELECT id, username, display_name, tag, avatar_file FROM users 
         WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? OR tag LIKE ? COLLATE NOCASE
         LIMIT 30`
      )
      .all(like, like, like);
    res.json(rows.map((x) => rowUser(x)));
  });

  // --- Friends ---
  r.get('/friends', requireAuth, (req, res) => {
    const rows = db
      .prepare(
        `SELECT u.* FROM friendships f
         JOIN users u ON (
           CASE WHEN f.from_user_id = ? THEN f.to_user_id ELSE f.from_user_id END = u.id
         )
         WHERE (f.from_user_id = ? OR f.to_user_id = ?) AND f.status = 'accepted'`
      )
      .all(req.userId, req.userId, req.userId);
    res.json(rows.map(rowUser));
  });

  r.get('/friends/pending', requireAuth, (req, res) => {
    const incoming = db
      .prepare(
        `SELECT u.* FROM friendships f JOIN users u ON u.id = f.from_user_id
         WHERE f.to_user_id = ? AND f.status = 'pending'`
      )
      .all(req.userId);
    const outgoing = db
      .prepare(
        `SELECT u.* FROM friendships f JOIN users u ON u.id = f.to_user_id
         WHERE f.from_user_id = ? AND f.status = 'pending'`
      )
      .all(req.userId);
    res.json({ incoming: incoming.map(rowUser), outgoing: outgoing.map(rowUser) });
  });

  r.post('/friends/request', requireAuth, friendReqLimit, (req, res) => {
    const resolved = resolveTargetUserId(req.body || {}, req.userId, { tagKey: 'tag', userIdKey: 'userId' });
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const toId = resolved.userId;
    const existing = db
      .prepare(
        `SELECT * FROM friendships WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`
      )
      .get(req.userId, toId, toId, req.userId);
    if (existing) {
      if (existing.status === 'accepted') return res.status(409).json({ error: 'Уже в коллегах' });
      if (existing.status === 'pending')
        return res.status(409).json({ error: 'Заявка уже существует' });
    }
    db.prepare(
      `INSERT INTO friendships (from_user_id, to_user_id, status) VALUES (?,?, 'pending')`
    ).run(req.userId, toId);
    emitToUser(toId, 'friend:request', { fromUserId: req.userId });
    res.json({ ok: true });
  });

  r.post('/friends/accept', requireAuth, (req, res) => {
    const resolved = resolveTargetUserId(req.body || {}, req.userId, { tagKey: 'fromTag', userIdKey: 'userId' });
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const fromId = resolved.userId;
    const r0 = db
      .prepare(
        `UPDATE friendships SET status = 'accepted' WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`
      )
      .run(fromId, req.userId);
    if (r0.changes === 0) return res.status(404).json({ error: 'Заявка не найдена' });
    emitToUser(fromId, 'friend:accepted', { userId: req.userId });
    res.json({ ok: true });
  });

  r.post('/friends/reject', requireAuth, (req, res) => {
    const resolved = resolveTargetUserId(req.body || {}, req.userId, { tagKey: 'fromTag', userIdKey: 'userId' });
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const fromId = resolved.userId;
    db.prepare(`DELETE FROM friendships WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`).run(
      fromId,
      req.userId
    );
    res.json({ ok: true });
  });

  r.delete('/friends/:peerId', requireAuth, (req, res) => {
    const peerId = +req.params.peerId;
    db.prepare(
      `DELETE FROM friendships WHERE 
       ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)) AND status = 'accepted'`
    ).run(req.userId, peerId, peerId, req.userId);
    res.json({ ok: true });
  });

  // --- Groups ---
  r.post('/groups', requireAuth, (req, res) => {
    const { name, password } = req.body || {};
    if (!name || String(name).trim().length < 1)
      return res.status(400).json({ error: 'Название группы обязательно' });
    const password_hash = password ? hashPassword(String(password)) : null;
    const info = db
      .prepare(`INSERT INTO groups (name, password_hash, created_by) VALUES (?,?,?)`)
      .run(String(name).trim(), password_hash, req.userId);
    const gid = info.lastInsertRowid;
    db.prepare(
      `INSERT INTO group_members (group_id, user_id, role) VALUES (?,?, 'admin')`
    ).run(gid, req.userId);
    res.json({ id: gid });
  });

  function effectiveReadCursor(userId, chatKind, chatId) {
    const pref = db
      .prepare(
        `SELECT last_read_message_id FROM user_chat_prefs WHERE user_id = ? AND chat_kind = ? AND chat_id = ?`
      )
      .get(userId, chatKind, chatId);
    if (pref?.last_read_message_id != null) return pref.last_read_message_id;
    if (chatKind === 'group') {
      const r = db.prepare(`SELECT IFNULL(MAX(id), 0) AS m FROM messages WHERE group_id = ?`).get(chatId);
      return r?.m ?? 0;
    }
    const r = db.prepare(`SELECT IFNULL(MAX(id), 0) AS m FROM messages WHERE direct_id = ?`).get(chatId);
    return r?.m ?? 0;
  }

  function unreadCountForChat(userId, chatKind, chatId) {
    const mutePref = db
      .prepare(
        `SELECT mute_notifications FROM user_chat_prefs WHERE user_id = ? AND chat_kind = ? AND chat_id = ?`
      )
      .get(userId, chatKind, chatId);
    if ((mutePref?.mute_notifications ?? 0) === 1) return 0;
    const after = effectiveReadCursor(userId, chatKind, chatId);
    if (chatKind === 'group') {
      return db
        .prepare(
          `SELECT COUNT(*) AS c FROM messages WHERE group_id = ? AND sender_id != ? AND id > ?`
        )
        .get(chatId, userId, after).c;
    }
    return db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE direct_id = ? AND sender_id != ? AND id > ?`)
      .get(chatId, userId, after).c;
  }

  function sidebarLastMessageGroup(viewerId, groupId) {
    const row = db
      .prepare(
        `SELECT m.body, m.sender_id, m.created_at,
          (SELECT COUNT(*) FROM message_attachments a WHERE a.message_id = m.id) AS att_c
         FROM messages m WHERE m.group_id = ? ORDER BY m.id DESC LIMIT 1`
      )
      .get(groupId);
    if (!row) return { lastMessagePreview: null, lastMessageAt: null };
    let text = String(row.body || '').trim().replace(/\s+/g, ' ');
    if (shouldMaskGroupTextForViewer(db, groupId, viewerId, row.sender_id)) {
      text = maskProfanity(text);
    }
    if (!text) {
      if (row.att_c > 1) text = `${row.att_c} вложения`;
      else if (row.att_c === 1) text = 'Вложение';
    }
    return {
      lastMessagePreview: text ? text.slice(0, 160) : null,
      lastMessageAt: sqliteUtcToIso(row.created_at) ?? row.created_at ?? null,
    };
  }

  function sidebarLastMessageDirect(directId) {
    const row = db
      .prepare(
        `SELECT m.body, m.sender_id, m.created_at,
          (SELECT COUNT(*) FROM message_attachments a WHERE a.message_id = m.id) AS att_c
         FROM messages m WHERE m.direct_id = ? ORDER BY m.id DESC LIMIT 1`
      )
      .get(directId);
    if (!row) return { lastMessagePreview: null, lastMessageAt: null };
    let text = String(row.body || '').trim().replace(/\s+/g, ' ');
    if (!text) {
      if (row.att_c > 1) text = `${row.att_c} вложения`;
      else if (row.att_c === 1) text = 'Вложение';
    }
    return {
      lastMessagePreview: text ? text.slice(0, 160) : null,
      lastMessageAt: sqliteUtcToIso(row.created_at) ?? row.created_at ?? null,
    };
  }

  r.get('/groups', requireAuth, (req, res) => {
    const uid = req.userId;
    const rows = db
      .prepare(
        `SELECT g.*, gm.role FROM groups g
         JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
         WHERE gm.banned_until IS NULL OR datetime(gm.banned_until) <= datetime('now')`
      )
      .all(uid);
    res.json(
      rows.map((g) => {
        const lm = sidebarLastMessageGroup(uid, g.id);
        return {
          id: g.id,
          name: g.name,
          hasPassword: !!g.password_hash,
          role: g.role,
          createdAt: sqliteUtcToIso(g.created_at) ?? g.created_at,
          forwardLocked: !!g.forward_locked,
          moderateProfanity: !!g.moderate_profanity,
          invitePolicy: g.invite_policy || 'all',
          joinCode: g.role === 'admin' ? (g.join_code || null) : null,
          lastMessagePreview: lm.lastMessagePreview,
          lastMessageAt: lm.lastMessageAt,
        };
      })
    );
  });

  r.post('/groups/join', requireAuth, (req, res) => {
    const code = String(req.body?.joinCode ?? '').trim();
    if (!code)
      return res.status(400).json({ error: 'Укажите код присоединения' });
    const g = db.prepare(`SELECT * FROM groups WHERE join_code = ? COLLATE NOCASE`).get(code);
    if (!g) return res.status(404).json({ error: 'Группа не найдена' });
    runGroupJoin(g, req, res);
  });

  r.get('/groups/:id', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const g = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(gid);
    res.json({
      id: g.id,
      name: g.name,
      hasPassword: !!g.password_hash,
      role: chk.role,
      createdAt: sqliteUtcToIso(g.created_at) ?? g.created_at,
      forwardLocked: !!g.forward_locked,
      moderateProfanity: !!g.moderate_profanity,
      invitePolicy: g.invite_policy || 'all',
      joinCode: chk.role === 'admin' ? (g.join_code || null) : null,
    });
  });

  r.post('/groups/:id/leave', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const m = getMembership(gid, req.userId);
    if (!m) return res.status(404).json({ error: 'Не состоите в группе' });
    if (req.body?.deleteMyMessages === true) {
      db.prepare(`DELETE FROM messages WHERE group_id = ? AND sender_id = ?`).run(gid, req.userId);
      io.to(`group:${gid}`).emit('chat:messages-cleared', {
        chatKind: 'group',
        chatId: gid,
        scope: 'sender',
        clearedSenderId: req.userId,
      });
    }
    const leaver = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(req.userId);
    const dn = String(leaver?.display_name || 'Пользователь').trim().slice(0, 200) || 'Пользователь';
    const leaveBody = `Пользователь ${dn} покинул чат`;
    const ins = db
      .prepare(`INSERT INTO messages (group_id, sender_id, body, reply_to_id) VALUES (?,?,?,?)`)
      .run(gid, req.userId, leaveBody, null);
    const leaveMsg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(ins.lastInsertRowid);
    emitGroupMessageEvent('message:new', gid, leaveMsg);
    io.to(`group:${gid}`).emit('group:memberLeft', { groupId: gid, userId: req.userId });
    db.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`).run(gid, req.userId);
    res.json({ ok: true });
  });

  r.get('/groups/:id/members', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.tag, u.avatar_file, gm.role, gm.banned_until
         FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?`
      )
      .all(gid);
    res.json(
      rows.map((x) => ({
        ...rowUser(x),
        role: x.role,
        banned: x.banned_until && new Date(x.banned_until) > new Date(),
      }))
    );
  });

  r.post('/groups/:id/invite', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    if (!canUserInviteToGroup(gid, req.userId))
      return res.status(403).json({ error: 'Недостаточно прав для приглашения пользователей' });
    const resolved = resolveTargetUserId(req.body || {}, req.userId, { tagKey: 'tag', userIdKey: 'userId' });
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const invitee = resolved.userId;
    db.prepare(
      `INSERT OR IGNORE INTO group_invites (group_id, inviter_id, invitee_id) VALUES (?,?,?)`
    ).run(gid, req.userId, invitee);
    emitToUser(invitee, 'group:invite', { groupId: gid, inviterId: req.userId });
    res.json({ ok: true });
  });

  r.get('/groups/invites/incoming', requireAuth, (req, res) => {
    const rows = db
      .prepare(
        `SELECT gi.*, g.name as group_name FROM group_invites gi
         JOIN groups g ON g.id = gi.group_id WHERE gi.invitee_id = ?`
      )
      .all(req.userId);
    res.json(rows);
  });

  r.post('/groups/:id/invites/accept', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const inv = db
      .prepare(`SELECT * FROM group_invites WHERE group_id = ? AND invitee_id = ?`)
      .get(gid, req.userId);
    if (!inv) return res.status(404).json({ error: 'Приглашение не найдено' });
    const g = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(gid);
    if (g.password_hash) {
      const { password } = req.body || {};
      if (!password || !verifyPassword(String(password), g.password_hash))
        return res.status(403).json({ error: 'Неверный пароль группы' });
    }
    db.prepare(`DELETE FROM group_invites WHERE group_id = ? AND invitee_id = ?`).run(gid, req.userId);
    db.prepare(
      `INSERT OR REPLACE INTO group_members (group_id, user_id, role, banned_until) VALUES (?,?, 'member', NULL)`
    ).run(gid, req.userId);
    emitGroupMemberJoinedChatAndSocket(gid, req.userId);
    res.json({ ok: true });
  });

  r.post('/groups/:id/kick', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const { userId: target } = req.body || {};
    const tid = +target;
    if (!Number.isFinite(tid) || tid <= 0) return res.status(400).json({ error: 'Некорректный userId' });
    const chk = requireGroupMember(gid, req.userId, 'moderator');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const tmem = getMembership(gid, tid);
    if (!tmem) return res.status(404).json({ error: 'Пользователь не в группе' });
    if (tmem.role === 'admin' && chk.role !== 'admin')
      return res.status(403).json({ error: 'Нельзя исключить администратора' });
    if (tid === req.userId) return res.status(400).json({ error: 'Используйте выход из группы' });
    db.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`).run(gid, tid);
    emitToUser(tid, 'group:kicked', { groupId: gid });
    writeAudit(db, req.userId, 'group_kick', 'group', gid, { targetUserId: tid });
    res.json({ ok: true });
  });

  r.post('/groups/:id/ban', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const { userId: target, until } = req.body || {};
    const tid = +target;
    if (!Number.isFinite(tid) || tid <= 0) return res.status(400).json({ error: 'Некорректный userId' });
    const chk = requireGroupMember(gid, req.userId, 'moderator');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const tmem = getMembership(gid, tid);
    if (!tmem) return res.status(404).json({ error: 'Пользователь не в группе' });
    if (tmem.role === 'admin') return res.status(403).json({ error: 'Нельзя забанить администратора' });
    // Валидируем срок: допустимая ISO-дата в будущем, не более 100 лет.
    const MAX_MS = Date.now() + 100 * 365 * 24 * 3600 * 1000;
    let banUntilMs;
    if (until != null && String(until).trim() !== '') {
      const parsed = Date.parse(String(until));
      if (!Number.isFinite(parsed)) return res.status(400).json({ error: 'Некорректная дата until' });
      if (parsed <= Date.now()) return res.status(400).json({ error: 'Срок должен быть в будущем' });
      banUntilMs = Math.min(parsed, MAX_MS);
    } else {
      banUntilMs = MAX_MS;
    }
    const banUntil = new Date(banUntilMs).toISOString();
    db.prepare(`UPDATE group_members SET banned_until = ? WHERE group_id = ? AND user_id = ?`).run(
      banUntil,
      gid,
      tid
    );
    emitToUser(tid, 'group:banned', { groupId: gid });
    writeAudit(db, req.userId, 'group_ban', 'group', gid, { targetUserId: tid, until: banUntil });
    res.json({ ok: true });
  });

  r.post('/groups/:id/unban', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const { userId: target } = req.body || {};
    const tid = +target;
    if (!Number.isFinite(tid) || tid <= 0) return res.status(400).json({ error: 'Некорректный userId' });
    const chk = requireGroupMember(gid, req.userId, 'moderator');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const tmem = getMembership(gid, tid);
    if (!tmem) return res.status(404).json({ error: 'Пользователь не в группе' });
    db.prepare(`UPDATE group_members SET banned_until = NULL WHERE group_id = ? AND user_id = ?`).run(
      gid,
      tid
    );
    writeAudit(db, req.userId, 'group_unban', 'group', gid, { targetUserId: tid });
    res.json({ ok: true });
  });

  const setGroupMemberRole = (req, res) => {
    const gid = +req.params.id;
    const { userId: target, role } = req.body || {};
    const chk = requireGroupMember(gid, req.userId, 'admin');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const tid = +target;
    if (!Number.isFinite(tid) || tid <= 0) return res.status(400).json({ error: 'Некорректный userId' });
    if (!['admin', 'moderator', 'member'].includes(role)) return res.status(400).json({ error: 'Роль' });
    const tmem = getMembership(gid, tid);
    if (!tmem) return res.status(404).json({ error: 'Пользователь не в группе' });
    db.prepare(`UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?`).run(
      role,
      gid,
      tid
    );
    const grow = db.prepare(`SELECT join_code FROM groups WHERE id = ?`).get(gid);
    const joinCodeForTarget = role === 'admin' ? (grow?.join_code || null) : null;
    emitToUser(tid, 'group:yourRole', { groupId: gid, role, joinCode: joinCodeForTarget });
    io.to(`group:${gid}`).emit('group:memberRole', { groupId: gid, userId: tid, role });
    writeAudit(db, req.userId, 'group_role', 'group', gid, { targetUserId: tid, role });
    res.json({ ok: true });
  };
  r.patch('/groups/:id/role', requireAuth, setGroupMemberRole);
  r.post('/groups/:id/role', requireAuth, setGroupMemberRole);

  r.patch('/groups/:id', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId, 'admin');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const {
      name,
      password,
      clearPassword,
      joinCode,
      forwardLocked,
      moderateProfanity,
      invitePolicy,
    } = req.body || {};
    const g = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(gid);
    let password_hash = g.password_hash;
    if (clearPassword) password_hash = null;
    else if (password) password_hash = hashPassword(String(password));

    let join_code = g.join_code;
    if (joinCode !== undefined) {
      const raw = joinCode == null ? '' : String(joinCode).trim();
      if (raw === '') join_code = null;
      else {
        if (!/^[a-zA-Z0-9_-]{3,32}$/.test(raw))
          return res.status(400).json({
            error: 'Код присоединения: 3–32 символа, латиница, цифры, _ и -',
          });
        join_code = raw.toLowerCase();
      }
    }

    let invite_policy = g.invite_policy || 'all';
    if (invitePolicy !== undefined) {
      if (!['admin_only', 'admin_moderator', 'all'].includes(invitePolicy))
        return res.status(400).json({ error: 'Некорректная политика приглашений' });
      invite_policy = invitePolicy;
    }

    const forward_locked =
      forwardLocked !== undefined ? (forwardLocked ? 1 : 0) : g.forward_locked ?? 0;
    const moderate_profanity =
      moderateProfanity !== undefined ? (moderateProfanity ? 1 : 0) : g.moderate_profanity ?? 0;

    try {
      db.prepare(
        `UPDATE groups SET name = COALESCE(?, name), password_hash = ?, join_code = ?, forward_locked = ?, moderate_profanity = ?, invite_policy = ? WHERE id = ?`
      ).run(
        name != null ? String(name).trim() : null,
        password_hash,
        join_code,
        forward_locked,
        moderate_profanity,
        invite_policy,
        gid
      );
    } catch (e) {
      if (isSqliteUniqueViolation(e))
        return res.status(409).json({ error: 'Такой код присоединения уже занят' });
      throw e;
    }
    const g2 = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(gid);
    io.to(`group:${gid}`).emit('group:settings', {
      groupId: gid,
      forwardLocked: !!g2.forward_locked,
      moderateProfanity: !!g2.moderate_profanity,
      invitePolicy: g2.invite_policy || 'all',
    });
    writeAudit(db, req.userId, 'group_settings', 'group', gid, {
      name: name != null ? String(name).trim() : undefined,
      forwardLocked: forwardLocked !== undefined ? !!forwardLocked : undefined,
      moderateProfanity: moderateProfanity !== undefined ? !!moderateProfanity : undefined,
      invitePolicy: invitePolicy !== undefined ? invite_policy : undefined,
      joinCodeChanged: joinCode !== undefined,
      passwordChanged: !!(password || clearPassword),
    });
    res.json({ ok: true });
  });

  r.get('/groups/:id/audit-log/facets', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId, 'admin');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const actorRows = db
      .prepare(
        `SELECT DISTINCT al.actor_user_id AS id FROM audit_log al
         WHERE al.target_kind = 'group' AND al.target_id = ?
         ORDER BY al.actor_user_id`
      )
      .all(gid);
    // Было N+1: один SELECT на актера. Один запрос с IN (?,?,…) одним вызовом.
    const actorIds = actorRows.map((ar) => ar.id).filter((x) => Number.isFinite(x));
    let actors = [];
    if (actorIds.length) {
      const placeholders = actorIds.map(() => '?').join(',');
      const users = db.prepare(`SELECT * FROM users WHERE id IN (${placeholders})`).all(...actorIds);
      const byId = new Map(users.map((u) => [u.id, rowUser(u)]));
      actors = actorIds.map((id) => byId.get(id)).filter(Boolean);
    }
    const actionRows = db
      .prepare(
        `SELECT DISTINCT action FROM audit_log WHERE target_kind = 'group' AND target_id = ? ORDER BY action COLLATE NOCASE`
      )
      .all(gid);
    res.json({
      actors,
      actions: actionRows.map((r) => r.action),
    });
  });

  r.get('/groups/:id/audit-log', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId, 'admin');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const limit = Math.min(500, Math.max(1, +req.query.limit || 200));
    const actorUserId = req.query.actorUserId != null && req.query.actorUserId !== '' ? +req.query.actorUserId : null;
    const actionEq =
      typeof req.query.action === 'string' && req.query.action.trim() ? req.query.action.trim() : null;
    const qRaw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const qLower = qRaw ? qRaw.toLowerCase() : '';

    const clauses = [`target_kind = 'group'`, `target_id = ?`];
    const params = [gid];

    if (actorUserId != null && Number.isFinite(actorUserId) && actorUserId > 0) {
      clauses.push(`actor_user_id = ?`);
      params.push(actorUserId);
    }
    if (actionEq) {
      clauses.push(`action = ?`);
      params.push(actionEq);
    }
    if (qLower) {
      clauses.push(
        `(INSTR(LOWER(COALESCE(action, '')), ?) > 0 OR INSTR(LOWER(COALESCE(meta_json, '')), ?) > 0)`
      );
      params.push(qLower, qLower);
    }

    const sql = `SELECT * FROM audit_log WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`;
    params.push(limit);
    const rows = db.prepare(sql).all(...params);
    res.json(
      rows.map((row) => ({
        id: row.id,
        createdAt: sqliteUtcToIso(row.created_at) ?? row.created_at,
        actor: rowUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.actor_user_id)),
        action: row.action,
        meta: row.meta_json ? JSON.parse(row.meta_json) : null,
      }))
    );
  });

  r.delete('/groups/:id/audit-log', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId, 'admin');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const info = db
      .prepare(`DELETE FROM audit_log WHERE target_kind = 'group' AND target_id = ?`)
      .run(gid);
    writeAudit(db, req.userId, 'audit_log_cleared', 'group', gid, { deletedCount: info.changes });
    res.json({ ok: true, deleted: info.changes });
  });

  r.get('/groups/:id/export/messages', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId, 'admin');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const format = String(req.query.format || 'json').toLowerCase();
    const cap = Math.min(50_000, Math.max(100, +req.query.limit || 20_000));
    const rows = db
      .prepare(`SELECT * FROM messages WHERE group_id = ? ORDER BY id ASC LIMIT ?`)
      .all(gid, cap);
    const messages = rows.map((row) => buildMessagePayload(row, req.userId));
    const ext = format === 'txt' ? 'txt' : 'json';
    res.setHeader('Content-Disposition', `attachment; filename="group-${gid}-messages.${ext}"`);
    if (format === 'txt') {
      res.type('text/plain; charset=utf-8');
      const lines = messages.map(
        (m) =>
          `[${m.createdAt}] ${m.sender.displayName} (@${m.sender.tag}): ${String(m.body || '').replace(/\r?\n/g, ' ')}`
      );
      res.send(lines.join('\n'));
    } else {
      res.type('application/json; charset=utf-8');
      res.json({ exportedAt: new Date().toISOString(), groupId: gid, messageCount: messages.length, messages });
    }
  });

  r.get('/groups/:id/export/audit-log', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId, 'admin');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(`SELECT * FROM audit_log WHERE target_kind = 'group' AND target_id = ? ORDER BY id ASC`)
      .all(gid);
    res.setHeader('Content-Disposition', `attachment; filename="group-${gid}-audit.json"`);
    res.type('application/json; charset=utf-8');
    res.json({
      exportedAt: new Date().toISOString(),
      groupId: gid,
      entryCount: rows.length,
      entries: rows.map((row) => ({
        id: row.id,
        createdAt: sqliteUtcToIso(row.created_at) ?? row.created_at,
        actorUserId: row.actor_user_id,
        action: row.action,
        meta: row.meta_json ? JSON.parse(row.meta_json) : null,
      })),
    });
  });

  r.get('/groups/:id/export/bundle', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId, 'admin');
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const g = db.prepare(`SELECT id, name, created_at FROM groups WHERE id = ?`).get(gid);
    const cap = Math.min(50_000, Math.max(100, +req.query.messageLimit || 20_000));
    const msgRows = db
      .prepare(`SELECT * FROM messages WHERE group_id = ? ORDER BY id ASC LIMIT ?`)
      .all(gid, cap);
    const messages = msgRows.map((row) => buildMessagePayload(row, req.userId));
    const auditRows = db
      .prepare(`SELECT * FROM audit_log WHERE target_kind = 'group' AND target_id = ? ORDER BY id ASC`)
      .all(gid);
    res.setHeader('Content-Disposition', `attachment; filename="group-${gid}-archive.json"`);
    res.type('application/json; charset=utf-8');
    res.json({
      exportedAt: new Date().toISOString(),
      group: g,
      messages,
      messageCount: messages.length,
      auditLog: auditRows.map((row) => ({
        id: row.id,
        createdAt: sqliteUtcToIso(row.created_at) ?? row.created_at,
        actorUserId: row.actor_user_id,
        action: row.action,
        meta: row.meta_json ? JSON.parse(row.meta_json) : null,
      })),
      auditEntryCount: auditRows.length,
    });
  });

  // --- Direct ---
  r.get('/direct', requireAuth, (req, res) => {
    const uid = req.userId;
    const rows = db
      .prepare(
        `SELECT d.* FROM direct_conversations d
         WHERE (d.user_low_id = ? OR d.user_high_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM user_chat_prefs p
           WHERE p.user_id = ? AND p.chat_kind = 'direct' AND p.chat_id = d.id AND p.hidden = 1
         )`
      )
      .all(uid, uid, uid);
    const out = rows.map((d) => {
      const peerId = d.user_low_id === uid ? d.user_high_id : d.user_low_id;
      const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(peerId);
      const lm = sidebarLastMessageDirect(d.id);
      return {
        id: d.id,
        peer: rowUser(u),
        createdAt: sqliteUtcToIso(d.created_at) ?? d.created_at,
        lastMessagePreview: lm.lastMessagePreview,
        lastMessageAt: lm.lastMessageAt,
      };
    });
    res.json(out);
  });

  r.post('/direct/open', requireAuth, (req, res) => {
    const { peerUserId } = req.body || {};
    if (!peerUserId || peerUserId === req.userId)
      return res.status(400).json({ error: 'Укажите собеседника' });
    if (!areFriends(req.userId, peerUserId))
      return res.status(403).json({ error: 'Личные чаты только между коллегами' });
    const id = ensureDirect(req.userId, peerUserId);
    db.prepare(
      `UPDATE user_chat_prefs SET hidden = 0 WHERE user_id = ? AND chat_kind = 'direct' AND chat_id = ?`
    ).run(req.userId, id);
    const peer = db.prepare(`SELECT * FROM users WHERE id = ?`).get(peerUserId);
    res.json({ id, peer: rowUser(peer) });
  });

  // --- Chat prefs (pin / favorite in sidebar) ---
  r.get('/chats/prefs', requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT * FROM user_chat_prefs WHERE user_id = ?`).all(req.userId);
    res.json(rows);
  });

  r.patch('/chats/prefs', requireAuth, (req, res) => {
    const { chatKind, chatId, pinned, favorite, muted, hidden, deleteMyMessages } = req.body || {};
    if (!['group', 'direct'].includes(chatKind) || chatId == null)
      return res.status(400).json({ error: 'chatKind, chatId' });
    const cid = +chatId;
    if (!Number.isFinite(cid) || cid <= 0)
      return res.status(400).json({ error: 'chatId' });
    // Нельзя писать prefs в чужие чаты: проверяем участие (группа/direct).
    if (chatKind === 'group') {
      const mem = db
        .prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?`)
        .get(cid, req.userId);
      if (!mem) return res.status(403).json({ error: 'Нет доступа к группе' });
    } else {
      const d = db.prepare(`SELECT user_low_id, user_high_id FROM direct_conversations WHERE id = ?`).get(cid);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа к чату' });
    }
    if (hidden != null && chatKind !== 'direct')
      return res.status(400).json({ error: 'Скрывать можно только личные чаты' });
    if (deleteMyMessages === true && (chatKind !== 'direct' || hidden !== true))
      return res.status(400).json({ error: 'deleteMyMessages только для скрытия личного чата' });
    if (deleteMyMessages === true) {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(cid);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа к чату' });
      db.prepare(`DELETE FROM messages WHERE direct_id = ? AND sender_id = ?`).run(cid, req.userId);
      const clearedPayload = {
        chatKind: 'direct',
        chatId: cid,
        scope: 'sender',
        clearedSenderId: req.userId,
      };
      emitToUser(d.user_low_id, 'chat:messages-cleared', clearedPayload);
      emitToUser(d.user_high_id, 'chat:messages-cleared', clearedPayload);
    }
    const existing = db
      .prepare(
        `SELECT * FROM user_chat_prefs WHERE user_id = ? AND chat_kind = ? AND chat_id = ?`
      )
      .get(req.userId, chatKind, cid);
    const pinVal = pinned != null ? (pinned ? 1 : 0) : (existing?.pinned_list ?? 0);
    const favVal = favorite != null ? (favorite ? 1 : 0) : (existing?.favorite ?? 0);
    const muteVal =
      muted != null ? (muted ? 1 : 0) : (existing?.mute_notifications ?? 0);
    const hidVal =
      hidden != null ? (hidden ? 1 : 0) : (existing?.hidden != null ? existing.hidden : 0);
    db.prepare(
      `INSERT INTO user_chat_prefs (user_id, chat_kind, chat_id, pinned_list, favorite, mute_notifications, hidden)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(user_id, chat_kind, chat_id) DO UPDATE SET
         pinned_list = excluded.pinned_list,
         favorite = excluded.favorite,
         mute_notifications = excluded.mute_notifications,
         hidden = excluded.hidden`
    ).run(req.userId, chatKind, cid, pinVal, favVal, muteVal, hidVal);
    res.json({ ok: true });
  });

  r.get('/chats/unread', requireAuth, (req, res) => {
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
      groups[id] = unreadCountForChat(uid, 'group', id);
    }
    const directRows = db
      .prepare(
        `SELECT d.id FROM direct_conversations d
         WHERE (d.user_low_id = ? OR d.user_high_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM user_chat_prefs p
           WHERE p.user_id = ? AND p.chat_kind = 'direct' AND p.chat_id = d.id AND p.hidden = 1
         )`
      )
      .all(uid, uid, uid);
    const directs = {};
    for (const { id } of directRows) {
      directs[id] = unreadCountForChat(uid, 'direct', id);
    }
    res.json({ groups, directs });
  });

  // --- Отметка прочитано, очистка истории ---

  r.post('/chats/read', requireAuth, (req, res) => {
    const { chatKind, chatId, upToMessageId } = req.body || {};
    if (!['group', 'direct'].includes(chatKind) || chatId == null || upToMessageId == null)
      return res.status(400).json({ error: 'Нужны chatKind, chatId, upToMessageId' });
    const mid = +upToMessageId;
    const cid = +chatId;
    if (chatKind === 'group') {
      const chk = requireGroupMember(cid, req.userId);
      if (!chk.ok) return res.status(403).json({ error: chk.error });
      const ok = db.prepare(`SELECT 1 FROM messages WHERE id = ? AND group_id = ?`).get(mid, cid);
      if (!ok) return res.status(400).json({ error: 'Сообщение не в этом чате' });
    } else {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(cid);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа' });
      const ok = db.prepare(`SELECT 1 FROM messages WHERE id = ? AND direct_id = ?`).get(mid, cid);
      if (!ok) return res.status(400).json({ error: 'Сообщение не в этом чате' });
    }
    const ex = db
      .prepare(
        `SELECT pinned_list, favorite, mute_notifications, hidden, last_read_message_id, last_read_at FROM user_chat_prefs WHERE user_id = ? AND chat_kind = ? AND chat_id = ?`
      )
      .get(req.userId, chatKind, cid);
    const pinVal = ex?.pinned_list ?? 0;
    const favVal = ex?.favorite ?? 0;
    const muteVal = ex?.mute_notifications ?? 0;
    const hidVal = ex?.hidden != null ? ex.hidden : 0;
    const prevRead = ex?.last_read_message_id ?? 0;
    const readAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_chat_prefs (user_id, chat_kind, chat_id, pinned_list, favorite, last_read_message_id, mute_notifications, last_read_at, hidden)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, chat_kind, chat_id) DO UPDATE SET
         last_read_message_id = MAX(COALESCE(user_chat_prefs.last_read_message_id, 0), excluded.last_read_message_id),
         last_read_at = CASE
           WHEN excluded.last_read_message_id > COALESCE(user_chat_prefs.last_read_message_id, 0) THEN excluded.last_read_at
           ELSE user_chat_prefs.last_read_at
         END`
    ).run(req.userId, chatKind, cid, pinVal, favVal, mid, muteVal, readAt, hidVal);
    if (mid > prevRead) {
      if (chatKind === 'group') {
        db.prepare(
          `INSERT OR IGNORE INTO message_read_receipts (message_id, user_id, read_at)
           SELECT m.id, ?, ? FROM messages m
           WHERE m.group_id = ? AND m.id > ? AND m.id <= ?`
        ).run(req.userId, readAt, cid, prevRead, mid);
      } else {
        db.prepare(
          `INSERT OR IGNORE INTO message_read_receipts (message_id, user_id, read_at)
           SELECT m.id, ?, ? FROM messages m
           WHERE m.direct_id = ? AND m.id > ? AND m.id <= ?`
        ).run(req.userId, readAt, cid, prevRead, mid);
      }
    }
    const row = db
      .prepare(
        `SELECT last_read_message_id, last_read_at FROM user_chat_prefs WHERE user_id = ? AND chat_kind = ? AND chat_id = ?`
      )
      .get(req.userId, chatKind, cid);
    const readPayload = {
      chatKind,
      chatId: cid,
      userId: req.userId,
      lastReadMessageId: row?.last_read_message_id ?? mid,
      lastReadAt: row?.last_read_at ?? readAt,
    };
    if (chatKind === 'group') io.to(`group:${cid}`).emit('chat:read', readPayload);
    else io.to(`direct:${cid}`).emit('chat:read', readPayload);
    res.json({ ok: true });
  });

  r.post('/chats/clear-messages', requireAuth, (req, res) => {
    const { chatKind, chatId: cidRaw } = req.body || {};
    const cid = cidRaw != null ? +cidRaw : NaN;
    if (!['group', 'direct'].includes(chatKind) || !Number.isFinite(cid))
      return res.status(400).json({ error: 'Нужны chatKind и chatId' });
    if (chatKind === 'group') {
      const asMod = requireGroupMember(cid, req.userId, 'moderator');
      if (asMod.ok) {
        const snRows = db
          .prepare(
            `SELECT DISTINCT a.stored_name AS s FROM message_attachments a
             JOIN messages m ON m.id = a.message_id WHERE m.group_id = ?`
          )
          .all(cid);
        db.prepare(`DELETE FROM messages WHERE group_id = ?`).run(cid);
        unlinkOrphanMessageAttachmentFiles(
          db,
          snRows.map((r) => r.s)
        );
        io.to(`group:${cid}`).emit('chat:messages-cleared', {
          chatKind: 'group',
          chatId: cid,
          scope: 'all',
        });
        writeAudit(db, req.userId, 'chat_clear_all', 'group', cid, {});
        return res.json({ ok: true, scope: 'all' });
      }
      const asMember = requireGroupMember(cid, req.userId, 'member');
      if (!asMember.ok) return res.status(403).json({ error: asMember.error });
      const snOwn = db
        .prepare(
          `SELECT DISTINCT a.stored_name AS s FROM message_attachments a
           JOIN messages m ON m.id = a.message_id WHERE m.group_id = ? AND m.sender_id = ?`
        )
        .all(cid, req.userId);
      db.prepare(`DELETE FROM messages WHERE group_id = ? AND sender_id = ?`).run(cid, req.userId);
      unlinkOrphanMessageAttachmentFiles(
        db,
        snOwn.map((r) => r.s)
      );
      io.to(`group:${cid}`).emit('chat:messages-cleared', {
        chatKind: 'group',
        chatId: cid,
        scope: 'sender',
        clearedSenderId: req.userId,
      });
      writeAudit(db, req.userId, 'chat_clear_own', 'group', cid, {});
      return res.json({ ok: true, scope: 'sender', clearedSenderId: req.userId });
    }
    const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(cid);
    if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
      return res.status(403).json({ error: 'Нет доступа к чату' });
    const snDir = db
      .prepare(
        `SELECT DISTINCT a.stored_name AS s FROM message_attachments a
         JOIN messages m ON m.id = a.message_id WHERE m.direct_id = ? AND m.sender_id = ?`
      )
      .all(cid, req.userId);
    db.prepare(`DELETE FROM messages WHERE direct_id = ? AND sender_id = ?`).run(cid, req.userId);
    unlinkOrphanMessageAttachmentFiles(
      db,
      snDir.map((r) => r.s)
    );
    const clearedPayload = {
      chatKind: 'direct',
      chatId: cid,
      scope: 'sender',
      clearedSenderId: req.userId,
    };
    emitToUser(d.user_low_id, 'chat:messages-cleared', clearedPayload);
    emitToUser(d.user_high_id, 'chat:messages-cleared', clearedPayload);
    writeAudit(db, req.userId, 'chat_clear_own', 'direct', cid, {});
    return res.json({ ok: true, scope: 'sender', clearedSenderId: req.userId });
  });

  // --- Прочитанность собеседников, индекс вложений и ссылок в чате ---

  r.get('/direct/:directId/read-status', requireAuth, (req, res) => {
    const did = +req.params.directId;
    const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(did);
    if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
      return res.status(403).json({ error: 'Нет доступа' });
    const peerId = d.user_low_id === req.userId ? d.user_high_id : d.user_low_id;
    const peerPref = db
      .prepare(
        `SELECT last_read_message_id, last_read_at FROM user_chat_prefs WHERE user_id = ? AND chat_kind = 'direct' AND chat_id = ?`
      )
      .get(peerId, did);
    res.json({
      peerLastReadMessageId: peerPref?.last_read_message_id ?? null,
      peerLastReadAt: peerPref?.last_read_at ?? null,
    });
  });

  r.get('/groups/:groupId/read-status', requireAuth, (req, res) => {
    const gid = +req.params.groupId;
    const chk = requireGroupMember(gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const mems = db
      .prepare(
        `SELECT user_id FROM group_members gm
         WHERE gm.group_id = ?
         AND (gm.banned_until IS NULL OR datetime(gm.banned_until) <= datetime('now'))`
      )
      .all(gid);
    const out = {};
    for (const { user_id: uid } of mems) {
      if (uid === req.userId) continue;
      const p = db
        .prepare(
          `SELECT last_read_message_id, last_read_at FROM user_chat_prefs WHERE user_id = ? AND chat_kind = 'group' AND chat_id = ?`
        )
        .get(uid, gid);
      out[uid] = {
        lastReadMessageId: p?.last_read_message_id ?? null,
        lastReadAt: p?.last_read_at ?? null,
      };
    }
    res.json(out);
  });

  r.get('/groups/:groupId/chat-attachments', requireAuth, (req, res) => {
    const gid = +req.params.groupId;
    const chk = requireGroupMember(gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const attRows = db
      .prepare(
        `SELECT a.id, a.message_id AS messageId, a.file_name AS fileName, a.mime_type AS mimeType,
                a.kind, m.created_at AS createdAt, a.stored_name AS storedName, m.sender_id AS senderId
         FROM message_attachments a
         JOIN messages m ON m.id = a.message_id
         WHERE m.group_id = ?
         ORDER BY m.created_at DESC, a.id DESC`
      )
      .all(gid);
    const attachments = attRows.map((a) => ({
      id: a.id,
      messageId: a.messageId,
      senderId: a.senderId,
      createdAt: sqliteUtcToIso(a.createdAt) ?? a.createdAt,
      fileName: normalizePossibleMultipartFilename(a.fileName) || a.fileName,
      mimeType: a.mimeType,
      kind: a.kind,
      url: `/uploads/${a.storedName}`,
    }));
    const msgRows = db
      .prepare(
        `SELECT id, body, created_at AS createdAt FROM messages
         WHERE group_id = ? AND body LIKE '%http%'
         ORDER BY created_at DESC
         LIMIT 800`
      )
      .all(gid);
    const links = [];
    const seen = new Set();
    for (const row of msgRows) {
      for (const url of extractUrlsFromText(row.body)) {
        const key = `${row.id}:${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          url,
          messageId: row.id,
          messageCreatedAt: sqliteUtcToIso(row.createdAt) ?? row.createdAt,
          snippet: String(row.body || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        });
      }
    }
    res.json({ attachments, links });
  });

  r.get('/direct/:directId/chat-attachments', requireAuth, (req, res) => {
    const did = +req.params.directId;
    const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(did);
    if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
      return res.status(403).json({ error: 'Нет доступа' });
    const attRows = db
      .prepare(
        `SELECT a.id, a.message_id AS messageId, a.file_name AS fileName, a.mime_type AS mimeType,
                a.kind, m.created_at AS createdAt, a.stored_name AS storedName, m.sender_id AS senderId
         FROM message_attachments a
         JOIN messages m ON m.id = a.message_id
         WHERE m.direct_id = ?
         ORDER BY m.created_at DESC, a.id DESC`
      )
      .all(did);
    const attachments = attRows.map((a) => ({
      id: a.id,
      messageId: a.messageId,
      senderId: a.senderId,
      createdAt: sqliteUtcToIso(a.createdAt) ?? a.createdAt,
      fileName: normalizePossibleMultipartFilename(a.fileName) || a.fileName,
      mimeType: a.mimeType,
      kind: a.kind,
      url: `/uploads/${a.storedName}`,
    }));
    const msgRows = db
      .prepare(
        `SELECT id, body, created_at AS createdAt FROM messages
         WHERE direct_id = ? AND body LIKE '%http%'
         ORDER BY created_at DESC
         LIMIT 800`
      )
      .all(did);
    const links = [];
    const seen = new Set();
    for (const row of msgRows) {
      for (const url of extractUrlsFromText(row.body)) {
        const key = `${row.id}:${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          url,
          messageId: row.id,
          messageCreatedAt: sqliteUtcToIso(row.createdAt) ?? row.createdAt,
          snippet: String(row.body || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        });
      }
    }
    res.json({ attachments, links });
  });

  function canAccessMessage(msg, userId) {
    if (!msg) return false;
    if (msg.group_id != null) {
      return requireGroupMember(msg.group_id, userId).ok;
    }
    if (msg.direct_id != null) {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
      return !!(d && (d.user_low_id === userId || d.user_high_id === userId));
    }
    return false;
  }

  function buildReactionsPayload(messageId) {
    const rows = db
      .prepare(
        `SELECT emoji, user_id FROM message_reactions WHERE message_id = ? ORDER BY created_at ASC`
      )
      .all(messageId);
    const byEmoji = new Map();
    for (const r of rows) {
      if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
      byEmoji.get(r.emoji).push(r.user_id);
    }
    return [...byEmoji.entries()].map(([emoji, userIds]) => ({
      emoji,
      users: userIds
        .map((uid) => rowUser(db.prepare(`SELECT * FROM users WHERE id = ?`).get(uid)))
        .filter(Boolean),
    }));
  }

  function buildReplyToPayload(replyToId, viewerUserId) {
    if (replyToId == null) return null;
    const parent = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(replyToId);
    if (!parent) return null;
    const su = db.prepare(`SELECT * FROM users WHERE id = ?`).get(parent.sender_id);
    const attC = db
      .prepare(`SELECT COUNT(*) as c FROM message_attachments WHERE message_id = ?`)
      .get(replyToId).c;
    let bodyText = String(parent.body || '');
    if (shouldMaskGroupTextForViewer(db, parent.group_id, viewerUserId, parent.sender_id)) {
      bodyText = maskProfanity(bodyText);
    }
    let preview = bodyText
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    if (!preview) {
      if (attC > 1) preview = `${attC} вложения`;
      else if (attC === 1) preview = 'Вложение';
      else preview = '(пусто)';
    }
    return {
      id: parent.id,
      sender: rowUser(su),
      bodyPreview: preview,
      hasAttachments: attC > 0,
    };
  }

  function forwardEntryForStorageFromRow(srcRow) {
    const su = db.prepare(`SELECT * FROM users WHERE id = ?`).get(srcRow.sender_id);
    const attC = db
      .prepare(`SELECT COUNT(*) as c FROM message_attachments WHERE message_id = ?`)
      .get(srcRow.id).c;
    let preview = String(srcRow.body || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 160);
    if (!preview) {
      if (attC > 1) preview = `${attC} вложения`;
      else if (attC === 1) preview = 'Вложение';
      else preview = '(пусто)';
    }
    return {
      sender: rowUser(su),
      bodyPreview: preview,
      hasAttachments: attC > 0,
    };
  }

  function buildForwardFromForPayload(msgRow, viewerUserId) {
    if (!msgRow.forward_preview_json) return null;
    let arr;
    try {
      arr = JSON.parse(msgRow.forward_preview_json);
    } catch {
      return null;
    }
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.map((e) => ({
      sender: e.sender,
      bodyPreview:
        shouldMaskGroupTextForViewer(db, msgRow.group_id, viewerUserId, e.sender?.id ?? null) &&
        e.bodyPreview != null
          ? maskProfanity(String(e.bodyPreview))
          : String(e.bodyPreview ?? ''),
      hasAttachments: !!e.hasAttachments,
    }));
  }

  function validateReplyTarget(replyToId, groupId, directId, userId) {
    if (replyToId == null || replyToId === '' || String(replyToId).trim() === '')
      return { ok: true };
    const rid = +replyToId;
    if (!Number.isFinite(rid) || rid <= 0) return { ok: false, error: 'Некорректный ответ' };
    const parent = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(rid);
    if (!parent) return { ok: false, error: 'Сообщение для ответа не найдено' };
    if (groupId != null) {
      if (parent.group_id !== groupId) return { ok: false, error: 'Ответ только внутри чата' };
      const chk = requireGroupMember(groupId, userId);
      if (!chk.ok) return { ok: false, error: chk.error };
    } else if (directId != null) {
      if (parent.direct_id !== directId) return { ok: false, error: 'Ответ только внутри чата' };
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(directId);
      if (!d || (d.user_low_id !== userId && d.user_high_id !== userId))
        return { ok: false, error: 'Нет доступа' };
    }
    return { ok: true, id: rid };
  }

  function outboundReadReceipt(msg, viewerUserId) {
    if (viewerUserId == null || msg.sender_id !== viewerUserId) return undefined;
    if (msg.direct_id) {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
      if (!d) return undefined;
      const peerId = d.user_low_id === viewerUserId ? d.user_high_id : d.user_low_id;
      const cur = effectiveReadCursor(peerId, 'direct', msg.direct_id);
      const read = cur >= msg.id;
      const row = db
        .prepare(`SELECT read_at FROM message_read_receipts WHERE message_id = ? AND user_id = ?`)
        .get(msg.id, peerId);
      return { read, readAt: read ? row?.read_at ?? null : null };
    }
    if (msg.group_id) {
      const others = db
        .prepare(
          `SELECT user_id FROM group_members gm
           WHERE gm.group_id = ? AND gm.user_id != ?
           AND (gm.banned_until IS NULL OR datetime(gm.banned_until) <= datetime('now'))`
        )
        .all(msg.group_id, viewerUserId);
      if (others.length === 0) return { read: true, readAt: null };
      let read = true;
      let latestAt = null;
      for (const { user_id: uid } of others) {
        const cur = effectiveReadCursor(uid, 'group', msg.group_id);
        if (cur < msg.id) {
          read = false;
          break;
        }
        const row = db
          .prepare(`SELECT read_at FROM message_read_receipts WHERE message_id = ? AND user_id = ?`)
          .get(msg.id, uid);
        if (row?.read_at && (!latestAt || row.read_at > latestAt)) latestAt = row.read_at;
      }
      return { read, readAt: read ? latestAt : null };
    }
    return undefined;
  }

  /** Служебные строки входа/выхода в группе (не обычные сообщения в UI). */
  function groupMemberChatEventKind(rawBody) {
    const b = String(rawBody || '');
    if (b.startsWith('Пользователь ') && b.endsWith(' покинул чат')) return 'member_leave';
    if (b.startsWith('Пользователь ') && b.endsWith(' присоединился к чату')) return 'member_join';
    return null;
  }

  function buildWorkspaceLinksPayload(messageId) {
    const rows = db
      .prepare(
        `SELECT l.id, l.link_kind, l.entity_id,
          COALESCE(NULLIF(TRIM(t.title), ''), NULLIF(TRIM(d.name), ''), '') AS title
         FROM message_workspace_links l
         LEFT JOIN tasks t ON l.link_kind = 'task' AND l.entity_id = t.id
         LEFT JOIN collab_documents d ON l.link_kind = 'collab_document' AND l.entity_id = d.id
         WHERE l.message_id = ?`
      )
      .all(messageId);
    return rows.map((r) => ({
      id: r.id,
      kind: r.link_kind,
      entityId: r.entity_id,
      title:
        String(r.title || '').trim() ||
        (r.link_kind === 'task' ? 'Задача' : 'Документ'),
    }));
  }

  function buildMessagePayload(msg, viewerUserId) {
    const sender = db.prepare(`SELECT * FROM users WHERE id = ?`).get(msg.sender_id);
    const atts = db
      .prepare(`SELECT * FROM message_attachments WHERE message_id = ?`)
      .all(msg.id);
    const mentions = db
      .prepare(`SELECT user_id FROM message_mentions WHERE message_id = ?`)
      .all(msg.id)
      .map((x) => x.user_id);
    const importantForMe =
      viewerUserId != null &&
      !!db
        .prepare(`SELECT 1 FROM user_message_important WHERE user_id = ? AND message_id = ?`)
        .get(viewerUserId, msg.id);
    const modBody = shouldMaskGroupTextForViewer(db, msg.group_id, viewerUserId, msg.sender_id);
    let bodyOut = msg.body;
    if (modBody) bodyOut = maskProfanity(String(msg.body || ''));
    const chatEvent = msg.group_id ? groupMemberChatEventKind(msg.body) : null;
    return {
      id: msg.id,
      groupId: msg.group_id,
      directId: msg.direct_id,
      sender: rowUser(sender),
      body: bodyOut,
      ...(chatEvent ? { chatEvent } : {}),
      pinnedAt: sqliteUtcToIso(msg.pinned_at) ?? msg.pinned_at,
      createdAt: sqliteUtcToIso(msg.created_at) ?? msg.created_at,
      editedAt: msg.edited_at ? sqliteUtcToIso(msg.edited_at) ?? msg.edited_at : null,
      replyTo: buildReplyToPayload(msg.reply_to_id, viewerUserId),
      forwardFrom: buildForwardFromForPayload(msg, viewerUserId),
      reactions: buildReactionsPayload(msg.id),
      importantForMe,
      attachmentIds: atts.map((a) => a.id),
      attachments: atts.map((a) => ({
        id: a.id,
        url: `/uploads/${a.stored_name}`,
        fileName: normalizePossibleMultipartFilename(a.file_name) || a.file_name,
        mimeType: a.mime_type,
        kind: a.kind,
        transcript:
          a.transcript && modBody ? maskProfanity(String(a.transcript)) : a.transcript || null,
      })),
      mentionUserIds: mentions,
      outboundRead: outboundReadReceipt(msg, viewerUserId),
      threadRootId: msg.thread_root_id ?? null,
      workspaceLinks: buildWorkspaceLinksPayload(msg.id),
    };
  }

  /** Личные сообщения — в комнаты user:*, иначе получатель не подписан на direct:* до появления чата в списке. */
  function emitDirectMessageNewToParticipants(dRow, msgRow) {
    emitToUser(dRow.user_low_id, 'message:new', buildMessagePayload(msgRow, dRow.user_low_id));
    emitToUser(dRow.user_high_id, 'message:new', buildMessagePayload(msgRow, dRow.user_high_id));
  }

  function emitGroupMessageEvent(event, groupId, msg) {
    const gRow = db.prepare(`SELECT moderate_profanity FROM groups WHERE id = ?`).get(groupId);
    if (!gRow?.moderate_profanity) {
      io.to(`group:${groupId}`).emit(event, buildMessagePayload(msg));
      return;
    }
    void io.in(`group:${groupId}`).fetchSockets().then((socks) => {
      for (const s of socks) {
        const uid = s.userId;
        s.emit(event, buildMessagePayload(msg, uid != null ? uid : undefined));
      }
    });
  }

  function emitGroupMemberJoinedChatAndSocket(gid, userId) {
    const joiner = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(userId);
    const dn = String(joiner?.display_name || 'Пользователь').trim().slice(0, 200) || 'Пользователь';
    const joinBody = `Пользователь ${dn} присоединился к чату`;
    const ins = db
      .prepare(`INSERT INTO messages (group_id, sender_id, body, reply_to_id) VALUES (?,?,?,?)`)
      .run(gid, userId, joinBody, null);
    const joinMsg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(ins.lastInsertRowid);
    emitGroupMessageEvent('message:new', gid, joinMsg);
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.tag, u.avatar_file, gm.role, gm.banned_until
         FROM group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = ? AND gm.user_id = ?`
      )
      .get(gid, userId);
    if (!row) return;
    io.to(`group:${gid}`).emit('group:memberJoined', {
      groupId: gid,
      member: {
        ...rowUser(row),
        role: row.role,
        banned: !!(row.banned_until && new Date(row.banned_until) > new Date()),
      },
    });
  }

  // --- Поиск по сообщениям, тред, контекст вокруг id, связи с задачами/документами ---

  r.get('/search/messages', requireAuth, searchUserLimit, (req, res) => {
    const rawQ = String(req.query.q || '').trim();
    if (rawQ.length < 2) return res.status(400).json({ error: 'Введите не менее 2 символов' });
    const limit = Math.min(50, Math.max(1, +req.query.limit || 25));
    const esc = rawQ.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const like = `%${esc}%`;
    const uid = req.userId;
    const rows = db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.body LIKE ? ESCAPE '\\'
         AND (
           (m.group_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM group_members gm
             WHERE gm.group_id = m.group_id AND gm.user_id = ?
             AND (gm.banned_until IS NULL OR datetime(gm.banned_until) <= datetime('now'))
           ))
           OR (m.direct_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM direct_conversations d
             WHERE d.id = m.direct_id AND (d.user_low_id = ? OR d.user_high_id = ?)
           ))
         )
         ORDER BY m.id DESC
         LIMIT ?`
      )
      .all(like, uid, uid, uid, limit);

    const results = [];
    for (const row of rows) {
      const payload = buildMessagePayload(row, uid);
      const chatKind = row.group_id != null ? 'group' : 'direct';
      const chatId = row.group_id ?? row.direct_id;
      let chatLabel = '';
      if (row.group_id != null) {
        const g = db.prepare(`SELECT name FROM groups WHERE id = ?`).get(row.group_id);
        chatLabel = g?.name || 'Группа';
      } else {
        const d = db
          .prepare(`SELECT user_low_id, user_high_id FROM direct_conversations WHERE id = ?`)
          .get(row.direct_id);
        const peerId = d ? (d.user_low_id === uid ? d.user_high_id : d.user_low_id) : null;
        const peer = peerId ? db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(peerId) : null;
        chatLabel = peer?.display_name || 'Личный чат';
      }
      results.push({ message: payload, chatKind, chatId, chatLabel });
    }
    res.json({ results });
  });

  r.get('/messages/:id/thread', requireAuth, (req, res) => {
    const mid = +req.params.id;
    if (!Number.isFinite(mid) || mid <= 0) return res.status(400).json({ error: 'Некорректный id' });
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.group_id != null) {
      const chk = requireGroupMember(msg.group_id, req.userId);
      if (!chk.ok) return res.status(403).json({ error: chk.error });
    } else if (msg.direct_id != null) {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа' });
    } else return res.status(400).json({ error: '?' });
    const rootId = msg.thread_root_id || msg.id;
    const rows = db
      .prepare(`SELECT * FROM messages WHERE id = ? OR thread_root_id = ? ORDER BY id ASC`)
      .all(rootId, rootId);
    res.json({
      rootId,
      messages: rows.map((row) => buildMessagePayload(row, req.userId)),
    });
  });

  r.get('/messages/:id/context', requireAuth, (req, res) => {
    const mid = +req.params.id;
    if (!Number.isFinite(mid) || mid <= 0) return res.status(400).json({ error: 'Некорректный id' });
    const beforeN = Math.min(80, Math.max(5, +req.query.before || 45));
    const afterN = Math.min(80, Math.max(5, +req.query.after || 45));
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.group_id != null) {
      const chk = requireGroupMember(msg.group_id, req.userId);
      if (!chk.ok) return res.status(403).json({ error: chk.error });
    } else if (msg.direct_id != null) {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа' });
    } else return res.status(400).json({ error: '?' });
    let older = [];
    let newer = [];
    if (msg.group_id != null) {
      older = db
        .prepare(`SELECT * FROM messages WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
        .all(msg.group_id, mid, beforeN);
      older.reverse();
      newer = db
        .prepare(`SELECT * FROM messages WHERE group_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
        .all(msg.group_id, mid, afterN);
    } else {
      older = db
        .prepare(`SELECT * FROM messages WHERE direct_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
        .all(msg.direct_id, mid, beforeN);
      older.reverse();
      newer = db
        .prepare(`SELECT * FROM messages WHERE direct_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
        .all(msg.direct_id, mid, afterN);
    }
    const merged = [...older, msg, ...newer];
    res.json({
      focusMessageId: mid,
      messages: merged.map((row) => buildMessagePayload(row, req.userId)),
    });
  });

  r.post('/messages/:mid/workspace-links', requireAuth, (req, res) => {
    const mid = +req.params.mid;
    const kind = String(req.body?.kind || '');
    const entityId = +req.body?.entityId;
    if (!Number.isFinite(mid) || mid <= 0) return res.status(400).json({ error: 'Сообщение' });
    if (kind !== 'task' && kind !== 'collab_document')
      return res.status(400).json({ error: 'kind: task или collab_document' });
    if (!Number.isFinite(entityId) || entityId <= 0) return res.status(400).json({ error: 'entityId' });
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!msg || !canAccessMessage(msg, req.userId)) return res.status(403).json({ error: 'Нет доступа' });
    const gid = msg.group_id;
    if (gid == null) return res.status(400).json({ error: 'Только в групповом чате' });
    const chk = requireGroupMember(gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    if (kind === 'task') {
      const t = db
        .prepare(`SELECT t.id, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`)
        .get(entityId);
      if (!t) return res.status(404).json({ error: 'Задача не найдена' });
      if (t.group_id !== gid) return res.status(403).json({ error: 'Задача из другой группы' });
    } else {
      const doc = db.prepare(`SELECT id, group_id FROM collab_documents WHERE id = ?`).get(entityId);
      if (!doc) return res.status(404).json({ error: 'Документ не найден' });
      if (doc.group_id !== gid) return res.status(403).json({ error: 'Документ из другой группы' });
    }
    try {
      db.prepare(
        `INSERT INTO message_workspace_links (message_id, link_kind, entity_id, created_by) VALUES (?,?,?,?)`
      ).run(mid, kind, entityId, req.userId);
    } catch (e) {
      if (isSqliteUniqueViolation(e)) return res.status(409).json({ error: 'Связь уже есть' });
      throw e;
    }
    const links = buildWorkspaceLinksPayload(mid);
    const payload = { messageId: mid, groupId: msg.group_id, directId: msg.direct_id, workspaceLinks: links };
    if (msg.group_id) io.to(`group:${msg.group_id}`).emit('message:workspaceLinks', payload);
    res.json({ ok: true, workspaceLinks: links });
  });

  r.delete('/messages/:mid/workspace-links/:linkId', requireAuth, (req, res) => {
    const mid = +req.params.mid;
    const lid = +req.params.linkId;
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!msg || !canAccessMessage(msg, req.userId)) return res.status(403).json({ error: 'Нет доступа' });
    const link = db.prepare(`SELECT * FROM message_workspace_links WHERE id = ? AND message_id = ?`).get(lid, mid);
    if (!link) return res.status(404).json({ error: 'Не найдено' });
    const mem = msg.group_id ? getMembership(msg.group_id, req.userId) : null;
    const isMod = mem && (mem.role === 'admin' || mem.role === 'moderator');
    if (link.created_by !== req.userId && msg.sender_id !== req.userId && !isMod)
      return res.status(403).json({ error: 'Нельзя удалить чужую связь' });
    db.prepare(`DELETE FROM message_workspace_links WHERE id = ?`).run(lid);
    const links = buildWorkspaceLinksPayload(mid);
    const payload = { messageId: mid, groupId: msg.group_id, directId: msg.direct_id, workspaceLinks: links };
    if (msg.group_id) io.to(`group:${msg.group_id}`).emit('message:workspaceLinks', payload);
    else if (msg.direct_id) io.to(`direct:${msg.direct_id}`).emit('message:workspaceLinks', payload);
    res.json({ ok: true, workspaceLinks: links });
  });

  // --- Лента сообщений: список, отправка с файлами, реакции, пины, пересылка, редактирование ---

  const msgUpload = upload.fields([{ name: 'files', maxCount: 12 }]);

  r.get('/groups/:id/messages', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const limit = Math.min(100, Math.max(1, +req.query.limit || 50));
    const before = req.query.before ? +req.query.before : null;
    let rows;
    if (before)
      rows = db
        .prepare(
          `SELECT * FROM messages WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
        )
        .all(gid, before, limit);
    else
      rows = db
        .prepare(`SELECT * FROM messages WHERE group_id = ? ORDER BY id DESC LIMIT ?`)
        .all(gid, limit);
    res.json(rows.reverse().map((row) => buildMessagePayload(row, req.userId)));
  });

  r.get('/direct/:directId/messages', requireAuth, (req, res) => {
    const did = +req.params.directId;
    const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(did);
    if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
      return res.status(403).json({ error: 'Нет доступа' });
    const limit = Math.min(100, Math.max(1, +req.query.limit || 50));
    const before = req.query.before ? +req.query.before : null;
    let rows;
    if (before)
      rows = db
        .prepare(
          `SELECT * FROM messages WHERE direct_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
        )
        .all(did, before, limit);
    else
      rows = db
        .prepare(`SELECT * FROM messages WHERE direct_id = ? ORDER BY id DESC LIMIT ?`)
        .all(did, limit);
    res.json(rows.reverse().map((row) => buildMessagePayload(row, req.userId)));
  });

  /** Реакции — регистрируем рядом с сообщениями (до остальных /messages/:id/*). */
  r.post('/messages/:id/reaction', requireAuth, (req, res) => {
    const mid = +req.params.id;
    const emoji = String(req.body?.emoji ?? '').trim();
    if (!emoji || [...emoji].length > 16)
      return res.status(400).json({ error: 'Укажите эмодзи' });
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!msg || !canAccessMessage(msg, req.userId))
      return res.status(403).json({ error: 'Нет доступа' });
    const cur = db
      .prepare(`SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?`)
      .get(mid, req.userId);
    if (cur?.emoji === emoji) {
      db.prepare(`DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?`).run(mid, req.userId);
    } else {
      db.prepare(
        `INSERT OR REPLACE INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,datetime('now'))`
      ).run(mid, req.userId, emoji);
    }
    const reactions = buildReactionsPayload(mid);
    const payload = { messageId: mid, groupId: msg.group_id, directId: msg.direct_id, reactions };
    if (msg.group_id) io.to(`group:${msg.group_id}`).emit('message:reactions', payload);
    else io.to(`direct:${msg.direct_id}`).emit('message:reactions', payload);
    res.json(payload);
  });

  r.post('/groups/:id/messages', requireAuth, msgUpload, msgUserLimit, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    if (isBannedMember(gid, req.userId)) return res.status(403).json({ error: 'Вы забанены' });
    const body = String(req.body?.body || '');
    const files = req.files?.files || [];
    const bodyTrimmed = body.trim();
    const composeWorkspaceLinks = parseWorkspaceLinksFromComposeBody(req.body);
    if (!bodyTrimmed && files.length === 0 && composeWorkspaceLinks.length === 0) {
      return res.status(400).json({ error: 'Пустое сообщение' });
    }
    const rawReply = req.body?.replyToId ?? req.body?.reply_to_id;
    const vreply = validateReplyTarget(rawReply, gid, null, req.userId);
    if (!vreply.ok) return res.status(400).json({ error: vreply.error });
    const replyToIdFinal = vreply.id != null ? vreply.id : null;
    let threadRootId = null;
    if (replyToIdFinal != null) {
      const parent = db.prepare(`SELECT thread_root_id FROM messages WHERE id = ?`).get(replyToIdFinal);
      if (parent) threadRootId = parent.thread_root_id || replyToIdFinal;
    }
    const info = db
      .prepare(
        `INSERT INTO messages (group_id, sender_id, body, reply_to_id, thread_root_id) VALUES (?,?,?,?,?)`
      )
      .run(gid, req.userId, bodyTrimmed, replyToIdFinal, threadRootId);
    const mid = info.lastInsertRowid;
    for (const f of files) {
      const kind = detectKind(f.mimetype);
      const displayName =
        normalizePossibleMultipartFilename(f.originalname) || f.originalname || f.filename;
      db.prepare(
        `INSERT INTO message_attachments (message_id, file_name, stored_name, mime_type, kind) VALUES (?,?,?,?,?)`
      ).run(mid, displayName, f.filename, f.mimetype || 'application/octet-stream', kind);
    }
    const tags = parseMentionTags(bodyTrimmed);
    for (const t of tags) {
      const u = db.prepare(`SELECT id FROM users WHERE tag = ? COLLATE NOCASE`).get(t);
      if (u) {
        const inGroup = getMembership(gid, u.id);
        if (inGroup && !isBannedMember(gid, u.id)) {
          db.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`).run(
            mid,
            u.id
          );
        }
      }
    }
    for (const uid of parseExtraMentionUserIdsFromBody(req.body)) {
      const inGroup = getMembership(gid, uid);
      if (inGroup && !isBannedMember(gid, uid)) {
        db.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`).run(
          mid,
          uid
        );
      }
    }
    for (const link of composeWorkspaceLinks) {
      tryInsertMessageWorkspaceLink(db, mid, gid, req.userId, link.kind, link.entityId);
    }
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    emitGroupMessageEvent('message:new', gid, msg);
    const mentionUserIds = buildMessagePayload(msg).mentionUserIds;
    for (const uid of mentionUserIds) {
      if (uid === req.userId) continue;
      emitToUser(uid, 'mention:notify', { ...buildMessagePayload(msg, uid), groupId: gid });
    }
    res.json(buildMessagePayload(msg, req.userId));
  });

  r.post('/direct/:directId/messages', requireAuth, msgUpload, msgUserLimit, (req, res) => {
    const did = +req.params.directId;
    const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(did);
    if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
      return res.status(403).json({ error: 'Нет доступа' });
    const peer = d.user_low_id === req.userId ? d.user_high_id : d.user_low_id;
    if (!areFriends(req.userId, peer)) return res.status(403).json({ error: 'Не в коллегах' });
    const body = String(req.body?.body || '');
    const files = req.files?.files || [];
    const bodyTrimmed = body.trim();
    if (!bodyTrimmed && files.length === 0) {
      return res.status(400).json({ error: 'Пустое сообщение' });
    }
    const rawReply = req.body?.replyToId ?? req.body?.reply_to_id;
    const vreply = validateReplyTarget(rawReply, null, did, req.userId);
    if (!vreply.ok) return res.status(400).json({ error: vreply.error });
    const replyToIdFinal = vreply.id != null ? vreply.id : null;
    let threadRootIdDm = null;
    if (replyToIdFinal != null) {
      const parent = db.prepare(`SELECT thread_root_id FROM messages WHERE id = ?`).get(replyToIdFinal);
      if (parent) threadRootIdDm = parent.thread_root_id || replyToIdFinal;
    }
    const info = db
      .prepare(
        `INSERT INTO messages (direct_id, sender_id, body, reply_to_id, thread_root_id) VALUES (?,?,?,?,?)`
      )
      .run(did, req.userId, bodyTrimmed, replyToIdFinal, threadRootIdDm);
    const mid = info.lastInsertRowid;
    for (const f of files) {
      const kind = detectKind(f.mimetype);
      const displayNameDm =
        normalizePossibleMultipartFilename(f.originalname) || f.originalname || f.filename;
      db.prepare(
        `INSERT INTO message_attachments (message_id, file_name, stored_name, mime_type, kind) VALUES (?,?,?,?,?)`
      ).run(mid, displayNameDm, f.filename, f.mimetype || 'application/octet-stream', kind);
    }
    const tagsDm = parseMentionTags(bodyTrimmed);
    for (const t of tagsDm) {
      const u = db.prepare(`SELECT id FROM users WHERE tag = ? COLLATE NOCASE`).get(t);
      if (u && u.id === peer) {
        db.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`).run(
          mid,
          peer
        );
      }
    }
    for (const uid of parseExtraMentionUserIdsFromBody(req.body)) {
      if (uid === peer) {
        db.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`).run(
          mid,
          peer
        );
      }
    }
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    clearDirectHiddenForBoth(did);
    emitDirectMessageNewToParticipants(d, msg);
    const mentionIdsDm = buildMessagePayload(msg).mentionUserIds;
    for (const uid of mentionIdsDm) {
      if (uid === req.userId) continue;
      emitToUser(uid, 'mention:notify', { ...buildMessagePayload(msg, uid), directId: did });
    }
    res.json(buildMessagePayload(msg, req.userId));
  });

  r.post('/messages/:id/pin', requireAuth, (req, res) => {
    const mid = +req.params.id;
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.group_id) {
      const chk = requireGroupMember(msg.group_id, req.userId, 'moderator');
      if (!chk.ok) return res.status(403).json({ error: chk.error });
      db.prepare(`UPDATE messages SET pinned_at = ? WHERE id = ?`).run(nowIso(), mid);
    } else if (msg.direct_id) {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа' });
      db.prepare(`UPDATE messages SET pinned_at = ? WHERE id = ?`).run(nowIso(), mid);
    } else return res.status(400).json({ error: '?' });
    const m2 = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (msg.group_id) emitGroupMessageEvent('message:pinned', msg.group_id, m2);
    else io.to(`direct:${msg.direct_id}`).emit('message:pinned', buildMessagePayload(m2));
    res.json(buildMessagePayload(m2, req.userId));
  });

  r.post('/messages/delete-batch', requireAuth, (req, res) => {
    const raw = req.body?.ids;
    if (!Array.isArray(raw) || raw.length === 0)
      return res.status(400).json({ error: 'Укажите ids' });
    const ids = [...new Set(raw.map((x) => +x))].filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length > 200) return res.status(400).json({ error: 'Слишком много сообщений' });
    const deletedIds = [];
    for (const mid of ids) {
      const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
      if (!msg) continue;
      if (msg.group_id) {
        const chk = requireGroupMember(msg.group_id, req.userId);
        if (!chk.ok) continue;
        const isMod = requireGroupMember(msg.group_id, req.userId, 'moderator').ok;
        if (!isMod && msg.sender_id !== req.userId) continue;
      } else if (msg.direct_id) {
        const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
        if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId)) continue;
        if (msg.sender_id !== req.userId) continue;
      } else continue;
      deleteMessageWithAttachmentCleanup(mid);
      deletedIds.push(mid);
      const payload = { id: mid, groupId: msg.group_id, directId: msg.direct_id };
      if (msg.group_id) io.to(`group:${msg.group_id}`).emit('message:deleted', payload);
      else io.to(`direct:${msg.direct_id}`).emit('message:deleted', payload);
    }
    res.json({ ok: true, deletedIds });
  });

  r.post('/messages/forward-batch', requireAuth, forwardUserLimit, (req, res) => {
    const { targetKind, targetId: tidRaw, messageIds: midRaw } = req.body || {};
    const tid = tidRaw != null ? +tidRaw : NaN;
    if (!['group', 'direct'].includes(targetKind) || !Number.isFinite(tid))
      return res.status(400).json({ error: 'targetKind, targetId' });
    if (!Array.isArray(midRaw) || midRaw.length === 0)
      return res.status(400).json({ error: 'messageIds' });
    const ids = [...new Set(midRaw.map((x) => +x))].filter((n) => Number.isFinite(n) && n > 0);
    ids.sort((a, b) => a - b);
    if (ids.length > 40) return res.status(400).json({ error: 'Не более 40 сообщений за раз' });
    const sources = [];
    for (const mid of ids) {
      const src = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
      if (!src || !canAccessMessage(src, req.userId))
        return res.status(403).json({ error: 'Нет доступа к одному из сообщений' });
      if (src.group_id != null) {
        const gs = db.prepare(`SELECT forward_locked FROM groups WHERE id = ?`).get(src.group_id);
        if (gs?.forward_locked)
          return res.status(403).json({ error: 'Пересылка из этого чата запрещена' });
      }
      sources.push(src);
    }
    if (targetKind === 'group') {
      const chk = requireGroupMember(tid, req.userId);
      if (!chk.ok || isBannedMember(tid, req.userId))
        return res.status(403).json({ error: 'Нет доступа к группе' });
    } else {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(tid);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа к чату' });
      const peer = d.user_low_id === req.userId ? d.user_high_id : d.user_low_id;
      if (!areFriends(req.userId, peer)) return res.status(403).json({ error: 'Не в коллегах' });
    }
    const entries = sources.map((src) => forwardEntryForStorageFromRow(src));
    const fwdJson = JSON.stringify(entries);
    // Транзакция: или все записи (пересылка + вложения + workspace links) создаются целиком, или откат.
    // До этого частичные сбои оставляли половинчатое «переслано пусто» сообщение с оборванными вложениями.
    const insertMsgGroup = db.prepare(
      `INSERT INTO messages (group_id, sender_id, body, forward_preview_json) VALUES (?,?,?,?)`
    );
    const insertMsgDirect = db.prepare(
      `INSERT INTO messages (direct_id, sender_id, body, forward_preview_json) VALUES (?,?,?,?)`
    );
    const selectAtts = db.prepare(`SELECT * FROM message_attachments WHERE message_id = ?`);
    const insertAtt = db.prepare(
      `INSERT INTO message_attachments (message_id, file_name, stored_name, mime_type, kind, transcript) VALUES (?,?,?,?,?,?)`
    );
    const runForward = db.transaction(() => {
      const info =
        targetKind === 'group'
          ? insertMsgGroup.run(tid, req.userId, '', fwdJson)
          : insertMsgDirect.run(tid, req.userId, '', fwdJson);
      const mid = info.lastInsertRowid;
      for (const src of sources) {
        const atts = selectAtts.all(src.id);
        for (const a of atts) {
          insertAtt.run(mid, a.file_name, a.stored_name, a.mime_type, a.kind, a.transcript || null);
        }
      }
      return mid;
    });
    const newMid = runForward();
    cloneWorkspaceLinksForForwardedMessage(
      db,
      io,
      newMid,
      targetKind,
      targetKind === 'group' ? tid : null,
      req.userId,
      ids
    );
    const newMsg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(newMid);
    if (targetKind === 'group') emitGroupMessageEvent('message:new', tid, newMsg);
    else {
      clearDirectHiddenForBoth(tid);
      const dT = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(tid);
      if (dT) emitDirectMessageNewToParticipants(dT, newMsg);
    }
    res.json(buildMessagePayload(newMsg, req.userId));
  });

  r.post('/messages/:id/unpin', requireAuth, (req, res) => {
    const mid = +req.params.id;
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!msg) return res.status(404).json({ error: 'Не найдено' });
    if (msg.group_id) {
      const chk = requireGroupMember(msg.group_id, req.userId, 'moderator');
      if (!chk.ok) return res.status(403).json({ error: chk.error });
    } else if (msg.direct_id) {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа' });
    }
    db.prepare(`UPDATE messages SET pinned_at = NULL WHERE id = ?`).run(mid);
    if (msg.group_id) io.to(`group:${msg.group_id}`).emit('message:unpinned', { id: mid });
    else io.to(`direct:${msg.direct_id}`).emit('message:unpinned', { id: mid });
    res.json({ ok: true, id: mid });
  });

  const deleteMessageHandler = (req, res) => {
    const mid = +req.params.id;
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.group_id) {
      const chk = requireGroupMember(msg.group_id, req.userId);
      if (!chk.ok) return res.status(403).json({ error: chk.error });
      const isMod = requireGroupMember(msg.group_id, req.userId, 'moderator').ok;
      if (!isMod && msg.sender_id !== req.userId)
        return res.status(403).json({ error: 'Удалять может автор или модератор/админ' });
    } else if (msg.direct_id) {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа' });
      if (msg.sender_id !== req.userId)
        return res.status(403).json({ error: 'В личном чате можно удалить только своё сообщение' });
    } else return res.status(400).json({ error: '?' });
    deleteMessageWithAttachmentCleanup(mid);
    const payload = { id: mid, groupId: msg.group_id, directId: msg.direct_id };
    if (msg.group_id) io.to(`group:${msg.group_id}`).emit('message:deleted', payload);
    else io.to(`direct:${msg.direct_id}`).emit('message:deleted', payload);
    res.json({ ok: true, ...payload });
  };
  r.delete('/messages/:id', requireAuth, deleteMessageHandler);
  r.post('/messages/:id/delete', requireAuth, deleteMessageHandler);

  const editMessageHandler = (req, res) => {
    const mid = +req.params.id;
    const bodyNew = String(req.body?.body ?? '');
    const bodyTrimmed = bodyNew.trim();
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.sender_id !== req.userId)
      return res.status(403).json({ error: 'Редактировать можно только своё сообщение' });
    if (msg.group_id) {
      const chk = requireGroupMember(msg.group_id, req.userId);
      if (!chk.ok) return res.status(403).json({ error: chk.error });
    } else if (msg.direct_id) {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа' });
    }
    const attRow = db
      .prepare(`SELECT COUNT(*) AS c FROM message_attachments WHERE message_id = ?`)
      .get(mid);
    const attCount = attRow?.c ?? 0;
    const hasForward = !!(msg.forward_preview_json && String(msg.forward_preview_json).trim());
    if (!bodyTrimmed && attCount === 0 && !hasForward) {
      return res.status(400).json({ error: 'Пустое сообщение' });
    }
    db.prepare(`UPDATE messages SET body = ?, edited_at = ? WHERE id = ?`).run(bodyTrimmed, nowIso(), mid);
    db.prepare(`DELETE FROM message_mentions WHERE message_id = ?`).run(mid);
    if (msg.group_id) {
      const tags = parseMentionTags(bodyTrimmed);
      for (const t of tags) {
        const u = db.prepare(`SELECT id FROM users WHERE tag = ? COLLATE NOCASE`).get(t);
        if (u) {
          const inGroup = getMembership(msg.group_id, u.id);
          if (inGroup && !isBannedMember(msg.group_id, u.id)) {
            db.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`).run(
              mid,
              u.id
            );
          }
        }
      }
      for (const uid of parseExtraMentionUserIdsFromBody(req.body)) {
        const inGroup = getMembership(msg.group_id, uid);
        if (inGroup && !isBannedMember(msg.group_id, uid)) {
          db.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`).run(
            mid,
            uid
          );
        }
      }
    } else if (msg.direct_id) {
      const dRow = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(msg.direct_id);
      if (dRow) {
        const peerId =
          dRow.user_low_id === req.userId ? dRow.user_high_id : dRow.user_low_id;
        const tagsDm = parseMentionTags(bodyTrimmed);
        for (const t of tagsDm) {
          const u = db.prepare(`SELECT id FROM users WHERE tag = ? COLLATE NOCASE`).get(t);
          if (u && u.id === peerId) {
            db.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`).run(
              mid,
              peerId
            );
          }
        }
        for (const uid of parseExtraMentionUserIdsFromBody(req.body)) {
          if (uid === peerId) {
            db.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`).run(
              mid,
              peerId
            );
          }
        }
      }
    }
    const updated = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (msg.group_id) emitGroupMessageEvent('message:updated', msg.group_id, updated);
    else io.to(`direct:${msg.direct_id}`).emit('message:updated', buildMessagePayload(updated));
    res.json(buildMessagePayload(updated, req.userId));
  };
  r.patch('/messages/:id', requireAuth, editMessageHandler);
  r.post('/messages/:id/edit', requireAuth, editMessageHandler);

  r.post('/messages/:id/important', requireAuth, (req, res) => {
    const mid = +req.params.id;
    const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!msg || !canAccessMessage(msg, req.userId))
      return res.status(403).json({ error: 'Нет доступа' });
    const ex = db
      .prepare(`SELECT 1 FROM user_message_important WHERE user_id = ? AND message_id = ?`)
      .get(req.userId, mid);
    if (ex) {
      db.prepare(`DELETE FROM user_message_important WHERE user_id = ? AND message_id = ?`).run(
        req.userId,
        mid
      );
      return res.json({ important: false });
    }
    db.prepare(`INSERT INTO user_message_important (user_id, message_id) VALUES (?,?)`).run(
      req.userId,
      mid
    );
    res.json({ important: true });
  });

  r.post('/messages/:id/forward', requireAuth, (req, res) => {
    const mid = +req.params.id;
    const { targetKind, targetId: tidRaw } = req.body || {};
    const tid = tidRaw != null ? +tidRaw : NaN;
    if (!['group', 'direct'].includes(targetKind) || !Number.isFinite(tid))
      return res.status(400).json({ error: 'targetKind, targetId' });
    const src = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(mid);
    if (!src || !canAccessMessage(src, req.userId))
      return res.status(403).json({ error: 'Нет доступа' });
    if (src.group_id != null) {
      const gs = db.prepare(`SELECT forward_locked FROM groups WHERE id = ?`).get(src.group_id);
      if (gs?.forward_locked)
        return res.status(403).json({ error: 'Пересылка сообщений из этого чата запрещена' });
    }
    if (targetKind === 'group') {
      const chk = requireGroupMember(tid, req.userId);
      if (!chk.ok || isBannedMember(tid, req.userId))
        return res.status(403).json({ error: 'Нет доступа к группе' });
    } else {
      const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(tid);
      if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
        return res.status(403).json({ error: 'Нет доступа к чату' });
      const peer = d.user_low_id === req.userId ? d.user_high_id : d.user_low_id;
      if (!areFriends(req.userId, peer)) return res.status(403).json({ error: 'Не в коллегах' });
    }
    const fwdJson = JSON.stringify([forwardEntryForStorageFromRow(src)]);
    let info;
    if (targetKind === 'group') {
      info = db
        .prepare(
          `INSERT INTO messages (group_id, sender_id, body, forward_preview_json) VALUES (?,?,?,?)`
        )
        .run(tid, req.userId, '', fwdJson);
    } else {
      info = db
        .prepare(
          `INSERT INTO messages (direct_id, sender_id, body, forward_preview_json) VALUES (?,?,?,?)`
        )
        .run(tid, req.userId, '', fwdJson);
    }
    const newMid = info.lastInsertRowid;
    const atts = db.prepare(`SELECT * FROM message_attachments WHERE message_id = ?`).all(mid);
    for (const a of atts) {
      db.prepare(
        `INSERT INTO message_attachments (message_id, file_name, stored_name, mime_type, kind, transcript) VALUES (?,?,?,?,?,?)`
      ).run(
        newMid,
        a.file_name,
        a.stored_name,
        a.mime_type,
        a.kind,
        a.transcript || null
      );
    }
    cloneWorkspaceLinksForForwardedMessage(
      db,
      io,
      newMid,
      targetKind,
      targetKind === 'group' ? tid : null,
      req.userId,
      [mid]
    );
    const newMsg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(newMid);
    if (targetKind === 'group') emitGroupMessageEvent('message:new', tid, newMsg);
    else {
      clearDirectHiddenForBoth(tid);
      const dT = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(tid);
      if (dT) emitDirectMessageNewToParticipants(dT, newMsg);
    }
    res.json(buildMessagePayload(newMsg, req.userId));
  });

  r.get('/groups/:id/pins', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT * FROM messages WHERE group_id = ? AND pinned_at IS NOT NULL ORDER BY id DESC`
      )
      .all(gid);
    res.json(rows.map((row) => buildMessagePayload(row, req.userId)));
  });

  r.get('/direct/:directId/pins', requireAuth, (req, res) => {
    const did = +req.params.directId;
    const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(did);
    if (!d || (d.user_low_id !== req.userId && d.user_high_id !== req.userId))
      return res.status(403).json({ error: 'Нет доступа' });
    const rows = db
      .prepare(
        `SELECT * FROM messages WHERE direct_id = ? AND pinned_at IS NOT NULL ORDER BY id DESC`
      )
      .all(did);
    res.json(rows.map((row) => buildMessagePayload(row, req.userId)));
  });

  r.get('/tasks/:taskId/linked-chat-messages', requireAuth, (req, res) => {
    const tid = +req.params.taskId;
    const t = db
      .prepare(`SELECT t.id, b.group_id FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = ?`)
      .get(tid);
    if (!t) return res.status(404).json({ error: 'Задача не найдена' });
    const chk = requireGroupMember(t.group_id, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT m.id, m.body, m.created_at FROM message_workspace_links l
         JOIN messages m ON m.id = l.message_id
         WHERE l.link_kind = 'task' AND l.entity_id = ? AND m.group_id = ?
         ORDER BY m.id DESC
         LIMIT 30`
      )
      .all(tid, t.group_id);
    res.json(
      rows.map((r) => ({
        messageId: r.id,
        bodyPreview: String(r.body || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        createdAt: sqliteUtcToIso(r.created_at) ?? r.created_at,
      }))
    );
  });

  r.get('/collab-docs/:docId/linked-chat-messages', requireAuth, (req, res) => {
    const docId = +req.params.docId;
    const doc = db.prepare(`SELECT id, group_id FROM collab_documents WHERE id = ?`).get(docId);
    if (!doc) return res.status(404).json({ error: 'Документ не найден' });
    const chk = requireGroupMember(doc.group_id, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT m.id, m.body, m.created_at FROM message_workspace_links l
         JOIN messages m ON m.id = l.message_id
         WHERE l.link_kind = 'collab_document' AND l.entity_id = ? AND m.group_id = ?
         ORDER BY m.id DESC
         LIMIT 30`
      )
      .all(docId, doc.group_id);
    res.json(
      rows.map((r) => ({
        messageId: r.id,
        bodyPreview: String(r.body || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        createdAt: sqliteUtcToIso(r.created_at) ?? r.created_at,
      }))
    );
  });

  // --- Подключение модулей: доски/коллаб-документы, OnlyOffice ---

  appendWorkspaceRoutes(r, io);
  appendOnlyOfficeRoutes(r, io);

  return r;
}
