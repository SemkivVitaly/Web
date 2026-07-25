/**
 * @fileoverview Календарь группы: сетка месяца, фильтр источников событий,
 * личные напоминания (CRUD) и сроки назначений / задач с доски.
 *
 * Сроки приходят с сервера как «настенное» время без зоны (`YYYY-MM-DD` либо
 * `YYYY-MM-DDTHH:mm`), поэтому день и просрочка считаются сравнением строк —
 * без `new Date`, который сдвинул бы дедлайн на часовой пояс.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from '../api';
import { uiAlert, uiConfirm } from '../ui/dialogs';
import type { CalendarEvent, CalendarEventSource, CalendarReminder } from '../types';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const CELL_COUNT = 42;

type SourceFilter = 'all' | CalendarEventSource;

const SOURCE_FILTERS: { id: SourceFilter; label: string; hint: string }[] = [
  { id: 'all', label: 'Все', hint: 'Напоминания, назначения и задачи с доски' },
  { id: 'reminder', label: 'Мои напоминания', hint: 'Только то, что вы создали себе сами' },
  { id: 'assignment', label: 'Назначения', hint: 'Задачи, выданные через объявления' },
  { id: 'board_task', label: 'Задачи с доски', hint: 'Задачи досок группы со сроком' },
];

const SOURCE_QUERY: Record<SourceFilter, string> = {
  all: 'all',
  reminder: 'reminders',
  assignment: 'assignments',
  board_task: 'board_tasks',
};

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function ymd(y: number, m0: number, d: number) {
  return `${y}-${pad2(m0 + 1)}-${pad2(d)}`;
}

function parseYmd(s: string): { y: number; m0: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  return m ? { y: +m[1], m0: +m[2] - 1, d: +m[3] } : null;
}

function monthLabel(y: number, m0: number) {
  return new Date(y, m0, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
}

function dayLabel(day: string) {
  const p = parseYmd(day);
  if (!p) return day;
  return new Date(p.y, p.m0, p.d).toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

/** `2026-07-25T18:00` → «25.07 18:00»; дата без времени → «25.07». */
function formatDueShort(dueAt: string) {
  const p = parseYmd(String(dueAt).slice(0, 10));
  const base = p ? `${pad2(p.d)}.${pad2(p.m0 + 1)}` : String(dueAt).slice(0, 10);
  const time = /[T ](\d{2}:\d{2})/.exec(String(dueAt))?.[1];
  return time ? `${base} ${time}` : base;
}

function sourceLabel(source: CalendarEventSource) {
  if (source === 'reminder') return 'Напоминание';
  if (source === 'assignment') return 'Назначение';
  return 'Задача с доски';
}

function statusLabel(status: string | null | undefined) {
  if (status === 'done') return 'Готово';
  if (status === 'in_progress') return 'В работе';
  if (status === 'review') return 'На проверке';
  if (status === 'todo') return 'К выполнению';
  return status || '';
}

function progressLabel(ev: CalendarEvent) {
  if (ev.source === 'reminder') return '';
  if (ev.quantityTarget != null && ev.quantityTarget > 0) {
    return `${ev.quantityDone ?? 0}/${ev.quantityTarget}`;
  }
  return ev.progress != null ? `${ev.progress}%` : '';
}

/** Локальное «сейчас» в том же виде, в каком хранятся сроки. */
function nowWallClock() {
  const n = new Date();
  return {
    day: ymd(n.getFullYear(), n.getMonth(), n.getDate()),
    minute: `${ymd(n.getFullYear(), n.getMonth(), n.getDate())}T${pad2(n.getHours())}:${pad2(n.getMinutes())}`,
  };
}

function isOverdue(ev: CalendarEvent, now: { day: string; minute: string }) {
  if (ev.status === 'done') return false;
  const s = String(ev.dueAt || '');
  if (!/[T ]\d{2}:\d{2}/.test(s)) return s.slice(0, 10) < now.day;
  return s.replace(' ', 'T').slice(0, 16) < now.minute;
}

type MonthCell = { day: number; date: string; inMonth: boolean };

/** Всегда 42 ячейки (6 недель), неделя с понедельника — высота сетки не «прыгает». */
function buildMonthCells(y: number, m0: number): MonthCell[] {
  const startOffset = (new Date(y, m0, 1).getDay() + 6) % 7;
  const cells: MonthCell[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const d = new Date(y, m0, i - startOffset + 1);
    cells.push({
      day: d.getDate(),
      date: ymd(d.getFullYear(), d.getMonth(), d.getDate()),
      inMonth: d.getMonth() === m0 && d.getFullYear() === y,
    });
  }
  return cells;
}

