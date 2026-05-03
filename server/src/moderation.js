/**
 * @fileoverview Решение, нужно ли применять групповую маскировку нецензурной лексики для текущего зрителя.
 *
 * Учитывается флаг `groups.moderate_profanity`, личные чаты не затрагиваются (`groupId == null`).
 * Автор своего сообщения/контента всегда видит оригинал; остальные участники (включая админов) — текст после `maskProfanity`.
 * Забаненные до `banned_until` не получают маскировку (для них отдельная политика отображения).
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number | null} groupId
 * @param {number | null} viewerUserId
 * @param {number | null} [contentAuthorUserId] — если совпадает с зрителем, маска не нужна
 * @returns {boolean}
 */
export function shouldMaskGroupTextForViewer(db, groupId, viewerUserId, contentAuthorUserId = null) {
  if (groupId == null || viewerUserId == null) return false;
  if (contentAuthorUserId != null && viewerUserId === contentAuthorUserId) return false;
  const g = db.prepare(`SELECT moderate_profanity FROM groups WHERE id = ?`).get(groupId);
  if (!g?.moderate_profanity) return false;
  const m = db
    .prepare(`SELECT banned_until FROM group_members WHERE group_id = ? AND user_id = ?`)
    .get(groupId, viewerUserId);
  if (!m) return false;
  if (m.banned_until && new Date(m.banned_until) > new Date()) return false;
  return true;
}
