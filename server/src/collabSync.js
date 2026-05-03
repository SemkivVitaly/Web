/**
 * @fileoverview Серверная синхронизация Yjs для коллаб-документов: пул документов в памяти, отложенная запись `y_state` в SQLite,
 * Socket.IO комнаты `collab:{docId}` (`collab:join`, `collab:leave`, `collab:y-update`).
 *
 * Лимиты: `COLLAB_POOL_MAX` (число документов в RAM), `COLLAB_MAX_UPDATE_B64` (длина одного base64-апдейта).
 */

import * as Y from 'yjs';
import { getDb } from './db.js';
import { verifyPassword } from './auth.js';

// docId -> { ydoc, debounceTimer }
const pool = new Map();

/** Макс. число Y.Doc в памяти; при переполнении вытесняется самый старый ключ (порядок вставки в Map). */
const POOL_MAX_DOCS = Number(process.env.COLLAB_POOL_MAX) || 40;
/** Макс. длина строки base64 одного апдейта от клиента (data URL картинок и т.д.). */
const MAX_Y_UPDATE_BASE64_LEN = Number(process.env.COLLAB_MAX_UPDATE_B64) || 12_000_000;

// --- Доступ к документу (группа, бан, пароли папки и документа; модератор обходит пароли) ---

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
    .prepare(`SELECT role FROM group_members WHERE group_id = ? AND user_id = ?`)
    .get(groupId, userId);
}

function isGroupModeratorOrAdmin(db, groupId, userId) {
  if (isBannedMember(db, groupId, userId)) return false;
  const m = getMembership(db, groupId, userId);
  if (!m) return false;
  return m.role === 'admin' || m.role === 'moderator';
}

/**
 * Проверка права открыть документ и корректности паролей (документ и при необходимости папка).
 * @returns {{ ok: true, row }} или `{ ok: false, error }`
 */
export function checkCollabDocAccess(db, docId, userId, password, folderPassword) {
  const row = db.prepare(`SELECT * FROM collab_documents WHERE id = ?`).get(docId);
  if (!row) return { ok: false, error: 'Документ не найден' };
  if (isBannedMember(db, row.group_id, userId) || !getMembership(db, row.group_id, userId))
    return { ok: false, error: 'Нет доступа' };
  const bypass = isGroupModeratorOrAdmin(db, row.group_id, userId);
  if (!bypass && row.folder_id) {
    const fold = db.prepare(`SELECT * FROM collab_folders WHERE id = ? AND group_id = ?`).get(row.folder_id, row.group_id);
    if (
      fold?.password_hash &&
      (!folderPassword || !verifyPassword(String(folderPassword), fold.password_hash))
    )
      return { ok: false, error: 'Нужен пароль папки' };
  }
  if (!bypass && row.password_hash && (!password || !verifyPassword(String(password), row.password_hash)))
    return { ok: false, error: 'Нужен пароль' };
  return { ok: true, row };
}

/** Убрать документ из пула (таймер сохранения, destroy Y.Doc); вызывать при удалении документа на диске/в БД. */
export function evictCollabDoc(docId) {
  const entry = pool.get(docId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  try {
    entry.ydoc.destroy();
  } catch {
    /* noop */
  }
  pool.delete(docId);
}

/**
 * Получить общий для всех сокетов `Y.Doc` для `docId`, загрузив начальное состояние из `collab_documents.y_state`.
 * При переполнении пула вытесняет один старый документ.
 */
export function getOrCreateYDoc(docId) {
  const db = getDb();
  if (pool.has(docId)) return pool.get(docId).ydoc;

  if (pool.size >= POOL_MAX_DOCS) {
    const first = pool.keys().next().value;
    if (first != null && first !== docId) evictCollabDoc(first);
  }

  const row = db.prepare(`SELECT y_state FROM collab_documents WHERE id = ?`).get(docId);
  const ydoc = new Y.Doc();
  if (row?.y_state && row.y_state.length) {
    Y.applyUpdate(ydoc, new Uint8Array(row.y_state));
  }
  pool.set(docId, { ydoc, timer: null });
  return ydoc;
}

/** Дебаунс записи полного encoded state в БД (~1.2 с после последнего апдейта). */
function scheduleSave(docId) {
  const db = getDb();
  const entry = pool.get(docId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const state = Y.encodeStateAsUpdate(entry.ydoc);
    db.prepare(`UPDATE collab_documents SET y_state = ?, updated_at = datetime('now') WHERE id = ?`).run(
      Buffer.from(state),
      docId
    );
  }, 1200);
}

/** Регистрация обработчиков коллаба на сервере Socket.IO (вызывать один раз при старте). */
export function setupCollabSync(io) {
  io.on('connection', (socket) => {
    const uid = socket.userId;

    socket.on('collab:join', (payload, cb) => {
      const db = getDb();
      const docId = +payload?.docId;
      const password = payload?.password;
      const folderPassword = payload?.folderPassword;
      const a = checkCollabDocAccess(db, docId, uid, password, folderPassword);
      if (!a.ok) return cb?.({ ok: false, error: a.error });
      if (socket.collabDocId && socket.collabDocId !== docId) {
        socket.leave(`collab:${socket.collabDocId}`);
      }
      socket.join(`collab:${docId}`);
      socket.collabDocId = docId;
      const ydoc = getOrCreateYDoc(docId);
      const state = Y.encodeStateAsUpdate(ydoc);
      cb?.({ ok: true, state: Buffer.from(state).toString('base64') });
    });

    socket.on('collab:leave', (payload, cb) => {
      const docId = +payload?.docId;
      socket.leave(`collab:${docId}`);
      if (socket.collabDocId === docId) socket.collabDocId = null;
      cb?.({ ok: true });
    });

    socket.on('collab:y-update', (payload) => {
      const docId = +payload?.docId;
      const upd = payload?.update;
      if (
        typeof upd !== 'string' ||
        upd.length === 0 ||
        upd.length > MAX_Y_UPDATE_BASE64_LEN ||
        socket.collabDocId !== docId
      ) {
        return;
      }
      let update;
      try {
        update = Buffer.from(upd, 'base64');
      } catch {
        return;
      }
      if (update.length > 10 * 1024 * 1024) return;
      const ydoc = getOrCreateYDoc(docId);
      Y.applyUpdate(ydoc, update, 'socket');
      socket.to(`collab:${docId}`).emit('collab:y-update', { docId, update: payload.update });
      scheduleSave(docId);
    });
  });
}
