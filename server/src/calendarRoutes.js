/**
 * @fileoverview Календарь группы: личные напоминания + события по срокам задач доски
 * и назначений из объявлений. Подключается из `routes.js` через `appendCalendarRoutes`.
 *
 * Сроки (`due_at`) хранятся как «настенное» время без зоны (`YYYY-MM-DD` либо
 * `YYYY-MM-DDTHH:mm`) — так их ввёл автор. Поэтому день события берётся из первых
 * 10 символов строки, без парсинга в Date: это устойчиво к формату и не сдвигает
 * дедлайн из-за часового пояса сервера.
 */

import { getDb } from './db.js';
import { requireAuth } from './middleware.js';

/** Максимальный период выборки — защита от запроса «весь календарь целиком». */
const MAX_RANGE_DAYS = 92;
/** Предел событий на источник в одном ответе. */
const PER_SOURCE_LIMIT = 500;

const VALID_SOURCES = new Set(['all', 'reminders', 'assignments', 'board_tasks']);

function isBannedMember(db, groupId, userId) {
  const m = db
    .prepare(`SELECT banned_until FROM group_members WHERE group_id = ? AND user_id = ?`)
    .get(groupId, userId);
  if (!m || !m.banned_until) return false;
  return new Date(m.banned_until) > new Date();
}

function requireGroupMember(db, groupId, userId) {
  if (!Number.isInteger(groupId) || groupId <= 0) return { ok: false, error: 'Некорректная группа' };
  const m = db
    .prepare(`SELECT role FROM group_members WHERE group_id = ? AND user_id = ?`)
    .get(groupId, userId);
  if (!m || isBannedMember(db, groupId, userId)) return { ok: false, error: 'Нет доступа к чату' };
  return { ok: true, role: m.role };
}

function audienceFilterSql() {
  return `(ga.audience = 'all' OR EXISTS (
    SELECT 1 FROM announcement_recipients ar
    WHERE ar.announcement_id = ga.id AND ar.user_id = ?
  ))`;
}

/**
 * Диапазон `from`/`to` в днях (YYYY-MM-DD, включительно).
 * @returns {{ ok: true, fromDay: string, toDay: string } | { ok: false, error: string }}
 */
function parseRange(query) {
  const fromDay = String(query?.from || '').trim();
  const toDay = String(query?.to || '').trim();
  if (!isValidDay(fromDay) || !isValidDay(toDay)) {
    return { ok: false, error: 'Нужны from и to в формате YYYY-MM-DD' };
  }
  if (fromDay > toDay) return { ok: false, error: 'from не может быть позже to' };
  const spanDays =
    Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    return { ok: false, error: `Период не больше ${MAX_RANGE_DAYS} дней` };
  }
  return { ok: true, fromDay, toDay };
}

/** Календарно существующий день в формате YYYY-MM-DD (отсекает 2026-02-30). */
function isValidDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Срок напоминания: YYYY-MM-DD или YYYY-MM-DDTHH:mm (пробел вместо T тоже принимается).
 * @returns {{ ok: true, value: string } | { ok: false }}
 */
function normalizeDueAtRequired(raw) {
  if (raw == null || raw === '') return { ok: false };
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(raw).trim());
  if (!m || !isValidDay(m[1])) return { ok: false };
  if (m[2] == null) return { ok: true, value: m[1] };
  if (+m[2] > 23 || +m[3] > 59) return { ok: false };
  return { ok: true, value: `${m[1]}T${m[2]}:${m[3]}` };
}

function dayKeyFromDue(dueAt) {
  return dueAt ? String(dueAt).trim().slice(0, 10) : null;
}

/** Собственный % задачи: у задач со счётчиком считается из done/target (как в workspaceRoutes). */
function ownProgress(row) {
  const target = row.quantity_target;
  const done = row.quantity_done ?? 0;
  if (target != null && target > 0) return Math.min(100, Math.floor((100 * done) / target));
  return Math.min(100, Math.max(0, +(row.progress ?? 0)));
}

