/**
 * @fileoverview Разбор упоминаний в теле сообщения: теги вида `@username` (латиница, цифры, подчёркивание).
 * Используется при отправке сообщений для уведомлений упомянутых участников.
 */

const MENTION_RE = /@([a-zA-Z0-9_]+)/g;

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
