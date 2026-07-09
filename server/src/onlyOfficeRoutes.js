/**
 * @fileoverview Интеграция OnlyOffice Document Server: конфигурация редактора, выдача файлов по JWT, импорт через Conversion API,
 * callback сохранения. Зависит от `ONLYOFFICE_DOCUMENT_SERVER_URL`. Базовый URL API для ссылок, которые скачивает DS:
 * `PUBLIC_BASE_URL` либо авто из `Host` запроса. Опционально `ONLYOFFICE_JWT_SECRET` для подписи
 * запросов к converter. Подключается из `routes.js` через `appendOnlyOfficeRoutes`.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { requireAuth } from './middleware.js';
import { checkCollabDocAccess, evictCollabDoc } from './collabSync.js';
import {
  signOoDownloadToken,
  verifyOoDownloadToken,
  signOoImportToken,
  verifyOoImportToken,
  signOoChatAttachmentToken,
  verifyOoChatAttachmentToken,
  signOoAnnouncementAttachmentToken,
  verifyOoAnnouncementAttachmentToken,
} from './auth.js';
import { ensureOfficeDiskFile, readOfficeFileBuffer, writeOfficeFileBuffer } from './officeFileStore.js';
import { upload, decodeMultipartFilename, normalizePossibleMultipartFilename, uploadsDir } from './upload.js';
import { writeAudit } from './auditLog.js';

const OO_JWT_SECRET = (process.env.ONLYOFFICE_JWT_SECRET || '').trim();

/** Таймаут HTTP-запросов к Document Server (мс). DS должен успеть отдать файл результата. */
const OO_FETCH_TIMEOUT_MS = Number(process.env.ONLYOFFICE_FETCH_TIMEOUT_MS) || 60_000;
/** Лимит на размер ответа DS при скачивании результата/вложения (байт). Защита от OOM. */
const OO_FETCH_MAX_BYTES = Number(process.env.ONLYOFFICE_FETCH_MAX_BYTES) || 128 * 1024 * 1024;

/**
 * `fetch` с таймаутом (AbortSignal) и ограничением размера тела. Используется только для обмена с Document Server.
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function fetchWithLimit(url, init = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), OO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, body: null };
    const len = Number(res.headers.get('content-length') || 0);
    if (len > 0 && len > OO_FETCH_MAX_BYTES) return { ok: false, status: 413, body: null };
    const reader = res.body?.getReader?.();
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > OO_FETCH_MAX_BYTES) return { ok: false, status: 413, body: null };
      return { ok: true, status: res.status, body: buf, contentType: res.headers.get('content-type') || '' };
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > OO_FETCH_MAX_BYTES) {
          try { await reader.cancel(); } catch { /* noop */ }
          return { ok: false, status: 413, body: null };
        }
        chunks.push(value);
      }
    }
    return { ok: true, status: res.status, body: Buffer.concat(chunks), contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(to);
  }
}

/**
 * Проверка, что URL указывает на ONLYOFFICE_DOCUMENT_SERVER_URL. Блокирует SSRF: обычный `fetch` по
 * пользовательскому URL из callback-тела может ходить в интранет. Возвращает `true`, если origin совпадает с DS.
 * @param {string | null | undefined} rawUrl
 */
function isTrustedDocumentServerUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const ds = ooBaseUrl();
  if (!ds) return false;
  let base;
  try {
    base = new URL(ds);
  } catch {
    return false;
  }
  let candidate;
  try {
    candidate = new URL(rawUrl);
  } catch {
    return false;
  }
  if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') return false;
  if (candidate.protocol !== base.protocol) return false;
  if (candidate.host !== base.host) return false;
  return true;
}

/**
 * Проверка подписи callback-тела от OnlyOffice. Если `ONLYOFFICE_JWT_SECRET` не задан — считаем конфигурацию
 * доверенной и пропускаем (DS запускался без JWT). Иначе — требуем `body.token` или заголовок
 * `Authorization: Bearer <token>` (OnlyOffice docs).
 * @returns {{ ok: true, payload: object | null } | { ok: false, error: string }}
 */
function verifyOnlyOfficeCallbackSignature(req, body) {
  if (!OO_JWT_SECRET) return { ok: true, payload: null };
  const auth = String(req.headers.authorization || '');
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const bodyToken = typeof body?.token === 'string' ? body.token : '';
  const token = headerToken || bodyToken;
  if (!token) return { ok: false, error: 'missing token' };
  try {
    return { ok: true, payload: jwt.verify(token, OO_JWT_SECRET) };
  } catch {
    return { ok: false, error: 'bad token' };
  }
}

// --- Временные сессии загрузки для Conversion API (importId → путь к файлу на диске) ---

/** Сессии файлов для скачивания Document Server'ом перед конвертацией */
const ooImportSessions = new Map();

