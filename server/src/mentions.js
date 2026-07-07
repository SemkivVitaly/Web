/**
 * @fileoverview Разбор упоминаний в теле сообщения: теги вида `@username` (латиница, цифры, подчёркивание).
 * Используется при отправке сообщений для уведомлений упомянутых участников.
 */

const MENTION_RE = /@([a-zA-Z0-9_]+)/g;

/** Зарезервированный тег `@all` — уведомляет всех участников группы. */
export const MENTION_ALL_TAG = 'all';

/**
 * @param {string} body — текст сообщения
 * @returns {string[]} уникальные теги без `@`, в нижнем регистре
 */
export function parseMentionTags(body) {
  if (!body || typeof body !== 'string') return [];
  const tags = new Set();
  let m;
  while ((m = MENTION_RE.exec(body)) !== null) {
    tags.add(m[1].toLowerCase());
  }
  return [...tags];
}

/** Подходит ли строка автодополнения для пункта `@all`. */
export function mentionAllMatchesAutocompleteQuery(query) {
  const q = String(query ?? '').toLowerCase();
  return q === '' || 'all'.startsWith(q);
}

/**
 * Записывает упоминания группового сообщения: `@tag`, `@all`, id с клиента.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {number} opts.messageId
 * @param {number} opts.groupId
 * @param {string} opts.body
 * @param {number[]} opts.extraUserIds
 * @param {(groupId: number, userId: number) => boolean} opts.isActiveMember
 */
export function syncGroupMessageMentions({ db, messageId, groupId, body, extraUserIds, isActiveMember }) {
  const tags = parseMentionTags(body);
  const hasAll = tags.includes(MENTION_ALL_TAG);
  const userTags = tags.filter((t) => t !== MENTION_ALL_TAG);
  const mentionIds = new Set();

  if (hasAll) {
    const rows = db.prepare(`SELECT user_id FROM group_members WHERE group_id = ?`).all(groupId);
    for (const r of rows) {
      if (isActiveMember(groupId, r.user_id)) mentionIds.add(r.user_id);
    }
  }

  for (const t of userTags) {
    const u = db.prepare(`SELECT id FROM users WHERE tag = ? COLLATE NOCASE`).get(t);
    if (u && isActiveMember(groupId, u.id)) mentionIds.add(u.id);
  }

  for (const uid of extraUserIds) {
    if (isActiveMember(groupId, uid)) mentionIds.add(uid);
  }

  const ins = db.prepare(`INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)`);
  for (const uid of mentionIds) ins.run(messageId, uid);
}

/**
 * Дополнительные id упомянутых пользователей с клиента (когда в текст вставлено имя, а не `@tag`).
 * Принимает JSON-массив чисел в поле `mentionUserIds` или `mention_user_ids` (FormData / JSON body).
 *
 * @param {object | null | undefined} body — `req.body`
 * @returns {number[]} уникальные положительные целые id
 */
export function parseExtraMentionUserIdsFromBody(body) {
  if (!body || typeof body !== 'object') return [];
  const raw = body.mentionUserIds ?? body.mention_user_ids;
  if (raw == null) return [];
  let arr;
  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    const s = String(raw).trim();
    if (!s) return [];
    try {
      const j = JSON.parse(s);
      arr = Array.isArray(j) ? j : null;
    } catch {
      return [];
    }
  }
  if (!arr) return [];
  const out = new Set();
  for (const x of arr) {
    const n = typeof x === 'number' ? x : parseInt(String(x), 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return [...out];
}
