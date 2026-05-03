/**
 * @fileoverview Точка входа сервера LocalChat: Express (CORS, JSON, `/api`, статика `uploads` и при наличии — SPA из `client/dist`),
 * Socket.IO с JWT в handshake, комнаты `user:*`, `group:*`, `direct:*`, коллаб в `collabSync`, события канбана в группу.
 * Переменные: `PORT`, `HOST`, `CORS_ORIGINS` (обязательно в production), `TRUST_PROXY`, таймауты ping для Socket.IO.
 */

import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { getDb } from './db.js';
import { createApiRouter } from './routes.js';
import { verifyToken } from './auth.js';
import { uploadsDir } from './upload.js';
import { setupCollabSync } from './collabSync.js';
import {
  canUserJoinDirectSocketRoom,
  canUserJoinGroupSocketRoom,
} from './socketJoinAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3780;
const HOST = process.env.HOST || '0.0.0.0';

/** CORS: в production задайте CORS_ORIGINS=https://app.example.com,https://www.example.com */
function buildCorsOptions() {
  const raw = process.env.CORS_ORIGINS?.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) ?? [];
  if (raw.length > 0) return { origin: raw, credentials: true };
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] В production укажите CORS_ORIGINS (список origin через запятую).');
    process.exit(1);
  }
  return { origin: true, credentials: true };
}

const corsOptions = buildCorsOptions();

const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
const server = http.createServer(app);

const io = new Server(server, {
  cors: corsOptions,
  // чуть быстрее обнаруживаем «мёртвые» сокеты
  pingTimeout: 20000,
  pingInterval: 10000,
  /** collab:join с большим y_state (раньше по умолчанию ~1 МБ обрывался — пустой/битый документ) */
  maxHttpBufferSize: 32 * 1024 * 1024,
});

app.use(cors(corsOptions));
app.use(express.json({ limit: '25mb' }));
app.use('/uploads', express.static(uploadsDir));
app.use('/api', createApiRouter(io));
setupCollabSync(io);

const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

// --- Socket.IO: извлечение JWT из handshake, привязка userId ---

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token || typeof token !== 'string') return next(new Error('auth'));
  const payload = verifyToken(token);
  if (!payload?.userId) return next(new Error('auth'));
  socket.userId = payload.userId;
  next();
});

function taskBoardGroupId(db, boardId) {
  const r = db.prepare(`SELECT group_id FROM task_boards WHERE id = ?`).get(boardId);
  return r?.group_id ?? null;
}

function canUserPointerOnTaskBoard(db, boardId, userId) {
  const gid = taskBoardGroupId(db, boardId);
  if (gid == null) return null;
  const m = db
    .prepare(
      `SELECT 1 FROM group_members gm WHERE gm.group_id = ? AND gm.user_id = ?
       AND (gm.banned_until IS NULL OR datetime(gm.banned_until) <= datetime('now'))`
    )
    .get(gid, userId);
  return m ? gid : null;
}

/** Ограничение частоты pointer-событий (защита от флуда и лишней нагрузки). */
const pointerThrottleMs = 40;
const lastPointerAt = new WeakMap();

/** Уникальные userId в комнате чата (несколько вкладок = один пользователь). */
const presenceRefCounts = new Map();
function presenceKey(kind, roomId) {
  return `${kind}:${roomId}`;
}
function emitChatPresence(io, socketRoom, kind, roomId) {
  const pk = presenceKey(kind, roomId);
  const m = presenceRefCounts.get(pk);
  const onlineUserIds = m ? [...m.keys()] : [];
  io.to(socketRoom).emit('chat:presence', {
    chatKind: kind,
    chatId: roomId,
    onlineUserIds,
  });
}
function presenceEnter(kind, roomId, userId, io, socketRoom) {
  const pk = presenceKey(kind, roomId);
  let m = presenceRefCounts.get(pk);
  if (!m) {
    m = new Map();
    presenceRefCounts.set(pk, m);
  }
  const prev = m.get(userId) || 0;
  m.set(userId, prev + 1);
  if (prev === 0) emitChatPresence(io, socketRoom, kind, roomId);
}
function presenceLeave(kind, roomId, userId, io, socketRoom) {
  const pk = presenceKey(kind, roomId);
  const m = presenceRefCounts.get(pk);
  if (!m) return;
  const prev = m.get(userId) || 0;
  if (prev <= 1) {
    m.delete(userId);
    emitChatPresence(io, socketRoom, kind, roomId);
  } else {
    m.set(userId, prev - 1);
  }
  if (m.size === 0) presenceRefCounts.delete(pk);
}

const typingThrottle = new Map();

// --- События сокета: join/leave чатов, typing, presence, указатели и DnD канбана ---