function ooConversionErrorMessage(code) {
  const n = +code;
  const map = {
    '-1': 'Неизвестная ошибка конвертации OnlyOffice',
    '-2': 'Таймаут конвертации',
    '-3': 'Ошибка при конвертации документа',
    '-4':
      'OnlyOffice не смог скачать файл (задайте PUBLIC_BASE_URL, доступный с Document Server, или откройте приложение по тому же хосту/порту, что видит DS)',
    '-5': 'Ошибка при скачивании результата',
    '-6': 'Ошибка при обращении к базе данных конвертера',
    '-7': 'Входной файл пуст',
    '-8': 'Формат не поддерживается для конвертации',
  };
  return map[String(n)] || `Ошибка конвертации OnlyOffice (код ${n})`;
}

function resolveOoFileUrl(ds, fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') return null;
  if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) return fileUrl;
  const base = ds.replace(/\/$/, '');
  return fileUrl.startsWith('/') ? `${base}${fileUrl}` : `${base}/${fileUrl}`;
}

function inputFiletypeForConversion(extRaw, mimeRaw, wantSpreadsheet) {
  const ext = String(extRaw || '')
    .replace(/^\./, '')
    .toLowerCase();
  const mime = String(mimeRaw || '').toLowerCase();
  if (wantSpreadsheet) {
    if (['xlsx', 'xls', 'ods', 'csv', 'fods'].includes(ext)) return ext;
    if (mime.includes('csv')) return 'csv';
    if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('officedocument.spreadsheetml'))
      return ext || 'xlsx';
    return ext || null;
  }
  if (['docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'htm', 'epub', 'docm', 'dotx', 'pdf'].includes(ext))
    return ext;
  if (mime.includes('html')) return 'html';
  if (mime.includes('text/plain')) return 'txt';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('word') || mime.includes('officedocument.wordprocessing')) return ext || 'docx';
  return ext || null;
}

function cleanupImportSession(importId, filePath) {
  ooImportSessions.delete(importId);
  if (filePath)
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* noop */
    }
}

async function postOnlyOfficeConvert(documentServerUrl, payload) {
  const base = documentServerUrl.replace(/\/$/, '');
  const shard = encodeURIComponent(String(payload.key || 'default'));
  const url = `${base}/converter?shardkey=${shard}`;
  let bodyStr;
  if (OO_JWT_SECRET) {
    const token = jwt.sign(payload, OO_JWT_SECRET, { algorithm: 'HS256' });
    bodyStr = JSON.stringify({ token });
  } else {
    bodyStr = JSON.stringify(payload);
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), OO_FETCH_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: bodyStr,
      signal: ctrl.signal,
    });
    text = await res.text();
  } finally {
    clearTimeout(to);
  }
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Некорректный ответ OnlyOffice converter');
  }
  if (data.token && OO_JWT_SECRET) {
    try {
      data = jwt.verify(data.token, OO_JWT_SECRET);
    } catch {
      throw new Error('Некорректный JWT в ответе OnlyOffice');
    }
  }
  return { httpOk: res.ok, data };
}

function ooBaseUrl() {
  return (process.env.ONLYOFFICE_DOCUMENT_SERVER_URL || '').trim().replace(/\/$/, '');
}

/**
 * Базовый URL API для ссылок, которые Document Server скачивает по HTTP (документ, callback, import source).
 * 1) `PUBLIC_BASE_URL` — явно (Docker: имя сервиса, host.docker.internal, LAN IP с точки зрения контейнера DS).
 * 2) Иначе — из запроса: `Host` (всегда HTTP).
 */
function publicBaseUrlFromRequest(req) {
  const fixed = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (fixed) return fixed;

  const host = (req.get('host') || '').trim();
  if (!host) {
    const port = process.env.PORT || 3780;
    return `http://127.0.0.1:${port}`;
  }
  return `http://${host}`;
}

function parseOoKey(key) {
  const m = String(key || '').match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  return { docId: +m[1], revision: +m[2] };
}

/** Ключ вложения чата для OnlyOffice: `ca-{attachmentId}-{office_revision}`. */
function parseChatAttOoKey(key) {
  const m = String(key || '').match(/^ca-(\d+)-(\d+)$/);
  if (!m) return null;
  return { attId: +m[1], revision: +m[2] };
}

function chatAttachmentUploadPath(storedName) {
  const baseName = path.basename(String(storedName || ''));
  if (!baseName || baseName !== String(storedName).trim() || baseName.includes('..')) return null;
  return path.join(uploadsDir, baseName);
}

