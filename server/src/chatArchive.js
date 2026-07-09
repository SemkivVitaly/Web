/**
 * @fileoverview Архив чатов для администратора сервера: перед удалением группы
 * и при правках/удалении сообщений в личных чатах пишем снимок в
 * `uploads/archives/` (JSON + копии файлов вложений). Данные не отдаются клиенту.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadsDir } from './upload.js';
import { normalizePossibleMultipartFilename } from './upload.js';
import { officeDiskPath, officeExtForDocType } from './officeFileStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Архивы рядом с БД: `server/data/archives` (не в uploads — orphan-cleanup их не трогает). */
export const archivesDir = path.join(__dirname, '..', 'data', 'archives');

// Создаём корень архивов при загрузке модуля.
try {
  fs.mkdirSync(archivesDir, { recursive: true });
} catch {
  /* ignore */
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeSegment(s, max = 48) {
  return String(s || '')
    .trim()
    .replace(/[^\w\u0400-\u04FF\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, max)
    .replace(/^_|_$/g, '') || 'x';
}

function userBrief(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    tag: u.tag,
    avatarFile: u.avatar_file || null,
  };
}

/**
 * Копирует произвольный файл в каталог архива.
 * @returns {string | null} имя файла в destDir
 */
function copyFileInto(destDir, srcAbs, preferredName) {
  if (!srcAbs || !fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) return null;
  ensureDir(destDir);
  let destName = preferredName || path.basename(srcAbs);
  destName = destName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'file';
  let dest = path.join(destDir, destName);
  if (fs.existsSync(dest)) {
    destName = `${Date.now()}-${destName}`;
    dest = path.join(destDir, destName);
  }
  try {
    fs.copyFileSync(srcAbs, dest);
    return destName;
  } catch (e) {
    console.error('[chatArchive] copy failed', srcAbs, e);
    return null;
  }
}

/**
 * Копирует файл из uploads в каталог архива (если есть).
 * @returns {string | null} относительное имя в `files/`
 */
function copyUploadInto(filesDir, storedName) {
  if (!storedName || typeof storedName !== 'string') return null;
  const base = path.basename(storedName);
  if (!base || base.includes('..')) return null;
  return copyFileInto(filesDir, path.join(uploadsDir, base), base);
}

/**
 * Копирует документ вкладки «Документы»: OnlyOffice-файл + y_state + превью.
 * @returns {object}
 */
function archiveCollabDocument(db, d, docsDir, filesDir) {
  const ext = officeExtForDocType(d.doc_type);
  const safeName = String(d.name || `doc-${d.id}`)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, 80);
  const officeSrc = officeDiskPath(d.id, d.doc_type);
  const officeCopied = copyFileInto(docsDir, officeSrc, `${d.id}-${safeName}.${ext}`);

  let yStateFile = null;
  if (d.y_state && (Buffer.isBuffer(d.y_state) ? d.y_state.length : d.y_state.byteLength) > 0) {
    ensureDir(docsDir);
    const yName = `${d.id}-${safeName}.ystate.bin`;
    try {
      fs.writeFileSync(path.join(docsDir, yName), Buffer.from(d.y_state));
      yStateFile = yName;
    } catch (e) {
      console.error('[chatArchive] y_state write failed', d.id, e);
    }
  }

  return {
    id: d.id,
    name: d.name,
    folderId: d.folder_id ?? null,
    docType: d.doc_type ?? null,
    description: d.description || '',
    createdBy: d.created_by ?? null,
    updatedAt: d.updated_at ?? null,
    createdAt: d.created_at ?? null,
    taskBoardOnly: d.task_board_only ?? null,
    officeRevision: d.office_revision ?? null,
    hasPassword: !!d.password_hash,
    previewStoredName: d.preview_stored_name ?? null,
    archivedPreview: d.preview_stored_name
      ? copyUploadInto(filesDir, d.preview_stored_name)
      : null,
    archivedOfficeFile: officeCopied ? `documents/${officeCopied}` : null,
    archivedYState: yStateFile ? `documents/${yStateFile}` : null,
  };
}

function attachmentSnapshot(a, filesDir) {
  const copied = copyUploadInto(filesDir, a.stored_name);
  const thumbCopied = a.thumb_stored_name
    ? copyUploadInto(filesDir, a.thumb_stored_name)
    : null;
  return {
    id: a.id,
    fileName: normalizePossibleMultipartFilename(a.file_name) || a.file_name,
    mimeType: a.mime_type,
    kind: a.kind,
    storedName: a.stored_name,
    thumbStoredName: a.thumb_stored_name || null,
    archivedFile: copied,
    archivedThumb: thumbCopied,
    transcript: a.transcript || null,
  };
}

