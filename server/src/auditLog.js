/**
 * @fileoverview Запись в таблицу `audit_log`: действия модераторов и значимые события (группа, документ, вложение и т.д.).
 * Поля `target_kind` / `target_id` согласованы с выдачей `GET /api/groups/:id/audit-log`.
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} actorId — кто совершил действие (`actor_user_id` в БД)
 * @param {string} action — машинное имя события
 * @param {string | null} targetKind — например `group`, `collab_document`
 * @param {number | null} targetId
 * @param {Record<string, unknown> | null | undefined} meta — сериализуется в JSON
 */
export function writeAudit(db, actorId, action, targetKind, targetId, meta) {
  try {
    db.prepare(
      `INSERT INTO audit_log (actor_user_id, action, target_kind, target_id, meta_json) VALUES (?,?,?,?,?)`
    ).run(actorId, action, targetKind ?? null, targetId ?? null, meta != null ? JSON.stringify(meta) : null);
  } catch (e) {
    console.error('[audit]', e);
  }
}