function getMessageAttachmentAccess(db, attachmentId, userId) {
  const att = db.prepare(`SELECT * FROM message_attachments WHERE id = ?`).get(attachmentId);
  if (!att) return { ok: false, error: 'Вложение не найдено' };
  const msg = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(att.message_id);
  if (!msg) return { ok: false, error: 'Сообщение не найдено' };
  if (msg.group_id) {
    const m = db
      .prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?`)
      .get(msg.group_id, userId);
    if (!m) return { ok: false, error: 'Нет доступа' };
  } else if (msg.direct_id) {
    const d = db
      .prepare(`SELECT user_low_id, user_high_id FROM direct_conversations WHERE id = ?`)
      .get(msg.direct_id);
    if (!d || (d.user_low_id !== userId && d.user_high_id !== userId))
      return { ok: false, error: 'Нет доступа' };
  } else return { ok: false, error: 'Нет доступа' };
  return { ok: true, att, msg };
}

function getAnnouncementAttachmentAccess(db, attachmentId, userId) {
  const att = db.prepare(`SELECT * FROM announcement_attachments WHERE id = ?`).get(attachmentId);
  if (!att) return { ok: false, error: 'Вложение не найдено' };
  const ann = db.prepare(`SELECT * FROM group_announcements WHERE id = ?`).get(att.announcement_id);
  if (!ann || ann.deleted_at) return { ok: false, error: 'Объявление не найдено' };
  const m = db
    .prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?`)
    .get(ann.group_id, userId);
  if (!m) return { ok: false, error: 'Нет доступа' };
  return { ok: true, att, ann };
}

function collabPasswordBypassForFolder(db, groupId, userId) {
  const row = db.prepare(`SELECT role FROM group_members WHERE group_id = ? AND user_id = ?`).get(groupId, userId);
  if (!row) return false;
  return row.role === 'moderator' || row.role === 'admin';
}

