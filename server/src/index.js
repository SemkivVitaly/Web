/**
 * @fileoverview Точка входа сервера LocalChat: Express (CORS, JSON, `/api`, статика SPA из `client/dist`),
 * Socket.IO с JWT в handshake, комнаты `user:*`, `group:*`, `direct:*`, коллаб в `collabSync`, события канбана в группу.
 * Переменные: `PORT`, `HOST`, `CORS_ORIGINS` (обязательно в production).
 */

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { getDb } from './db.js';
import { createApiRouter } from './routes.js';
import { verifyToken } from './auth.js';
import { setupCollabSync } from './collabSync.js';
import { cleanupOrphanUploadFiles } from './orphanCleanup.js';
import {
  canUserJoinDirectSocketRoom,
  canUserJoinGroupSocketRoom,
} from './socketJoinAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3780;
const HOST = process.env.HOST || '0.0.0.0';

const RFC1918_HOST =
  /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/;

/** Разрешает http(s)://localhost|127.0.0.1|localchat|RFC1918:<PORT> для LAN без правки CORS_ORIGINS. */
function isLanAppOrigin(origin) {
  try {
    const u = new URL(origin);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (port !== String(PORT)) return false;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === 'localchat') return true;
    return RFC1918_HOST.test(host);
  } catch {
    return false;
  }
}

/** CORS: в production задайте CORS_ORIGINS=https://app.example.com,https://www.example.com */
function buildCorsOptions() {
  const raw = process.env.CORS_ORIGINS?.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) ?? [];
  const allowlist = new Set(raw);
  if (raw.length > 0) {
    return {
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowlist.has(origin) || isLanAppOrigin(origin)) return callback(null, origin);
        return callback(null, false);
      },
      credentials: true,
    };
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] В production укажите CORS_ORIGINS (список origin через запятую).');
    process.exit(1);
  }
  return { origin: true, credentials: true };
}

function useHttpsHeaders() {
  const v = (process.env.USE_HTTPS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** OnlyOffice грузит `api.js` с Document Server — origin должен быть в script-src CSP. */
function onlyOfficeCspOrigins() {
  const out = new Set(['http://localhost:8081', 'http://127.0.0.1:8081']);
  const ooPort = process.env.ONLYOFFICE_PORT || '8081';
  out.add(`http://localhost:${ooPort}`);
  out.add(`http://127.0.0.1:${ooPort}`);
  const raw = (process.env.ONLYOFFICE_DOCUMENT_SERVER_URL || '').trim().replace(/\/$/, '');
  if (raw) {
    try {
      const u = new URL(raw);
      out.add(`${u.protocol}//${u.host}`);
    } catch {
      /* ignore */
    }
  }
  const lan = (process.env.LAN_HOST || '').trim();
  if (lan) out.add(`http://${lan}:${ooPort}`);
  return [...out];
}

function buildContentSecurityPolicyDirectives() {
  const ooOrigins = onlyOfficeCspOrigins();
  return {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:', ...ooOrigins],
    'style-src': ["'self'", "'unsafe-inline'", ...ooOrigins],
    'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
    'connect-src': ["'self'", 'ws:', 'wss:', 'https:', 'http:', ...ooOrigins],
    'frame-src': ["'self'", 'https:', 'http:', ...ooOrigins],
    'media-src': ["'self'", 'blob:', 'https:', 'http:'],
    'worker-src': ["'self'", 'blob:', ...ooOrigins],
    ...(useHttpsHeaders() ? {} : { 'upgrade-insecure-requests': null }),
  };
}

const corsOptions = buildCorsOptions();

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: buildContentSecurityPolicyDirectives(),
    },
    crossOriginEmbedderPolicy: false,
    // Plain HTTP on LAN (e.g. http://192.168.x.x) is an untrustworthy origin — isolation headers warn in the console.
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(compression());
app.use(cookieParser());
app.use(cors(corsOptions));
app.use(express.json({ limit: '25mb' }));

const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: corsOptions,
  pingTimeout: 20000,
  pingInterval: 10000,
  maxHttpBufferSize: 32 * 1024 * 1024,
});

app.use('/api', createApiRouter(io));
setupCollabSync(io);

if (fs.existsSync(clientDist)) {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

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

const pointerThrottleMs = 40;
const lastPointerAt = new WeakMap();

const presenceRefCounts = new Map();
function presenceKey(kind, roomId) {
  return `${kind}:${roomId}`;
}
function emitChatPresence(ioInst, socketRoom, kind, roomId) {
  const pk = presenceKey(kind, roomId);
  const m = presenceRefCounts.get(pk);
  const onlineUserIds = m ? [...m.keys()] : [];
  ioInst.to(socketRoom).emit('chat:presence', {
    chatKind: kind,
    chatId: roomId,
    onlineUserIds,
  });
}
function presenceEnter(kind, roomId, userId, ioInst, socketRoom) {
  const pk = presenceKey(kind, roomId);
  let m = presenceRefCounts.get(pk);
  if (!m) {
    m = new Map();
    presenceRefCounts.set(pk, m);
  }
  const prev = m.get(userId) || 0;
  m.set(userId, prev + 1);
  if (prev === 0) emitChatPresence(ioInst, socketRoom, kind, roomId);
}
function presenceLeave(kind, roomId, userId, ioInst, socketRoom) {
  const pk = presenceKey(kind, roomId);
  const m = presenceRefCounts.get(pk);
  if (!m) return;
  const prev = m.get(userId) || 0;
  if (prev <= 1) {
    m.delete(userId);
    emitChatPresence(ioInst, socketRoom, kind, roomId);
  } else {
    m.set(userId, prev - 1);
  }
  if (m.size === 0) presenceRefCounts.delete(pk);
}

const typingThrottle = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token || typeof token !== 'string') return next(new Error('auth'));
  const payload = verifyToken(token);
  if (!payload?.userId) return next(new Error('auth'));
  socket.userId = payload.userId;
  next();
});

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

getDb();
if (process.env.CLEANUP_ORPHAN_UPLOADS !== '0') {
  try {
    cleanupOrphanUploadFiles();
  } catch (e) {
    console.warn('[orphanCleanup] startup skipped:', e?.message || e);
  }
}

httpServer.listen(PORT, HOST, () => {
  console.log(`LocalChat HTTP: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

function gracefulShutdown(signal) {
  console.log(`${signal}: завершение…`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 12_000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