function reminderPayload(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    title: row.title,
    notes: row.notes || '',
    dueAt: row.due_at,
    doneAt: row.done_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * @param {import('express').Router} r
 * @param {import('socket.io').Server} io
 */
export function appendCalendarRoutes(r, io) {
  const db = getDb();

  /**
   * Агрегированные события календаря за период.
   * `sources` — `all` либо через запятую: `reminders`, `assignments`, `board_tasks`.
   * `onlyMine=1` — только задачи доски, где пользователь исполнитель или автор.
   */
  r.get('/groups/:id/calendar/events', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });

    const range = parseRange(req.query);
    if (!range.ok) return res.status(400).json({ error: range.error });

    const tokens = String(req.query.sources ?? 'all')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const unknown = tokens.find((t) => !VALID_SOURCES.has(t));
    if (unknown) return res.status(400).json({ error: `Неизвестный источник: ${unknown}` });

    const wantAll = tokens.length === 0 || tokens.includes('all');
    const wantReminders = wantAll || tokens.includes('reminders');
    const wantAssignments = wantAll || tokens.includes('assignments');
    const wantBoard = wantAll || tokens.includes('board_tasks');
    const onlyMine = req.query.onlyMine === '1' || req.query.onlyMine === 'true';

    const events = [];

    if (wantReminders) {
      const rows = db
        .prepare(
          `SELECT * FROM calendar_reminders
           WHERE group_id = ? AND user_id = ?
           AND substr(due_at, 1, 10) BETWEEN ? AND ?
           ORDER BY due_at ASC, id ASC
           LIMIT ?`
        )
        .all(gid, req.userId, range.fromDay, range.toDay, PER_SOURCE_LIMIT);
      for (const row of rows) {
        events.push({
          id: `reminder:${row.id}`,
          source: 'reminder',
          title: row.title,
          dueAt: row.due_at,
          day: dayKeyFromDue(row.due_at),
          status: row.done_at ? 'done' : 'todo',
          notes: row.notes || '',
          reminderId: row.id,
          doneAt: row.done_at || null,
        });
      }
    }

    /** `taskId|день` назначений на задачу доски — чтобы не дублировать её же как board_task. */
    const linkedTaskDays = new Set();

    if (wantAssignments) {
      const rows = db
        .prepare(
          `SELECT ga.id, ga.body, ga.due_at, ga.kind, ga.quantity_target, ga.linked_task_id,
                  aa.task_status, aa.progress, aa.quantity_done,
                  lt.title AS lt_title, lt.status AS lt_status, lt.progress AS lt_progress,
                  lt.quantity_target AS lt_quantity_target, lt.quantity_done AS lt_quantity_done,
                  lt.board_id AS lt_board_id, lb.name AS lt_board_name
           FROM group_announcements ga
           LEFT JOIN announcement_acks aa
             ON aa.announcement_id = ga.id AND aa.user_id = ?
           LEFT JOIN tasks lt ON lt.id = ga.linked_task_id
           LEFT JOIN task_boards lb ON lb.id = lt.board_id
           WHERE ga.group_id = ?
           AND ga.deleted_at IS NULL
           AND ga.kind IN ('assignment', 'linked_task')
           AND ga.due_at IS NOT NULL AND ga.due_at != ''
           AND ${audienceFilterSql()}
           AND substr(ga.due_at, 1, 10) BETWEEN ? AND ?
           ORDER BY ga.due_at ASC, ga.id ASC
           LIMIT ?`
        )
        .all(req.userId, gid, req.userId, range.fromDay, range.toDay, PER_SOURCE_LIMIT);

      for (const row of rows) {
        const isLinked = row.kind === 'linked_task' && row.lt_board_id != null;
        const body = String(row.body || '').trim();
        const day = dayKeyFromDue(row.due_at);
        // Прогресс задачи с доски живёт в самой задаче, быстрой задачи — в ответе участника.
        const progressSource = isLinked
          ? {
              progress: row.lt_progress,
              quantity_target: row.lt_quantity_target,
              quantity_done: row.lt_quantity_done,
            }
          : { progress: row.progress, quantity_target: row.quantity_target, quantity_done: row.quantity_done };

        if (isLinked) linkedTaskDays.add(`${row.linked_task_id}|${day}`);

        events.push({
          id: `assignment:${row.id}`,
          source: 'assignment',
          kind: row.kind,
          title: (isLinked ? row.lt_title : body) || body || 'Назначение',
          dueAt: row.due_at,
          day,
          status: isLinked ? row.lt_status : row.task_status || 'todo',
          progress: ownProgress(progressSource),
          quantityTarget: progressSource.quantity_target ?? null,
          quantityDone: progressSource.quantity_done ?? 0,
          announcementId: row.id,
          ...(isLinked
            ? {
                taskId: row.linked_task_id,
                boardId: row.lt_board_id,
                boardName: row.lt_board_name || '',
              }
            : {}),
        });
      }
    }

    if (wantBoard) {
      // Задачи закрытых паролем досок видны только своему исполнителю/автору:
      // иначе календарь раскрывал бы названия задач из защищённой доски.
      const visibility = onlyMine
        ? `(t.assignee_id = ? OR t.created_by = ?)`
        : `((b.password_hash IS NULL OR b.password_hash = '') OR t.assignee_id = ? OR t.created_by = ?)`;

      const rows = db
        .prepare(
          `SELECT t.id, t.title, t.status, t.progress, t.quantity_target, t.quantity_done,
                  t.due_at, t.assignee_id, t.created_by, t.board_id,
                  b.name AS board_name, b.password_hash
           FROM tasks t
           JOIN task_boards b ON b.id = t.board_id
           WHERE b.group_id = ?
           AND t.due_at IS NOT NULL AND t.due_at != ''
           AND substr(t.due_at, 1, 10) BETWEEN ? AND ?
           AND ${visibility}
           ORDER BY t.due_at ASC, t.id ASC
           LIMIT ?`
        )
        .all(gid, range.fromDay, range.toDay, req.userId, req.userId, PER_SOURCE_LIMIT);

      for (const row of rows) {
        const day = dayKeyFromDue(row.due_at);
        if (linkedTaskDays.has(`${row.id}|${day}`)) continue;
        events.push({
          id: `board_task:${row.id}`,
          source: 'board_task',
          title: row.title,
          dueAt: row.due_at,
          day,
          status: row.status,
          progress: ownProgress(row),
          quantityTarget: row.quantity_target ?? null,
          quantityDone: row.quantity_done ?? 0,
          taskId: row.id,
          boardId: row.board_id,
          boardName: row.board_name || '',
          boardHasPassword: !!(row.password_hash && String(row.password_hash).length),
          assigneeId: row.assignee_id ?? null,
          mine: row.assignee_id === req.userId || row.created_by === req.userId,
        });
      }
    }

    events.sort((a, b) => {
      const da = String(a.dueAt || '');
      const dbb = String(b.dueAt || '');
      if (da !== dbb) return da < dbb ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });

    res.json({ from: range.fromDay, to: range.toDay, events });
  });

  r.get('/groups/:id/calendar/reminders', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    const rows = db
      .prepare(
        `SELECT * FROM calendar_reminders
         WHERE group_id = ? AND user_id = ?
         ORDER BY due_at ASC, id ASC`
      )
      .all(gid, req.userId);
    res.json(rows.map(reminderPayload));
  });

  r.post('/groups/:id/calendar/reminders', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });

    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Укажите название напоминания' });
    if (title.length > 200) return res.status(400).json({ error: 'Название слишком длинное' });

    const due = normalizeDueAtRequired(req.body?.dueAt);
    if (!due.ok) return res.status(400).json({ error: 'Некорректный срок' });

    const notes = String(req.body?.notes || '').trim().slice(0, 2000);

    const info = db
      .prepare(
        `INSERT INTO calendar_reminders (group_id, user_id, title, notes, due_at)
         VALUES (?,?,?,?,?)`
      )
      .run(gid, req.userId, title, notes, due.value);

    const payload = reminderPayload(
      db.prepare(`SELECT * FROM calendar_reminders WHERE id = ?`).get(info.lastInsertRowid)
    );
    io.to(`user:${req.userId}`).emit('calendar:reminder', {
      groupId: gid,
      action: 'created',
      reminder: payload,
    });
    res.json(payload);
  });

  r.patch('/groups/:id/calendar/reminders/:reminderId', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const rid = +req.params.reminderId;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    if (!Number.isInteger(rid) || rid <= 0) {
      return res.status(400).json({ error: 'Некорректное напоминание' });
    }

    const row = db
      .prepare(`SELECT * FROM calendar_reminders WHERE id = ? AND group_id = ? AND user_id = ?`)
      .get(rid, gid, req.userId);
    if (!row) return res.status(404).json({ error: 'Напоминание не найдено' });

    let title = row.title;
    let notes = row.notes || '';
    let dueAt = row.due_at;
    let doneAt = row.done_at;

    if (req.body?.title !== undefined) {
      title = String(req.body.title || '').trim();
      if (!title) return res.status(400).json({ error: 'Укажите название напоминания' });
      if (title.length > 200) return res.status(400).json({ error: 'Название слишком длинное' });
    }
    if (req.body?.notes !== undefined) {
      notes = String(req.body.notes || '').trim().slice(0, 2000);
    }
    if (req.body?.dueAt !== undefined) {
      const due = normalizeDueAtRequired(req.body.dueAt);
      if (!due.ok) return res.status(400).json({ error: 'Некорректный срок' });
      dueAt = due.value;
    }
    if (req.body?.done !== undefined) {
      doneAt = req.body.done ? db.prepare(`SELECT datetime('now') AS d`).get().d : null;
    }

    db.prepare(
      `UPDATE calendar_reminders
       SET title = ?, notes = ?, due_at = ?, done_at = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(title, notes, dueAt, doneAt, rid);

    const payload = reminderPayload(
      db.prepare(`SELECT * FROM calendar_reminders WHERE id = ?`).get(rid)
    );
    io.to(`user:${req.userId}`).emit('calendar:reminder', {
      groupId: gid,
      action: 'updated',
      reminder: payload,
    });
    res.json(payload);
  });

  r.delete('/groups/:id/calendar/reminders/:reminderId', requireAuth, (req, res) => {
    const gid = +req.params.id;
    const rid = +req.params.reminderId;
    const chk = requireGroupMember(db, gid, req.userId);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
    if (!Number.isInteger(rid) || rid <= 0) {
      return res.status(400).json({ error: 'Некорректное напоминание' });
    }

    const info = db
      .prepare(`DELETE FROM calendar_reminders WHERE id = ? AND group_id = ? AND user_id = ?`)
      .run(rid, gid, req.userId);
    if (info.changes === 0) return res.status(404).json({ error: 'Напоминание не найдено' });

    io.to(`user:${req.userId}`).emit('calendar:reminder', {
      groupId: gid,
      action: 'deleted',
      reminderId: rid,
    });
    res.json({ ok: true });
  });
}