/** Типы файла и вкладки редактора OnlyOffice для просмотра вложения из чата. */
function ooAttachmentViewerTypes(fileName, mimeType) {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (['xlsx', 'xls', 'ods', 'csv', 'fods'].includes(ext)) {
    const ft = ext === 'xls' ? 'xls' : ext === 'csv' ? 'csv' : ext === 'ods' ? 'ods' : 'xlsx';
    return { fileType: ft, documentType: 'cell' };
  }
  const wordExts = ['docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'htm', 'pdf', 'epub', 'docm', 'dotx'];
  if (wordExts.includes(ext)) return { fileType: ext, documentType: 'word' };
  if (mime.includes('pdf')) return { fileType: 'pdf', documentType: 'word' };
  if (mime.includes('spreadsheet') || mime.includes('excel')) return { fileType: 'xlsx', documentType: 'cell' };
  if (mime.includes('word') || mime.includes('officedocument.wordprocessingml'))
    return { fileType: 'docx', documentType: 'word' };
  if (mime.includes('text/plain')) return { fileType: 'txt', documentType: 'word' };
  if (mime.includes('html')) return { fileType: 'html', documentType: 'word' };
  return null;
}

function collabDocTypeFromAttachmentFileName(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (/\.(xlsx|xls|csv|ods|fods)$/i.test(lower)) return 'spreadsheet';
  return 'richtext';
}

function emitCollabTreeRefresh(io, groupId) {
  io.to(`group:${groupId}`).emit('collab:tree-refresh', { groupId });
}

/**
 * Импорт файла с диска в коллаб-документ (office_revision 0). Возвращает `via`; удаляет `filePath` при успехе.
 * @throws {Error & { statusCode?: number }} с message для ответа клиенту
 */
async function performOfficeImportFromFilePath({
  db,
  io,
  req,
  docId,
  row,
  filePath,
  origName,
  mimetype,
  userId,
  auditAction = 'collab_document_import_onlyoffice',
}) {
  const docType = row.doc_type === 'spreadsheet' ? 'spreadsheet' : 'richtext';
  const outputtype = docType === 'spreadsheet' ? 'xlsx' : 'docx';
  const ext = path.extname(origName).slice(1).toLowerCase();
  const wantSheet = docType === 'spreadsheet';
  const importId = randomUUID();

  const finishOk = (via) => {
    cleanupImportSession(importId, filePath);
    db.prepare(
      `UPDATE collab_documents SET office_revision = COALESCE(office_revision, 0) + 1, y_state = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(docId);
    evictCollabDoc(docId);
    writeAudit(db, userId, auditAction, 'group', row.group_id, {
      documentId: docId,
      sourceFileName: origName,
      via,
    });
    emitCollabTreeRefresh(io, row.group_id);
    return via;
  };

  if ((wantSheet && ext === 'xlsx') || (!wantSheet && ext === 'docx')) {
    const buf = fs.readFileSync(filePath);
    writeOfficeFileBuffer(docId, docType, buf);
    return finishOk('direct');
  }

  let filetype = inputFiletypeForConversion(ext, mimetype, wantSheet);
  if (!filetype) {
    cleanupImportSession(importId, filePath);
    const err = new Error(
      'Не удалось определить формат для OnlyOffice. Для текста: .txt, .html; Word: .doc, .docx, .odt, .rtf; таблицы: .xls, .xlsx, .csv, .ods'
    );
    err.statusCode = 400;
    throw err;
  }

  ooImportSessions.set(importId, {
    path: filePath,
    mime: mimetype || 'application/octet-stream',
    origName,
    filetype,
    createdAt: Date.now(),
  });

  const ds = ooBaseUrl();
  const pub = publicBaseUrlFromRequest(req);
  const srcToken = signOoImportToken(importId);
  const pseudo = `source.${filetype}`;
  const sourceUrl = `${pub}/api/onlyoffice/import-source/fetch/${encodeURIComponent(pseudo)}?token=${encodeURIComponent(srcToken)}`;

  const convertPayload = {
    async: false,
    filetype,
    key: `${docId}-imp-${Date.now()}-${randomBytes(6).toString('hex')}`,
    outputtype,
    title: path.basename(origName).slice(0, 240),
    url: sourceUrl,
  };

  const { httpOk, data: convJson } = await postOnlyOfficeConvert(ds, convertPayload);

  const convErr = convJson.error ?? convJson.Error;
  const hasErr = convErr != null && Number(convErr) !== 0;
  if (!httpOk || hasErr) {
    const msg = hasErr ? ooConversionErrorMessage(convErr) : 'Ошибка запроса к OnlyOffice converter';
    cleanupImportSession(importId, filePath);
    const err = new Error(msg);
    err.statusCode = 502;
    throw err;
  }

  const done =
    convJson.endConvert === true ||
    convJson.endConvert === 'true' ||
    convJson.EndConvert === true ||
    convJson.EndConvert === 'true';
  const outFileUrl = convJson.fileUrl || convJson.FileUrl;
  if (!done || !outFileUrl) {
    cleanupImportSession(importId, filePath);
    const err = new Error('Конвертация не завершена');
    err.statusCode = 502;
    throw err;
  }

  const outUrl = resolveOoFileUrl(ds, outFileUrl);
  if (!outUrl || !isTrustedDocumentServerUrl(outUrl)) {
    cleanupImportSession(importId, filePath);
    const err = new Error('Нет ссылки на результат конвертации');
    err.statusCode = 502;
    throw err;
  }

  const fileRes = await fetchWithLimit(outUrl);
  if (!fileRes.ok || !fileRes.body) {
    cleanupImportSession(importId, filePath);
    const err = new Error('Не удалось скачать сконвертированный файл');
    err.statusCode = 502;
    throw err;
  }

  if (!fileRes.body.length) {
    cleanupImportSession(importId, filePath);
    const err = new Error('Пустой результат конвертации');
    err.statusCode = 502;
    throw err;
  }

  writeOfficeFileBuffer(docId, docType, fileRes.body);
  return finishOk('onlyoffice');
}

/**
 * Регистрирует маршруты `/api/onlyoffice/*` и связанные с коллаб-документом пути на переданном роутере.
 *
 * @param {import('express').Router} r
 * @param {import('socket.io').Server} io — для `collab:tree-refresh` после сохранения с диска
 */
export function appendOnlyOfficeRoutes(r, io) {
  const db = getDb();
  const w = express.Router();

  // --- Клиент: доступность DS, JSON-конфиг для встраивания редактора ---

  w.get('/onlyoffice/enabled', requireAuth, (_req, res) => {
    const base = ooBaseUrl();
    res.json({ enabled: !!base, documentServerUrl: base || null });
  });

  /** Document Server: скачивание файла вложения чата по JWT `oo-chat-att`. */
  w.get('/message-attachments/:attachmentId/onlyoffice/document', async (req, res, next) => {
    try {
      const attId = +req.params.attachmentId;
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const v = verifyOoChatAttachmentToken(token);
      if (!v || v.attId !== attId) return res.status(403).send('token');

      const att = db.prepare(`SELECT * FROM message_attachments WHERE id = ?`).get(attId);
      if (!att) return res.status(404).send('no att');
      const fp = chatAttachmentUploadPath(att.stored_name);
      if (!fp) return res.status(400).send('bad name');
      if (!fs.existsSync(fp)) return res.status(404).send('missing');
      const buf = fs.readFileSync(fp);
      const mime = att.mime_type || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', 'inline');
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  /**
   * JSON-конфиг OnlyOffice для вложения из чата: `body.mode` — `view` (по умолчанию) или `edit`
   * (только автор сообщения; callback перезаписывает файл в uploads и инкрементирует office_revision).
   */
  w.post('/message-attachments/:attachmentId/onlyoffice/config', requireAuth, async (req, res, next) => {
    try {
      const ds = ooBaseUrl();
      if (!ds)
        return res.status(501).json({ error: 'OnlyOffice не настроен (ONLYOFFICE_DOCUMENT_SERVER_URL).' });

      const attId = +req.params.attachmentId;
      const access = getMessageAttachmentAccess(db, attId, req.userId);
      if (!access.ok) return res.status(403).json({ error: access.error });

      const modeRaw = String((req.body && req.body.mode) || 'view').toLowerCase();
      const wantEdit = modeRaw === 'edit';
      if (wantEdit && +access.msg.sender_id !== +req.userId) {
        return res.status(403).json({ error: 'Только автор сообщения может редактировать вложение' });
      }

      const fn = normalizePossibleMultipartFilename(access.att.file_name) || access.att.file_name;
      const types = ooAttachmentViewerTypes(fn, access.att.mime_type);
      if (!types) return res.status(400).json({ error: 'Формат не подходит для просмотра в OnlyOffice' });

      const revision = Number(access.att.office_revision ?? 0);
      const key = `ca-${attId}-${revision}`;
      const dlToken = signOoChatAttachmentToken(attId, { longLived: wantEdit });
      const pub = publicBaseUrlFromRequest(req);
      const documentUrl = `${pub}/api/message-attachments/${attId}/onlyoffice/document?token=${encodeURIComponent(dlToken)}`;

      const u = db.prepare(`SELECT id, username, display_name FROM users WHERE id = ?`).get(req.userId);
      const uName = u?.display_name || u?.username || `user_${req.userId}`;
      const safeTitle = `${String(path.basename(fn)).replace(/[/\\?%*:|"<>]/g, '_').slice(0, 240)}`;

      const callbackUrl = wantEdit ? `${pub}/api/onlyoffice/callback-chat-attachment` : undefined;

      const config = {
        document: {
          fileType: types.fileType,
          key,
          title: safeTitle,
          url: documentUrl,
        },
        documentType: types.documentType,
        editorConfig: {
          mode: wantEdit ? 'edit' : 'view',
          ...(callbackUrl ? { callbackUrl } : {}),
          user: {
            id: String(req.userId),
            name: String(uName).slice(0, 200),
          },
          ...(wantEdit
            ? {
                coEditing: {
                  mode: 'fast',
                  change: true,
                },
              }
            : {}),
          lang: 'ru',
        },
        height: '100%',
        width: '100%',
      };

      res.json({
        documentServerUrl: ds,
        config,
      });
    } catch (e) {
      next(e);
    }
  });

  /** Document Server: скачивание файла вложения объявления по JWT `oo-ann-att`. */
  w.get('/announcement-attachments/:attachmentId/onlyoffice/document', async (req, res, next) => {
    try {
      const attId = +req.params.attachmentId;
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const v = verifyOoAnnouncementAttachmentToken(token);
      if (!v || v.attId !== attId) return res.status(403).send('token');

      const att = db.prepare(`SELECT * FROM announcement_attachments WHERE id = ?`).get(attId);
      if (!att) return res.status(404).send('no att');
      const ann = db.prepare(`SELECT deleted_at FROM group_announcements WHERE id = ?`).get(att.announcement_id);
      if (!ann || ann.deleted_at) return res.status(404).send('deleted');
      const fp = chatAttachmentUploadPath(att.stored_name);
      if (!fp) return res.status(400).send('bad name');
      if (!fs.existsSync(fp)) return res.status(404).send('missing');
      const buf = fs.readFileSync(fp);
      const mime = att.mime_type || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', 'inline');
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  /** JSON-конфиг OnlyOffice для вложения объявления (только просмотр). */
  w.post('/announcement-attachments/:attachmentId/onlyoffice/config', requireAuth, async (req, res, next) => {
    try {
      const ds = ooBaseUrl();
      if (!ds)
        return res.status(501).json({ error: 'OnlyOffice не настроен (ONLYOFFICE_DOCUMENT_SERVER_URL).' });

      const attId = +req.params.attachmentId;
      const access = getAnnouncementAttachmentAccess(db, attId, req.userId);
      if (!access.ok) return res.status(403).json({ error: access.error });

      const fn = normalizePossibleMultipartFilename(access.att.file_name) || access.att.file_name;
      const types = ooAttachmentViewerTypes(fn, access.att.mime_type);
      if (!types) return res.status(400).json({ error: 'Формат не подходит для просмотра в OnlyOffice' });

      const key = `aa-${attId}-0`;
      const dlToken = signOoAnnouncementAttachmentToken(attId);
      const pub = publicBaseUrlFromRequest(req);
      const documentUrl = `${pub}/api/announcement-attachments/${attId}/onlyoffice/document?token=${encodeURIComponent(dlToken)}`;

      const u = db.prepare(`SELECT id, username, display_name FROM users WHERE id = ?`).get(req.userId);
      const uName = u?.display_name || u?.username || `user_${req.userId}`;
      const safeTitle = `${String(path.basename(fn)).replace(/[/\\?%*:|"<>]/g, '_').slice(0, 240)}`;

      const config = {
        document: {
          fileType: types.fileType,
          key,
          title: safeTitle,
          url: documentUrl,
        },
        documentType: types.documentType,
        editorConfig: {
          mode: 'view',
          user: {
            id: String(req.userId),
            name: String(uName).slice(0, 200),
          },
          lang: 'ru',
        },
        height: '100%',
        width: '100%',
      };

      res.json({
        documentServerUrl: ds,
        config,
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Копирует вложение группового чата в новый collab-документ (импорт через OnlyOffice при необходимости).
   */
  w.post(
    '/groups/:groupId/message-attachments/:attachmentId/save-to-collab',
    requireAuth,
    async (req, res, next) => {
      try {
        const ds = ooBaseUrl();
        if (!ds)
          return res.status(501).json({ error: 'OnlyOffice не настроен (ONLYOFFICE_DOCUMENT_SERVER_URL).' });

        const gid = +req.params.groupId;
        const attId = +req.params.attachmentId;
        const mem = db.prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?`).get(gid, req.userId);
        if (!mem) return res.status(403).json({ error: 'Нет доступа' });

        const access = getMessageAttachmentAccess(db, attId, req.userId);
        if (!access.ok) return res.status(403).json({ error: access.error });
        if (!access.msg.group_id || access.msg.group_id !== gid)
          return res.status(400).json({ error: 'Вложение не из этого чата' });

        const att = access.att;
        const fn = normalizePossibleMultipartFilename(att.file_name) || att.file_name;
        const docType = collabDocTypeFromAttachmentFileName(fn);
        const baseTitle =
          path.basename(fn, path.extname(fn)).replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 200) || 'Документ';
        const description = `Импорт из чата: ${fn}`.slice(0, 2000);

        const info = db
          .prepare(
            `INSERT INTO collab_documents (group_id, folder_id, name, description, doc_type, password_hash, created_by, task_board_only) VALUES (?,?,?,?,?,?,?,?)`
          )
          .run(gid, null, baseTitle, description, docType, null, req.userId, 0);
        const newId = info.lastInsertRowid;
        const row = db.prepare(`SELECT * FROM collab_documents WHERE id = ?`).get(newId);
        if (!row) {
          return res.status(500).json({ error: 'Не удалось создать документ' });
        }

        const baseName = path.basename(String(att.stored_name || ''));
        if (!baseName || baseName !== String(att.stored_name).trim() || baseName.includes('..'))
          return res.status(400).json({ error: 'Некорректное имя файла' });
        const srcPath = path.join(uploadsDir, baseName);
        if (!fs.existsSync(srcPath)) {
          db.prepare(`DELETE FROM collab_documents WHERE id = ?`).run(newId);
          return res.status(404).json({ error: 'Файл вложения не найден' });
        }

        const tmpPath = path.join(uploadsDir, `chat-import-${randomUUID()}${path.extname(baseName) || ''}`);
        fs.copyFileSync(srcPath, tmpPath);

        try {
          const via = await performOfficeImportFromFilePath({
            db,
            io,
            req,
            docId: newId,
            row,
            filePath: tmpPath,
            origName: fn,
            mimetype: att.mime_type,
            userId: req.userId,
            auditAction: 'collab_document_import_from_chat_attachment',
          });
          res.json({ ok: true, documentId: newId, via });
        } catch (e) {
          db.prepare(`DELETE FROM collab_documents WHERE id = ?`).run(newId);
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            /* noop */
          }
          const code = e?.statusCode;
          const msg = e?.message || 'Ошибка импорта';
          if (code) return res.status(code).json({ error: msg });
          next(e);
        }
      } catch (e) {
        next(e);
      }
    }
  );

  w.post('/collab-docs/:id/onlyoffice/config', requireAuth, async (req, res, next) => {
    try {
      const ds = ooBaseUrl();
      if (!ds)
        return res.status(501).json({ error: 'OnlyOffice не настроен (ONLYOFFICE_DOCUMENT_SERVER_URL).' });

      const docId = +req.params.id;
      const { password, folderPassword } = req.body || {};
      const a = checkCollabDocAccess(db, docId, req.userId, password, folderPassword);
      if (!a.ok) return res.status(403).json({ error: a.error });

      const row = a.row;
      const docType = row.doc_type === 'spreadsheet' ? 'spreadsheet' : 'richtext';
      const fileType = docType === 'spreadsheet' ? 'xlsx' : 'docx';
      const documentType = docType === 'spreadsheet' ? 'cell' : 'word';

      await ensureOfficeDiskFile(docId, docType);

      const revision = Number(row.office_revision ?? 0);
      const key = `${docId}-${revision}`;

      const dlToken = signOoDownloadToken(docId);
      const pub = publicBaseUrlFromRequest(req);
      const documentUrl = `${pub}/api/collab-docs/${docId}/onlyoffice/document?token=${encodeURIComponent(dlToken)}`;

      const u = db.prepare(`SELECT id, username, display_name FROM users WHERE id = ?`).get(req.userId);
      const uName = u?.display_name || u?.username || `user_${req.userId}`;

      const callbackUrl = `${pub}/api/onlyoffice/callback`;

      const config = {
        document: {
          fileType,
          key,
          title: `${String(row.name || 'document').replace(/[/\\?%*:|"<>]/g, '_')}.${fileType}`,
          url: documentUrl,
        },
        documentType,
        editorConfig: {
          mode: 'edit',
          callbackUrl,
          user: {
            id: String(req.userId),
            name: String(uName).slice(0, 200),
          },
          coEditing: {
            mode: 'fast',
            change: true,
          },
          lang: 'ru',
        },
        height: '100%',
        width: '100%',
      };

      res.json({
        documentServerUrl: ds,
        config,
      });
    } catch (e) {
      next(e);
    }
  });

  // --- Document Server: скачивание актуального .docx/.xlsx по токену `oo-dl` ---

  w.get('/collab-docs/:id/onlyoffice/document', async (req, res, next) => {
    try {
      const docId = +req.params.id;
      const token = req.query.token;
      const v = verifyOoDownloadToken(typeof token === 'string' ? token : '');
      if (!v || v.docId !== docId) return res.status(403).send('token');

      const row = db.prepare(`SELECT * FROM collab_documents WHERE id = ?`).get(docId);
      if (!row) return res.status(404).send('no doc');

      const docType = row.doc_type === 'spreadsheet' ? 'spreadsheet' : 'richtext';
      await ensureOfficeDiskFile(docId, docType);
      const buf = readOfficeFileBuffer(docId, docType);
      if (!buf) return res.status(404).send('file missing');

      const mime =
        docType === 'spreadsheet'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', 'inline');
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  // --- Conversion API: отдача исходного upload по токену `oo-imp` (имя `source.{filetype}`) ---

  /**
   * Исходный файл для Conversion API. Путь должен заканчиваться на .{filetype} — иначе Document Server
   * часто не распознаёт формат и отдаёт пустой docx/xlsx.
   */
  w.get('/onlyoffice/import-source/fetch/:pseudoFile', async (req, res, next) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const v = verifyOoImportToken(token);
      if (!v) return res.status(403).send('token');
      const sess = ooImportSessions.get(v.importId);
      if (!sess) return res.status(404).send('expired');
      if (!sess.filetype) return res.status(400).send('session');
      const expectName = `source.${sess.filetype}`;
      if (req.params.pseudoFile !== expectName) return res.status(400).send('name');
      if (!fs.existsSync(sess.path)) return res.status(404).send('missing');
      const buf = fs.readFileSync(sess.path);
      const mimeByFt = {
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        doc: 'application/msword',
        odt: 'application/vnd.oasis.opendocument.text',
        rtf: 'application/rtf',
        txt: 'text/plain; charset=utf-8',
        html: 'text/html; charset=utf-8',
        htm: 'text/html; charset=utf-8',
        pdf: 'application/pdf',
        epub: 'application/epub+zip',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xls: 'application/vnd.ms-excel',
        csv: 'text/csv; charset=utf-8',
        ods: 'application/vnd.oasis.opendocument.spreadsheet',
        fods: 'application/vnd.oasis.opendocument.spreadsheet',
      };
      const ct = mimeByFt[sess.filetype] || sess.mime || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(sess.origName || expectName)}`);
      res.send(buf);
    } catch (e) {
      next(e);
    }
  });

  // --- Импорт в коллаб-документ: копия docx/xlsx или конвертация через OnlyOffice (revision 0) ---

  /**
   * Импорт загруженного файла в офисный документ через OnlyOffice Conversion API → docx/xlsx на диск.
   * Только для документов с office_revision === 0 (ещё не сохранялись из редактора).
   */
  w.post(
    '/collab-docs/:id/import-onlyoffice',
    requireAuth,
    upload.single('file'),
    async (req, res, next) => {
      try {
        const ds = ooBaseUrl();
        if (!ds)
          return res.status(501).json({ error: 'OnlyOffice не настроен (ONLYOFFICE_DOCUMENT_SERVER_URL).' });

        const docId = +req.params.id;
        const { password, folderPassword } = req.body || {};
        const a = checkCollabDocAccess(db, docId, req.userId, password, folderPassword);
        if (!a.ok) return res.status(403).json({ error: a.error });

        const row = a.row;
        if (Number(row.office_revision ?? 0) !== 0)
          return res.status(409).json({
            error:
              'Импорт возможен только в новый документ (уже было сохранение в OnlyOffice). Создайте новый документ.',
          });

        if (!req.file) return res.status(400).json({ error: 'file' });

        const origName = decodeMultipartFilename(req.file.originalname) || req.file.filename || 'upload';
        try {
          const via = await performOfficeImportFromFilePath({
            db,
            io,
            req,
            docId,
            row,
            filePath: req.file.path,
            origName,
            mimetype: req.file.mimetype,
            userId: req.userId,
          });
          res.json({ ok: true, via });
        } catch (e) {
          try {
            if (req.file?.path) fs.unlinkSync(req.file.path);
          } catch {
            /* noop */
          }
          const code = e?.statusCode;
          const msg = e?.message || 'Ошибка импорта';
          if (code) return res.status(code).json({ error: msg });
          next(e);
        }
      } catch (e) {
        next(e);
      }
    }
  );

  // --- Callback редактора: скачивание сохранённого файла, инкремент office_revision ---

  w.post('/onlyoffice/callback', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    const body = req.body;
    if (!body || typeof body !== 'object') return res.json({ error: 1 });

    // Подпись DS (если задан ONLYOFFICE_JWT_SECRET) — исключает подделку callback с внешних хостов.
    const sig = verifyOnlyOfficeCallbackSignature(req, body);
    if (!sig.ok) return res.json({ error: 1 });
    const signedBody = sig.payload?.payload ?? sig.payload ?? body;

    const parsed = parseOoKey(signedBody.key || body.key);
    if (!parsed) return res.json({ error: 1 });

    const { docId, revision } = parsed;
    const row = db.prepare(`SELECT * FROM collab_documents WHERE id = ?`).get(docId);
    if (!row) return res.json({ error: 1 });

    const dbRev = Number(row.office_revision ?? 0);
    if (revision !== dbRev) return res.json({ error: 0 });

    const status = +(signedBody.status ?? body.status);
    const docType = row.doc_type === 'spreadsheet' ? 'spreadsheet' : 'richtext';

    if (status === 2 || status === 6) {
      try {
        const url = signedBody.url || body.url;
        if (!url || typeof url !== 'string' || !isTrustedDocumentServerUrl(url)) {
          return res.json({ error: 1 });
        }
        const r = await fetchWithLimit(url);
        if (!r.ok || !r.body) return res.json({ error: 1 });
        if (!r.body.length) return res.json({ error: 1 });
        // Атомарный bump: запись файла только при успешном условном инкременте (защита от гонки при
        // параллельных callback'ах с тем же key).
        const upd = db
          .prepare(
            `UPDATE collab_documents SET office_revision = office_revision + 1, updated_at = datetime('now') WHERE id = ? AND office_revision = ?`
          )
          .run(docId, revision);
        if (upd.changes !== 1) return res.json({ error: 0 });
        writeOfficeFileBuffer(docId, docType, r.body);
        emitCollabTreeRefresh(io, row.group_id);
      } catch (e) {
        console.error('[onlyoffice callback]', e);
        return res.json({ error: 1 });
      }
    }

    return res.json({ error: 0 });
  });

  /** Callback OnlyOffice: сохранение отредактированного вложения чата на диск и bump office_revision. */
  w.post('/onlyoffice/callback-chat-attachment', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    const body = req.body;
    if (!body || typeof body !== 'object') return res.json({ error: 1 });

    const sig = verifyOnlyOfficeCallbackSignature(req, body);
    if (!sig.ok) return res.json({ error: 1 });
    const signedBody = sig.payload?.payload ?? sig.payload ?? body;

    const parsed = parseChatAttOoKey(signedBody.key || body.key);
    if (!parsed) return res.json({ error: 1 });

    const { attId, revision } = parsed;
    const att = db.prepare(`SELECT * FROM message_attachments WHERE id = ?`).get(attId);
    if (!att) return res.json({ error: 1 });

    const dbRev = Number(att.office_revision ?? 0);
    if (revision !== dbRev) return res.json({ error: 0 });

    const status = +(signedBody.status ?? body.status);

    if (status === 2 || status === 6) {
      try {
        const url = signedBody.url || body.url;
        if (!url || typeof url !== 'string' || !isTrustedDocumentServerUrl(url)) {
          return res.json({ error: 1 });
        }
        const fp = chatAttachmentUploadPath(att.stored_name);
        if (!fp) return res.json({ error: 1 });
        const r = await fetchWithLimit(url);
        if (!r.ok || !r.body) return res.json({ error: 1 });
        if (!r.body.length) return res.json({ error: 1 });
        const upd = db
          .prepare(
            `UPDATE message_attachments SET office_revision = office_revision + 1 WHERE id = ? AND office_revision = ?`
          )
          .run(attId, revision);
        if (upd.changes !== 1) return res.json({ error: 0 });
        fs.writeFileSync(fp, r.body);
      } catch (e) {
        console.error('[onlyoffice callback-chat]', e);
        return res.json({ error: 1 });
      }
    }

    return res.json({ error: 0 });
  });

  const ooImportSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of [...ooImportSessions.entries()]) {
      if (now - (s.createdAt || 0) > 30 * 60 * 1000) cleanupImportSession(id, s.path);
    }
  }, 10 * 60 * 1000);
  if (typeof ooImportSweep.unref === 'function') ooImportSweep.unref();

  r.use(w);
}