io.on('connection', (socket) => {
  const uid = socket.userId;
  socket.join(`user:${uid}`);

  socket.on('join', (payload, cb) => {
    const { kind, id } = payload || {};
    const roomId = Number(id);
    if ((kind !== 'group' && kind !== 'direct') || !Number.isFinite(roomId) || roomId <= 0) {
      cb?.({ ok: false, error: 'invalid_room' });
      return;
    }
    const db = getDb();
    const roomName = kind === 'group' ? `group:${roomId}` : `direct:${roomId}`;
    if (socket.rooms.has(roomName)) {
      cb?.({ ok: true });
      return;
    }
    if (kind === 'group') {
      if (!canUserJoinGroupSocketRoom(db, roomId, uid)) {
        cb?.({ ok: false, error: 'forbidden' });
        return;
      }
      socket.join(roomName);
      presenceEnter('group', roomId, uid, io, roomName);
    } else {
      if (!canUserJoinDirectSocketRoom(db, roomId, uid)) {
        cb?.({ ok: false, error: 'forbidden' });
        return;
      }
      socket.join(roomName);
      presenceEnter('direct', roomId, uid, io, roomName);
    }
    const pk = presenceKey(kind, roomId);
    const snap = presenceRefCounts.get(pk);
    socket.emit('chat:presence', {
      chatKind: kind,
      chatId: roomId,
      onlineUserIds: snap ? [...snap.keys()] : [],
    });
    cb?.({ ok: true });
  });

  socket.on('leave', (payload, cb) => {
    const { kind, id } = payload || {};
    const roomId = Number(id);
    if ((kind !== 'group' && kind !== 'direct') || !Number.isFinite(roomId) || roomId <= 0) {
      cb?.({ ok: false, error: 'invalid_room' });
      return;
    }
    const roomName = kind === 'group' ? `group:${roomId}` : `direct:${roomId}`;
    if (!socket.rooms.has(roomName)) {
      cb?.({ ok: true });
      return;
    }
    if (kind === 'group') {
      socket.leave(roomName);
      presenceLeave('group', roomId, uid, io, roomName);
    } else {
      socket.leave(roomName);
      presenceLeave('direct', roomId, uid, io, roomName);
    }
    cb?.({ ok: true });
  });

  socket.on('chat:typing', (payload, cb) => {
    const kind = payload?.chatKind;
    const roomId = Number(payload?.chatId);
    const active = !!payload?.active;
    if ((kind !== 'group' && kind !== 'direct') || !Number.isFinite(roomId) || roomId <= 0) {
      cb?.({ ok: false, error: 'invalid' });
      return;
    }
    const db = getDb();
    const roomName = kind === 'group' ? `group:${roomId}` : `direct:${roomId}`;
    if (!socket.rooms.has(roomName)) {
      cb?.({ ok: false, error: 'not_in_room' });
      return;
    }
    if (kind === 'group') {
      if (!canUserJoinGroupSocketRoom(db, roomId, uid)) {
        cb?.({ ok: false, error: 'forbidden' });
        return;
      }
    } else if (!canUserJoinDirectSocketRoom(db, roomId, uid)) {
      cb?.({ ok: false, error: 'forbidden' });
      return;
    }
    if (active) {
      const now = Date.now();
      const prev = typingThrottle.get(socket) || 0;
      if (now - prev < 1000) {
        cb?.({ ok: true });
        return;
      }
      typingThrottle.set(socket, now);
    }
    const u = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(uid);
    socket.to(roomName).emit('chat:typing', {
      chatKind: kind,
      chatId: roomId,
      userId: uid,
      displayName: u?.display_name || 'Участник',
      active,
    });
    cb?.({ ok: true });
  });

  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (room === socket.id) continue;
      if (room.startsWith('group:')) {
        const roomId = +room.slice(6);
        if (Number.isFinite(roomId) && roomId > 0) presenceLeave('group', roomId, uid, io, room);
      } else if (room.startsWith('direct:')) {
        const roomId = +room.slice(7);
        if (Number.isFinite(roomId) && roomId > 0) presenceLeave('direct', roomId, uid, io, room);
      }
    }
    typingThrottle.delete(socket);
  });

  socket.on('taskboard:pointer', (payload) => {
    const now = Date.now();
    const prev = lastPointerAt.get(socket) ?? 0;
    if (now - prev < pointerThrottleMs) return;
    lastPointerAt.set(socket, now);

    const boardId = +payload?.boardId;
    const x = +payload?.x;
    const y = +payload?.y;
    if (!Number.isFinite(boardId) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const db = getDb();
    const gid = canUserPointerOnTaskBoard(db, boardId, uid);
    if (!gid) return;
    const u = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(uid);
    const color = `hsl(${(uid * 47) % 360} 72% 56%)`;
    socket.to(`group:${gid}`).emit('taskboard:cursors', {
      boardId,
      userId: uid,
      displayName: u?.display_name || 'Участник',
      color,
      x,
      y,
      ts: Date.now(),
    });
  });

  socket.on('taskboard:pointer-leave', (payload) => {
    const boardId = +payload?.boardId;
    if (!Number.isFinite(boardId)) return;
    const db = getDb();
    const gid = canUserPointerOnTaskBoard(db, boardId, uid);
    if (!gid) return;
    socket.to(`group:${gid}`).emit('taskboard:cursors', {
      boardId,
      userId: uid,
      leave: true,
    });
  });

  socket.on('taskboard:drag', (payload) => {
    const boardId = +payload?.boardId;
    const phase = payload?.phase;
    if (!Number.isFinite(boardId) || (phase !== 'start' && phase !== 'end')) return;
    const db = getDb();
    const gid = canUserPointerOnTaskBoard(db, boardId, uid);
    if (!gid) return;
    const u = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(uid);
    const color = `hsl(${(uid * 47) % 360} 72% 56%)`;
    const canvasItemId =
      payload?.canvasItemId != null && payload.canvasItemId !== ''
        ? +payload.canvasItemId
        : null;
    socket.to(`group:${gid}`).emit('taskboard:drag', {
      boardId,
      userId: uid,
      displayName: u?.display_name || 'Участник',
      color,
      phase,
      canvasItemId: Number.isFinite(canvasItemId) ? canvasItemId : null,
      ts: Date.now(),
    });
  });
});

if (fs.existsSync(clientDist)) {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

server.listen(PORT, HOST, () => {
  console.log(`LocalChat сервер: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

function gracefulShutdown(signal) {
  console.log(`${signal}: завершение…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 12_000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