/**
 * Полный снимок одного сообщения (для DM edit/delete и дампа группы).
 * @param {import('better-sqlite3').Database} db
 * @param {object} msg — строка messages
 * @param {string} filesDir
 */
export function snapshotMessageRow(db, msg, filesDir) {
  const sender = db.prepare(`SELECT * FROM users WHERE id = ?`).get(msg.sender_id);
  const atts = db
    .prepare(`SELECT * FROM message_attachments WHERE message_id = ? ORDER BY id`)
    .all(msg.id);
  const mentions = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.tag FROM message_mentions mm
       JOIN users u ON u.id = mm.user_id WHERE mm.message_id = ?`
    )
    .all(msg.id)
    .map(userBrief);
  const reactions = db
    .prepare(
      `SELECT mr.emoji, u.id, u.username, u.display_name, u.tag
       FROM message_reactions mr JOIN users u ON u.id = mr.user_id
       WHERE mr.message_id = ?`
    )
    .all(msg.id)
    .map((r) => ({ emoji: r.emoji, user: userBrief(r) }));

  let forwardPreview = null;
  if (msg.forward_preview_json) {
    try {
      forwardPreview = JSON.parse(msg.forward_preview_json);
    } catch {
      forwardPreview = msg.forward_preview_json;
    }
  }

  return {
    id: msg.id,
    groupId: msg.group_id ?? null,
    directId: msg.direct_id ?? null,
    sender: userBrief(sender),
    body: msg.body || '',
    createdAt: msg.created_at,
    editedAt: msg.edited_at || null,
    pinnedAt: msg.pinned_at || null,
    replyToId: msg.reply_to_id ?? null,
    threadRootId: msg.thread_root_id ?? null,
    forwardPreview,
    attachments: atts.map((a) => attachmentSnapshot(a, filesDir)),
    mentions,
    reactions,
  };
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Событие по личному чату (правка / удаление / очистка своих сообщений).
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   directId: number,
 *   event: string,
 *   actorUserId: number,
 *   messages?: object[],
 *   extra?: object,
 * }} opts
 * @returns {{ dir: string, eventFile: string } | null}
 */
export function archiveDirectEvent(db, opts) {
  try {
    const { directId, event, actorUserId, messages = [], extra = {} } = opts;
    const d = db.prepare(`SELECT * FROM direct_conversations WHERE id = ?`).get(directId);
    if (!d) return null;
    const low = db.prepare(`SELECT * FROM users WHERE id = ?`).get(d.user_low_id);
    const high = db.prepare(`SELECT * FROM users WHERE id = ?`).get(d.user_high_id);
    const actor = db.prepare(`SELECT * FROM users WHERE id = ?`).get(actorUserId);

    const dir = path.join(archivesDir, 'directs', `direct-${directId}`);
    const filesDir = path.join(dir, 'files');
    const eventsDir = path.join(dir, 'events');
    ensureDir(eventsDir);

    const snapMessages = messages.map((m) => snapshotMessageRow(db, m, filesDir));
    const eventName = `${stamp()}-${safeSegment(event, 32)}.json`;
    const eventFile = path.join(eventsDir, eventName);
    const payload = {
      archivedAt: new Date().toISOString(),
      event,
      directId,
      participants: [userBrief(low), userBrief(high)],
      actor: userBrief(actor),
      messageCount: snapMessages.length,
      messages: snapMessages,
      ...extra,
    };
    writeJson(eventFile, payload);

    const indexPath = path.join(dir, 'index.json');
    let index = { directId, participants: payload.participants, events: [] };
    if (fs.existsSync(indexPath)) {
      try {
        index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      } catch {
        /* keep default */
      }
    }
    if (!Array.isArray(index.events)) index.events = [];
    index.events.push({
      at: payload.archivedAt,
      event,
      actorUserId,
      file: `events/${eventName}`,
      messageCount: snapMessages.length,
    });
    index.updatedAt = payload.archivedAt;
    writeJson(indexPath, index);

    console.log(`[chatArchive] direct ${directId} ${event} → ${eventFile}`);
    return { dir, eventFile };
  } catch (e) {
    console.error('[chatArchive] archiveDirectEvent failed', e);
    return null;
  }
}

/**
 * Полный архив группы перед удалением.
 * @param {import('better-sqlite3').Database} db
 * @param {number} groupId
 * @param {number} actorUserId
 * @returns {{ dir: string } | null}
 */
export function archiveGroupFull(db, groupId, actorUserId) {
  try {
    const g = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(groupId);
    if (!g) return null;
    const actor = db.prepare(`SELECT * FROM users WHERE id = ?`).get(actorUserId);
    const creator = db.prepare(`SELECT * FROM users WHERE id = ?`).get(g.created_by);

    const folder = `group-${groupId}-${safeSegment(g.name)}-${stamp()}`;
    const dir = path.join(archivesDir, 'groups', folder);
    const filesDir = path.join(dir, 'files');
    ensureDir(dir);
    ensureDir(filesDir);

    const members = db
      .prepare(
        `SELECT u.*, gm.role, gm.joined_at, gm.banned_until
         FROM group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = ?`
      )
      .all(groupId)
      .map((r) => ({
        ...userBrief(r),
        role: r.role,
        joinedAt: r.joined_at,
        bannedUntil: r.banned_until,
      }));

    const bans = db
      .prepare(
        `SELECT gb.*, u.username, u.display_name, u.tag
         FROM group_bans gb JOIN users u ON u.id = gb.user_id
         WHERE gb.group_id = ?`
      )
      .all(groupId);

    const msgRows = db
      .prepare(`SELECT * FROM messages WHERE group_id = ? ORDER BY id ASC`)
      .all(groupId);
    const messages = msgRows.map((m) => snapshotMessageRow(db, m, filesDir));

    const audit = db
      .prepare(
        `SELECT * FROM audit_log WHERE target_kind = 'group' AND target_id = ? ORDER BY id ASC`
      )
      .all(groupId);

    let announcements = [];
    try {
      announcements = db
        .prepare(`SELECT * FROM group_announcements WHERE group_id = ? ORDER BY id ASC`)
        .all(groupId)
        .map((a) => {
          let atts = [];
          try {
            atts = db
              .prepare(`SELECT * FROM announcement_attachments WHERE announcement_id = ?`)
              .all(a.id)
              .map((x) => ({
                id: x.id,
                fileName: normalizePossibleMultipartFilename(x.file_name) || x.file_name,
                mimeType: x.mime_type,
                kind: x.kind,
                storedName: x.stored_name,
                archivedFile: copyUploadInto(filesDir, x.stored_name),
              }));
          } catch {
            /* table may be missing on very old DBs */
          }
          let acks = [];
          try {
            acks = db
              .prepare(
                `SELECT aa.*, u.username, u.display_name, u.tag
                 FROM announcement_acks aa JOIN users u ON u.id = aa.user_id
                 WHERE aa.announcement_id = ?`
              )
              .all(a.id);
          } catch {
            /* ignore */
          }
          let progressLog = [];
          try {
            progressLog = db
              .prepare(
                `SELECT * FROM announcement_progress_log WHERE announcement_id = ? ORDER BY id ASC`
              )
              .all(a.id);
          } catch {
            /* ignore */
          }
          return {
            id: a.id,
            kind: a.kind,
            audience: a.audience,
            body: a.body,
            createdAt: a.created_at,
            dueAt: a.due_at ?? null,
            deletedAt: a.deleted_at ?? null,
            authorId: a.author_id,
            linkedTaskId: a.linked_task_id ?? null,
            quantityTarget: a.quantity_target ?? null,
            attachments: atts,
            acks,
            progressLog,
          };
        });
    } catch (e) {
      console.error('[chatArchive] announcements snapshot skipped', e);
    }

    let boards = [];
    let tasksSummary = [];
    try {
      boards = db
        .prepare(`SELECT id, name, created_at, created_by FROM task_boards WHERE group_id = ?`)
        .all(groupId);
      tasksSummary = boards.map((b) => {
        const tasks = db
          .prepare(`SELECT * FROM tasks WHERE board_id = ? ORDER BY id`)
          .all(b.id);
        return { board: b, tasks };
      });
    } catch (e) {
      console.error('[chatArchive] tasks snapshot skipped', e);
    }

    // Вкладка «Документы»: папки + файлы OnlyOffice (data/collab-office-files) + y_state.
    const docsDir = path.join(dir, 'documents');
    ensureDir(docsDir);
    let collabFolders = [];
    try {
      collabFolders = db
        .prepare(`SELECT * FROM collab_folders WHERE group_id = ? ORDER BY id`)
        .all(groupId)
        .map((f) => ({
          id: f.id,
          parentId: f.parent_id ?? null,
          name: f.name,
          createdBy: f.created_by ?? null,
          createdAt: f.created_at ?? null,
          updatedAt: f.updated_at ?? null,
          hasPassword: !!f.password_hash,
        }));
    } catch (e) {
      console.error('[chatArchive] collab folders skipped', e);
    }

    let collabDocs = [];
    try {
      collabDocs = db
        .prepare(`SELECT * FROM collab_documents WHERE group_id = ?`)
        .all(groupId)
        .map((d) => archiveCollabDocument(db, d, docsDir, filesDir));
    } catch (e) {
      console.error('[chatArchive] collab snapshot skipped', e);
    }

    const manifest = {
      archivedAt: new Date().toISOString(),
      reason: 'group_delete',
      group: {
        id: g.id,
        name: g.name,
        createdAt: g.created_at,
        createdBy: userBrief(creator),
        joinCode: g.join_code || null,
        forwardLocked: !!g.forward_locked,
        invitePolicy: g.invite_policy || 'all',
        hasPassword: !!g.password_hash,
      },
      deletedBy: userBrief(actor),
      counts: {
        members: members.length,
        messages: messages.length,
        auditLog: audit.length,
        announcements: announcements.length,
        boards: boards.length,
        collabDocuments: collabDocs.length,
      },
      files: 'files/',
      note: 'Архив для администратора сервера. Восстановление — вручную из JSON и files/.',
    };

    writeJson(path.join(dir, 'manifest.json'), {
      ...manifest,
      counts: {
        ...manifest.counts,
        collabFolders: collabFolders.length,
        collabDocuments: collabDocs.length,
        collabOfficeFiles: collabDocs.filter((d) => d.archivedOfficeFile).length,
      },
      documents: 'documents/',
    });
    writeJson(path.join(dir, 'members.json'), members);
    writeJson(path.join(dir, 'bans.json'), bans);
    writeJson(path.join(dir, 'messages.json'), messages);
    writeJson(path.join(dir, 'audit-log.json'), audit);
    writeJson(path.join(dir, 'announcements.json'), announcements);
    writeJson(path.join(dir, 'tasks-summary.json'), tasksSummary);
    writeJson(path.join(dir, 'collab-folders.json'), collabFolders);
    writeJson(path.join(dir, 'collab-documents.json'), collabDocs);

    console.log(`[chatArchive] group ${groupId} full archive → ${dir}`);
    return { dir };
  } catch (e) {
    console.error('[chatArchive] archiveGroupFull failed', e);
    return null;
  }
}

/**
 * Архив набора сообщений (очистка истории) — группа или личка.
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   chatKind: 'group' | 'direct',
 *   chatId: number,
 *   event: string,
 *   actorUserId: number,
 *   messageRows: object[],
 *   extra?: object,
 * }} opts
 */
export function archiveMessagesBulk(db, opts) {
  try {
    const { chatKind, chatId, event, actorUserId, messageRows, extra = {} } = opts;
    if (!messageRows?.length) return null;

    if (chatKind === 'direct') {
      return archiveDirectEvent(db, {
        directId: chatId,
        event,
        actorUserId,
        messages: messageRows,
        extra,
      });
    }

    const g = db.prepare(`SELECT id, name FROM groups WHERE id = ?`).get(chatId);
    const actor = db.prepare(`SELECT * FROM users WHERE id = ?`).get(actorUserId);

    // Одиночные удаления — в постоянную папку группы с events/; массовая очистка — отдельный снимок.
    if (event === 'message_delete' && messageRows.length === 1) {
      const dir = path.join(archivesDir, 'groups', `group-${chatId}`);
      const filesDir = path.join(dir, 'files');
      const eventsDir = path.join(dir, 'events');
      ensureDir(eventsDir);
      const messages = messageRows.map((m) => snapshotMessageRow(db, m, filesDir));
      const eventName = `${stamp()}-message_delete.json`;
      const eventFile = path.join(eventsDir, eventName);
      writeJson(eventFile, {
        archivedAt: new Date().toISOString(),
        event,
        groupId: chatId,
        groupName: g?.name || null,
        deletedBy: userBrief(actor),
        messages,
        ...extra,
      });
      const indexPath = path.join(dir, 'index.json');
      let index = { groupId: chatId, groupName: g?.name || null, events: [] };
      if (fs.existsSync(indexPath)) {
        try {
          index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        } catch {
          /* keep */
        }
      }
      if (!Array.isArray(index.events)) index.events = [];
      index.events.push({
        at: new Date().toISOString(),
        event,
        actorUserId,
        file: `events/${eventName}`,
        messageCount: messages.length,
      });
      index.updatedAt = new Date().toISOString();
      writeJson(indexPath, index);
      console.log(`[chatArchive] group ${chatId} message_delete → ${eventFile}`);
      return { dir, eventFile };
    }

    const folder = `group-${chatId}-clear-${stamp()}`;
    const dir = path.join(archivesDir, 'groups', folder);
    const filesDir = path.join(dir, 'files');
    ensureDir(dir);
    const messages = messageRows.map((m) => snapshotMessageRow(db, m, filesDir));
    writeJson(path.join(dir, 'manifest.json'), {
      archivedAt: new Date().toISOString(),
      reason: event,
      groupId: chatId,
      groupName: g?.name || null,
      deletedBy: userBrief(actor),
      messageCount: messages.length,
      ...extra,
    });
    writeJson(path.join(dir, 'messages.json'), messages);
    console.log(`[chatArchive] group ${chatId} ${event} → ${dir}`);
    return { dir };
  } catch (e) {
    console.error('[chatArchive] archiveMessagesBulk failed', e);
    return null;
  }
}
