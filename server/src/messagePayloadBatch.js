/**
 * @fileoverview Пакетная сборка JSON payload сообщений (без N+1 на ленту).
 */

import { attachmentApiUrl, uploadBasenameApiUrl } from './fileAccess.js';
import { normalizePossibleMultipartFilename } from './upload.js';

/**
 * @param {number[]} ids
 */
function inClause(ids) {
  const uniq = [...new Set(ids.filter((x) => Number.isFinite(x) && x > 0))];
  if (!uniq.length) return { sql: '0', params: [] };
  return { sql: uniq.map(() => '?').join(','), params: uniq };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<number, object>} userMap
 * @param {number} userId
 */
function rowUserFromMap(db, userMap, userId) {
  let u = userMap[userId];
  if (!u) {
    u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    if (u) userMap[userId] = u;
  }
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    tag: u.tag,
    bio: u.bio || '',
    avatarUrl: u.avatar_file ? uploadBasenameApiUrl(u.avatar_file) : null,
    createdAt: u.created_at,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} rows
 * @param {number | null | undefined} viewerUserId
 * @param {object} ctx
 * @returns {Map<number, object>}
 */
export function buildMessagesPayloadBatch(db, rows, viewerUserId, ctx) {
  const out = new Map();
  if (!rows?.length) return out;

  const msgIds = rows.map((r) => r.id);
  const senderIds = [...new Set(rows.map((r) => r.sender_id))];
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean))];

  const userMap = {};
  {
    const { sql, params } = inClause(senderIds);
    if (params.length) {
      for (const u of db.prepare(`SELECT * FROM users WHERE id IN (${sql})`).all(...params)) {
        userMap[u.id] = u;
      }
    }
  }

  const attachmentsByMsg = new Map();
  {
    const { sql, params } = inClause(msgIds);
    if (params.length) {
      for (const a of db
        .prepare(`SELECT * FROM message_attachments WHERE message_id IN (${sql}) ORDER BY id ASC`)
        .all(...params)) {
        if (!attachmentsByMsg.has(a.message_id)) attachmentsByMsg.set(a.message_id, []);
        attachmentsByMsg.get(a.message_id).push(a);
      }
    }
  }

  const mentionsByMsg = new Map();
  {
    const { sql, params } = inClause(msgIds);
    if (params.length) {
      for (const m of db
        .prepare(`SELECT message_id, user_id FROM message_mentions WHERE message_id IN (${sql})`)
        .all(...params)) {
        if (!mentionsByMsg.has(m.message_id)) mentionsByMsg.set(m.message_id, []);
        mentionsByMsg.get(m.message_id).push(m.user_id);
      }
    }
  }

  const importantSet = new Set();
  if (viewerUserId != null) {
    const { sql, params } = inClause(msgIds);
    if (params.length) {
      for (const r of db
        .prepare(
          `SELECT message_id FROM user_message_important WHERE user_id = ? AND message_id IN (${sql})`
        )
        .all(viewerUserId, ...params)) {
        importantSet.add(r.message_id);
      }
    }
  }

  const reactionsByMsg = new Map();
  const reactionUserIds = new Set();
  {
    const { sql, params } = inClause(msgIds);
    if (params.length) {
      for (const r of db
        .prepare(
          `SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id IN (${sql}) ORDER BY created_at ASC`
        )
        .all(...params)) {
        if (!reactionsByMsg.has(r.message_id)) reactionsByMsg.set(r.message_id, []);
        reactionsByMsg.get(r.message_id).push(r);
        reactionUserIds.add(r.user_id);
      }
    }
  }
  for (const uid of reactionUserIds) {
    if (!userMap[uid]) {
      const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(uid);
      if (u) userMap[uid] = u;
    }
  }

  const parentById = new Map();
  const parentAttCount = new Map();
  if (replyIds.length) {
    const { sql, params } = inClause(replyIds);
    for (const p of db.prepare(`SELECT * FROM messages WHERE id IN (${sql})`).all(...params)) {
      parentById.set(p.id, p);
      if (!userMap[p.sender_id]) {
        const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(p.sender_id);
        if (u) userMap[p.sender_id] = u;
      }
    }
    for (const c of db
      .prepare(
        `SELECT message_id, COUNT(*) AS c FROM message_attachments WHERE message_id IN (${sql}) GROUP BY message_id`
      )
      .all(...params)) {
      parentAttCount.set(c.message_id, c.c);
    }
  }

  const workspaceLinksByMsg = new Map();
  {
    const { sql, params } = inClause(msgIds);
    if (params.length) {
      for (const r of db
        .prepare(
          `SELECT l.id, l.message_id, l.link_kind, l.entity_id,
            COALESCE(NULLIF(TRIM(t.title), ''), NULLIF(TRIM(d.name), ''), '') AS title
           FROM message_workspace_links l
           LEFT JOIN tasks t ON l.link_kind = 'task' AND l.entity_id = t.id
           LEFT JOIN collab_documents d ON l.link_kind = 'collab_document' AND l.entity_id = d.id
           WHERE l.message_id IN (${sql})`
        )
        .all(...params)) {
        if (!workspaceLinksByMsg.has(r.message_id)) workspaceLinksByMsg.set(r.message_id, []);
        workspaceLinksByMsg.get(r.message_id).push({
          id: r.id,
          kind: r.link_kind,
          entityId: r.entity_id,
          title:
            String(r.title || '').trim() ||
            (r.link_kind === 'task' ? 'Задача' : 'Документ'),
        });
      }
    }
  }

  for (const msg of rows) {
    const sender = rowUserFromMap(db, userMap, msg.sender_id);
    const atts = attachmentsByMsg.get(msg.id) || [];
    const mentions = mentionsByMsg.get(msg.id) || [];
    const chatEvent = msg.group_id ? ctx.groupMemberChatEventKind(msg.body) : null;

    let replyTo = null;
    if (msg.reply_to_id != null) {
      const parent = parentById.get(msg.reply_to_id);
      if (parent) {
        const attC = parentAttCount.get(msg.reply_to_id) || 0;
        let preview = String(parent.body || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 160);
        if (!preview) {
          if (attC > 1) preview = `${attC} вложения`;
          else if (attC === 1) preview = 'Вложение';
          else preview = '(пусто)';
        }
        replyTo = {
          id: parent.id,
          sender: rowUserFromMap(db, userMap, parent.sender_id),
          bodyPreview: preview,
          hasAttachments: attC > 0,
        };
      }
    }

    const reactionsRaw = reactionsByMsg.get(msg.id) || [];
    const byEmoji = new Map();
    for (const r of reactionsRaw) {
      if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
      byEmoji.get(r.emoji).push(r.user_id);
    }
    const reactions = [...byEmoji.entries()].map(([emoji, userIds]) => ({
      emoji,
      users: userIds.map((uid) => rowUserFromMap(db, userMap, uid)).filter(Boolean),
    }));

    out.set(msg.id, {
      id: msg.id,
      groupId: msg.group_id,
      directId: msg.direct_id,
      sender,
      body: msg.body,
      ...(chatEvent ? { chatEvent } : {}),
      pinnedAt: ctx.sqliteUtcToIso(msg.pinned_at) ?? msg.pinned_at,
      createdAt: ctx.sqliteUtcToIso(msg.created_at) ?? msg.created_at,
      editedAt: msg.edited_at ? ctx.sqliteUtcToIso(msg.edited_at) ?? msg.edited_at : null,
      replyTo,
      forwardFrom: ctx.buildForwardFromForPayload(msg, viewerUserId),
      reactions,
      importantForMe: viewerUserId != null && importantSet.has(msg.id),
      attachmentIds: atts.map((a) => a.id),
      attachments: atts.map((a) => ({
        id: a.id,
        url: attachmentApiUrl(a.id),
        thumbUrl: a.thumb_stored_name ? `${attachmentApiUrl(a.id)}?thumb=1` : null,
        fileName: normalizePossibleMultipartFilename(a.file_name) || a.file_name,
        mimeType: a.mime_type,
        kind: a.kind,
        transcript: a.transcript || null,
      })),
      mentionUserIds: mentions,
      outboundRead: ctx.outboundReadReceipt(msg, viewerUserId),
      threadRootId: msg.thread_root_id ?? null,
      workspaceLinks: workspaceLinksByMsg.get(msg.id) || [],
    });
  }

  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} rows
 * @param {number | null | undefined} viewerUserId
 * @param {object} ctx
 * @returns {object[]}
 */
export function buildMessagesPayloadList(db, rows, viewerUserId, ctx) {
  const map = buildMessagesPayloadBatch(db, rows, viewerUserId, ctx);
  return rows.map((r) => map.get(r.id)).filter(Boolean);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} msg
 * @param {number | null | undefined} viewerUserId
 * @param {object} ctx
 */
export function buildMessagePayloadOne(db, msg, viewerUserId, ctx) {
  const list = buildMessagesPayloadList(db, [msg], viewerUserId, ctx);
  return list[0] ?? null;
}