/** Значение для `datetime-local`: дате без времени подставляем 09:00. */
function dueInputValue(dueAt: string) {
  const s = String(dueAt || '').trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T09:00`;
  return '';
}

export function GroupCalendarModal({
  groupId,
  socket,
  onClose,
  onOpenTask,
  onOpenAssignments,
}: {
  groupId: number;
  socket: Socket | null;
  onClose: () => void;
  onOpenTask?: (taskId: number) => void;
  onOpenAssignments?: () => void;
}) {
  const today = useMemo(() => nowWallClock().day, []);

  const [viewY, setViewY] = useState(() => new Date().getFullYear());
  const [viewM0, setViewM0] = useState(() => new Date().getMonth());
  const [selectedDay, setSelectedDay] = useState(today);
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [onlyMine, setOnlyMine] = useState(false);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const [formTitle, setFormTitle] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formDue, setFormDue] = useState(() => `${today}T09:00`);
  const [formBusy, setFormBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const now = nowWallClock();
  const cells = useMemo(() => buildMonthCells(viewY, viewM0), [viewY, viewM0]);
  const from = cells[0].date;
  const to = cells[CELL_COUNT - 1].date;
  const showsBoardTasks = filter === 'all' || filter === 'board_task';

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const q = new URLSearchParams({ from, to, sources: SOURCE_QUERY[filter] });
      if (onlyMine) q.set('onlyMine', '1');
      const data = await api<{ events: CalendarEvent[] }>(
        `/api/groups/${groupId}/calendar/events?${q}`
      );
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch (e) {
      setErr((e as Error).message || 'Не удалось загрузить календарь');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [groupId, from, to, filter, onlyMine]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onChanged = (payload: { groupId?: number }) => {
      if (payload?.groupId === groupId) void load();
    };
    socket.on('calendar:reminder', onChanged);
    socket.on('tasks:refresh', onChanged);
    return () => {
      socket.off('calendar:reminder', onChanged);
      socket.off('tasks:refresh', onChanged);
    };
  }, [socket, groupId, load]);

  // Escape закрывает календарь, но не когда поверх него открыт диалог (подтверждение удаления).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const backdrops = document.querySelectorAll('.modal-backdrop');
      if (backdrops.length && backdrops[backdrops.length - 1] !== backdropRef.current) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Форма следует за выбранным днём, но сохраняет уже набранное время.
  useEffect(() => {
    if (editingId != null) return;
    setFormDue((prev) => `${selectedDay}T${/T(\d{2}:\d{2})/.exec(prev)?.[1] || '09:00'}`);
  }, [selectedDay, editingId]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const day = ev.day || String(ev.dueAt).slice(0, 10);
      const list = map.get(day);
      if (list) list.push(ev);
      else map.set(day, [ev]);
    }
    return map;
  }, [events]);

  const dayEvents = useMemo(
    () => (byDay.get(selectedDay) ?? []).slice().sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt))),
    [byDay, selectedDay]
  );

  function goToDay(date: string) {
    setSelectedDay(date);
    const p = parseYmd(date);
    if (p && (p.y !== viewY || p.m0 !== viewM0)) {
      setViewY(p.y);
      setViewM0(p.m0);
    }
  }

  function shiftMonth(delta: number) {
    const d = new Date(viewY, viewM0 + delta, 1);
    const y = d.getFullYear();
    const m0 = d.getMonth();
    setViewY(y);
    setViewM0(m0);
    const parsed = parseYmd(selectedDay);
    const lastDay = new Date(y, m0 + 1, 0).getDate();
    setSelectedDay(ymd(y, m0, parsed ? Math.min(parsed.d, lastDay) : 1));
  }

  function resetForm() {
    setEditingId(null);
    setFormTitle('');
    setFormNotes('');
    setFormDue(`${selectedDay}T09:00`);
  }

  async function submitReminder(e: FormEvent) {
    e.preventDefault();
    const title = formTitle.trim();
    if (!title) {
      await uiAlert('Укажите название напоминания');
      return;
    }
    if (!formDue.trim()) {
      await uiAlert('Укажите срок');
      return;
    }
    setFormBusy(true);
    try {
      const path =
        editingId != null
          ? `/api/groups/${groupId}/calendar/reminders/${editingId}`
          : `/api/groups/${groupId}/calendar/reminders`;
      const saved = await api<CalendarReminder>(path, {
        method: editingId != null ? 'PATCH' : 'POST',
        json: { title, notes: formNotes.trim(), dueAt: formDue.trim() },
      });
      resetForm();
      // Иначе только что созданное напоминание не появится под текущим фильтром.
      if (filter !== 'all' && filter !== 'reminder') setFilter('all');
      goToDay(String(saved.dueAt).slice(0, 10));
      await load();
    } catch (er) {
      await uiAlert((er as Error).message);
    } finally {
      setFormBusy(false);
    }
  }

  async function patchReminder(reminderId: number, json: Record<string, unknown>) {
    try {
      await api(`/api/groups/${groupId}/calendar/reminders/${reminderId}`, { method: 'PATCH', json });
      await load();
    } catch (er) {
      await uiAlert((er as Error).message);
    }
  }

  async function removeReminder(ev: CalendarEvent) {
    if (ev.reminderId == null) return;
    const ok = await uiConfirm(`Удалить напоминание «${ev.title}»?`, {
      title: 'Удаление напоминания',
      danger: true,
      okText: 'Удалить',
    });
    if (!ok) return;
    try {
      await api(`/api/groups/${groupId}/calendar/reminders/${ev.reminderId}`, { method: 'DELETE' });
      if (editingId === ev.reminderId) resetForm();
      await load();
    } catch (er) {
      await uiAlert((er as Error).message);
    }
  }

  function startEdit(ev: CalendarEvent) {
    if (ev.reminderId == null) return;
    setEditingId(ev.reminderId);
    setFormTitle(ev.title);
    setFormNotes(ev.notes || '');
    setFormDue(dueInputValue(ev.dueAt));
    goToDay(ev.day || String(ev.dueAt).slice(0, 10));
  }

  return (
    <div
      ref={backdropRef}
      className="modal-backdrop lc-calendar-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal lc-calendar-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-calendar-title"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lc-calendar-header">
          <h3 id="lc-calendar-title">Календарь</h3>
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>

        <div className="lc-calendar-filters" role="group" aria-label="Что показывать в календаре">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? 'primary' : ''}
              title={f.hint}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {showsBoardTasks && (
          <label className="lc-calendar-only-mine">
            <input
              type="checkbox"
              checked={onlyMine}
              onChange={(e) => setOnlyMine(e.target.checked)}
            />
            Только задачи, где я исполнитель или автор
          </label>
        )}

        <div className="lc-calendar-month-nav">
          <button type="button" onClick={() => shiftMonth(-1)} aria-label="Предыдущий месяц">
            ‹
          </button>
          <div className="lc-calendar-month-label">{monthLabel(viewY, viewM0)}</div>
          <button type="button" onClick={() => shiftMonth(1)} aria-label="Следующий месяц">
            ›
          </button>
          <button
            type="button"
            className="lc-calendar-today-btn"
            onClick={() => {
              const p = parseYmd(today)!;
              setViewY(p.y);
              setViewM0(p.m0);
              setSelectedDay(today);
            }}
          >
            Сегодня
          </button>
        </div>

        <div className="lc-calendar-grid">
          {WEEKDAYS.map((w) => (
            <div key={w} className="lc-calendar-weekday" aria-hidden="true">
              {w}
            </div>
          ))}
          {cells.map((cell) => {
            const list = byDay.get(cell.date) ?? [];
            const sources = new Set(list.map((ev) => ev.source));
            const overdue = list.some((ev) => isOverdue(ev, now));
            return (
              <button
                key={cell.date}
                type="button"
                aria-pressed={cell.date === selectedDay}
                aria-label={`${dayLabel(cell.date)}${list.length ? `, событий: ${list.length}` : ', событий нет'}`}
                className={[
                  'lc-calendar-cell',
                  cell.inMonth ? '' : 'lc-calendar-cell--muted',
                  cell.date === selectedDay ? 'lc-calendar-cell--selected' : '',
                  cell.date === today ? 'lc-calendar-cell--today' : '',
                  overdue ? 'lc-calendar-cell--overdue' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => goToDay(cell.date)}
              >
                <span className="lc-calendar-cell-day">{cell.day}</span>
                {list.length > 0 && (
                  <span className="lc-calendar-dots">
                    {sources.has('reminder') && <i className="lc-calendar-dot lc-calendar-dot--reminder" />}
                    {sources.has('assignment') && (
                      <i className="lc-calendar-dot lc-calendar-dot--assignment" />
                    )}
                    {sources.has('board_task') && <i className="lc-calendar-dot lc-calendar-dot--board" />}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="lc-calendar-legend meta">
          <span>
            <i className="lc-calendar-dot lc-calendar-dot--reminder" /> напоминания
          </span>
          <span>
            <i className="lc-calendar-dot lc-calendar-dot--assignment" /> назначения
          </span>
          <span>
            <i className="lc-calendar-dot lc-calendar-dot--board" /> задачи с доски
          </span>
        </div>

        {err && <p className="meta lc-calendar-error">{err}</p>}

        <div className="lc-calendar-day-panel">
          <h4 className="lc-calendar-day-title">{dayLabel(selectedDay)}</h4>

          {loading && events.length === 0 ? (
            <p className="meta">Загрузка…</p>
          ) : dayEvents.length === 0 ? (
            <p className="meta">На этот день событий нет.</p>
          ) : (
            <ul className="lc-calendar-event-list">
              {dayEvents.map((ev) => {
                const overdue = isOverdue(ev, now);
                const progress = progressLabel(ev);
                return (
                  <li
                    key={ev.id}
                    className={[
                      'lc-calendar-event',
                      `lc-calendar-event--${ev.source}`,
                      ev.status === 'done' ? 'lc-calendar-event--done' : '',
                      overdue ? 'lc-calendar-event--overdue' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <div className="lc-calendar-event-main">
                      <span className="lc-calendar-event-source">{sourceLabel(ev.source)}</span>
                      <strong className="lc-calendar-event-title">{ev.title}</strong>
                      <span className="meta lc-calendar-event-due">{formatDueShort(ev.dueAt)}</span>
                      {overdue && <span className="pill lc-calendar-overdue-pill">Просрочено</span>}
                      {ev.status ? <span className="pill">{statusLabel(ev.status)}</span> : null}
                      {progress ? <span className="meta">{progress}</span> : null}
                      {ev.boardName ? <span className="meta">· {ev.boardName}</span> : null}
                    </div>
                    {ev.notes ? <p className="meta lc-calendar-event-notes">{ev.notes}</p> : null}
                    <div className="lc-calendar-event-actions">
                      {ev.source === 'reminder' && ev.reminderId != null && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void patchReminder(ev.reminderId!, { done: ev.status !== 'done' })
                            }
                          >
                            {ev.status === 'done' ? 'Снять отметку' : 'Готово'}
                          </button>
                          <button type="button" onClick={() => startEdit(ev)}>
                            Изменить
                          </button>
                          <button type="button" className="danger" onClick={() => void removeReminder(ev)}>
                            Удалить
                          </button>
                        </>
                      )}
                      {ev.taskId != null && onOpenTask && (
                        <button
                          type="button"
                          onClick={() => {
                            const taskId = ev.taskId!;
                            onClose();
                            onOpenTask(taskId);
                          }}
                        >
                          Открыть задачу
                        </button>
                      )}
                      {ev.source === 'assignment' && onOpenAssignments && (
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onOpenAssignments();
                          }}
                        >
                          Мои назначения
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <form className="lc-calendar-reminder-form" onSubmit={(e) => void submitReminder(e)}>
          <h4>{editingId != null ? 'Изменить напоминание' : 'Новое напоминание'}</h4>
          <p className="meta">Напоминания видны только вам.</p>
          <label>
            Название
            <input
              type="text"
              value={formTitle}
              maxLength={200}
              disabled={formBusy}
              onChange={(e) => setFormTitle(e.target.value)}
              placeholder="Например: позвонить клиенту"
              required
            />
          </label>
          <label>
            Срок
            <input
              type="datetime-local"
              value={formDue}
              disabled={formBusy}
              onChange={(e) => setFormDue(e.target.value)}
              required
            />
          </label>
          <label>
            Заметки
            <textarea
              value={formNotes}
              disabled={formBusy}
              rows={2}
              maxLength={2000}
              onChange={(e) => setFormNotes(e.target.value)}
              placeholder="Необязательно"
            />
          </label>
          <div className="row-actions">
            {editingId != null && (
              <button type="button" disabled={formBusy} onClick={resetForm}>
                Отмена
              </button>
            )}
            <button type="submit" className="primary" disabled={formBusy}>
              {editingId != null ? 'Сохранить' : 'Добавить напоминание'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
