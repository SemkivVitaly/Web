/**
 * @fileoverview Проверки членства перед `socket.join` на `group:{id}` и `direct:{id}`.
 * Аутентификация сокета не заменяет авторизацию комнаты — без этих функций клиент мог бы слушать чужие чаты.
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} участник группы и не забанен до `banned_until`
 */
export function canUserJoinGroupSocketRoom(db, groupId, userId) {
  const m = db
    .prepare(
      `SELECT banned_until FROM group_members WHERE group_id = ? AND user_id = ?`
    )
    .get(groupId, userId);
  if (!m) return false;
  if (m.banned_until && new Date(m.banned_until) > new Date()) return false;
  return true;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {boolean} пользователь — одна из сторон пары direct_conversations
 */
export function canUserJoinDirectSocketRoom(db, directId, userId) {
  const d = db
    .prepare(`SELECT user_low_id, user_high_id FROM direct_conversations WHERE id = ?`)
    .get(directId);
  if (!d) return false;
  return d.user_low_id === userId || d.user_high_id === userId;
}
