/**
 * @fileoverview Обзорный канбан группы: задачи со всех досок без пароля, колонки по статусу.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { api, resolveUrl } from '../api';
import type { TaskNode } from '../types';

const COLUMNS: { status: string; label: string }[] = [
  { status: 'todo', label: 'К выполнению' },
  { status: 'in_progress', label: 'В работе' },
  { status: 'review', label: 'На проверке' },
  { status: 'done', label: 'Готово' },
];

function statusClass(status: string): string {
  if (status === 'in_progress') return 'progress';
  if (status === 'review') return 'review';
  if (status === 'done') return 'done';
  return 'todo';
}

export function CrossBoardKanbanOverview({
  groupId,
  socket,
  onOpenTask,
}: {
  groupId: number;
  socket: Socket | null;
  onOpenTask: (boardId: number, taskId: number) => void;
}) {
  const [tasks, setTasks] = useState<TaskNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<string | null>(null);
  const [rootsOnly, setRootsOnly] = useState(true);
  const [boardFilter, setBoardFilter] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setErr('');
    const q = rootsOnly ? '?rootsOnly=1' : '';
    return api<TaskNode[]>(`/api/groups/${groupId}/tasks-overview-kanban${q}`)
      .then((rows) => setTasks(Array.isArray(rows) ? rows : []))
      .catch((e) => {
        setErr(e instanceof Error ? e.message : 'Не удалось загрузить обзор');
        setTasks([]);
      })
      .finally(() => setLoading(false));
  }, [groupId, rootsOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onRefresh = (p: { groupId?: number }) => {
      if (p?.groupId != null && p.groupId !== groupId) return;
      void load();
    };
    socket.on('tasks:refresh', onRefresh);
    return () => {
      socket.off('tasks:refresh', onRefresh);
    };
  }, [socket, groupId, load]);

  const boardOptions = useMemo(() => {
    const map = new Map<number, string>();
    for (const t of tasks) {
      if (!map.has(t.boardId)) map.set(t.boardId, t.boardName || `Доска #${t.boardId}`);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (boardFilter !== 'all' && t.boardId !== boardFilter) return false;
      if (q && !t.title.toLowerCase().includes(q) && !(t.boardName || '').toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [tasks, boardFilter, search]);

  const byStatus = useMemo(() => {
    const map: Record<string, TaskNode[]> = {
      todo: [],
      in_progress: [],
      review: [],
      done: [],
    };
    for (const t of filtered) {
      const key = map[t.status] ? t.status : 'todo';
      map[key].push(t);
    }
    return map;
  }, [filtered]);

  async function moveToStatus(task: TaskNode, status: string) {
    if (task.status === status || busyId != null) return;
    setBusyId(task.id);
    setErr('');
    try {
      await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        json: { status },
      });
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status } : t)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось сменить статус');
      void load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="lc-overview-kanban">
      <div className="lc-overview-kanban-toolbar">
        <h3 className="lc-overview-kanban-title">Обзор задач</h3>
        <p className="meta lc-overview-kanban-hint">
          Все доски без пароля · перетащите карточку между колонками
        </p>
        <div className="row-actions lc-overview-kanban-filters">
          <label>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск…"
              aria-label="Поиск по задачам"
            />
          </label>
          <label>
            Доска
            <select
              value={boardFilter === 'all' ? 'all' : String(boardFilter)}
              onChange={(e) =>
                setBoardFilter(e.target.value === 'all' ? 'all' : +e.target.value)
              }
            >
              <option value="all">Все открытые</option>
              {boardOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="lc-overview-kanban-roots">
            <input
              type="checkbox"
              checked={rootsOnly}
              onChange={(e) => setRootsOnly(e.target.checked)}
            />
            Только корневые
          </label>
          <button type="button" onClick={() => void load()} disabled={loading}>
            Обновить
          </button>
        </div>
      </div>
      {err && <p className="error">{err}</p>}
      {loading ? (
        <p className="meta">Загрузка канбана…</p>
      ) : filtered.length === 0 ? (
        <p className="meta">Нет задач на открытых досках.</p>
      ) : (
        <div className="lc-overview-kanban-columns">
          {COLUMNS.map((col) => (
            <section
              key={col.status}
              className={`lc-overview-kanban-col${
                dragOverStatus === col.status ? ' lc-overview-kanban-col--drag' : ''
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverStatus(col.status);
              }}
              onDragLeave={() => setDragOverStatus((s) => (s === col.status ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverStatus(null);
                try {
                  const raw = e.dataTransfer.getData('application/x-lc-task');
                  if (!raw) return;
                  const payload = JSON.parse(raw) as { id: number };
                  const task = tasks.find((t) => t.id === payload.id);
                  if (task) void moveToStatus(task, col.status);
                } catch {
                  /* ignore */
                }
              }}
            >
              <header className="lc-overview-kanban-col-head">
                <span className={`pill lc-overview-status-pill lc-overview-status-pill--${statusClass(col.status)}`}>
                  {col.label}
                </span>
                <span className="meta">{byStatus[col.status]?.length ?? 0}</span>
              </header>
              <ul className="lc-overview-kanban-cards">
                {(byStatus[col.status] || []).map((t) => (
                  <li key={t.id}>
                    <article
                      className={`lc-overview-kanban-card${busyId === t.id ? ' lc-overview-kanban-card--busy' : ''}`}
                      draggable={busyId == null}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(
                          'application/x-lc-task',
                          JSON.stringify({ id: t.id })
                        );
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                    >
                      <button
                        type="button"
                        className="lc-overview-kanban-card-main"
                        onClick={() => onOpenTask(t.boardId, t.id)}
                        title="Открыть на доске"
                      >
                        <span className="lc-overview-kanban-card-title">{t.title}</span>
                        <span className="meta lc-overview-kanban-card-board">
                          {t.boardName || `Доска #${t.boardId}`}
                        </span>
                        <div className="lc-overview-kanban-card-meta">
                          <span className="lc-overview-kanban-progress" title="Прогресс">
                            {t.effectiveProgress ?? t.progress}%
                          </span>
                          {t.assignee && (
                            <span className="lc-overview-kanban-assignee" title={t.assignee.displayName}>
                              {t.assignee.avatarUrl ? (
                                <img src={resolveUrl(t.assignee.avatarUrl)} alt="" />
                              ) : (
                                <span aria-hidden>{t.assignee.displayName.slice(0, 1).toUpperCase()}</span>
                              )}
                            </span>
                          )}
                        </div>
                      </button>
                      <div className="lc-overview-kanban-card-actions">
                        {COLUMNS.filter((c) => c.status !== t.status).map((c) => (
                          <button
                            key={c.status}
                            type="button"
                            className="lc-overview-kanban-move"
                            disabled={busyId === t.id}
                            title={`Перенести: ${c.label}`}
                            onClick={() => void moveToStatus(t, c.status)}
                          >
                            → {c.label}
                          </button>
                        ))}
                      </div>
                    </article>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
