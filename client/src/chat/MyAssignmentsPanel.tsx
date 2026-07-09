/**
 * @fileoverview Панель «Мои назначения» — активные задачи пользователя в группе.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { AnnouncementCardBody, type AnnouncementAttachment, type GroupAnnouncement } from './AnnouncementModals';

function taskStatusLabel(s: string | null | undefined): string {
  if (s === 'in_progress') return 'В работе';
  if (s === 'done') return 'Выполнено';
  if (s === 'todo') return 'К выполнению';
  return '—';
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function deriveStatusFromWork(
  progress: number,
  quantityDone: number,
  quantityTarget: number | null | undefined
): 'todo' | 'in_progress' | 'done' {
  if (quantityTarget != null && quantityTarget > 0) {
    if (quantityDone >= quantityTarget) return 'done';
    if (quantityDone > 0) return 'in_progress';
    return 'todo';
  }
  if (progress >= 100) return 'done';
  if (progress > 0) return 'in_progress';
  return 'todo';
}

type EditState = {
  taskStatus: string;
  progress: number;
  quantityDone: number;
  note: string;
  /** Снимок с сервера — чтобы понять, менялся ли прогресс/кол-во. */
  savedProgress: number;
  savedQuantityDone: number;
  savedTaskStatus: string;
};

export function MyAssignmentsPanel({
  groupId,
  open,
  onClose,
  refreshKey,
  onOpenLinkedTask,
  onOpenImage,
  onOpenOnlyOffice,
  ooEnabled,
  onUpdated,
}: {
  groupId: number;
  open: boolean;
  onClose: () => void;
  refreshKey: number;
  onOpenLinkedTask?: (taskId: number, boardId: number) => void;
  onOpenImage?: (attachments: AnnouncementAttachment[], attachmentId: number) => void;
  onOpenOnlyOffice?: (attachmentId: number, fileName: string) => void;
  ooEnabled?: boolean;
  onUpdated?: () => void;
}) {
  const [items, setItems] = useState<GroupAnnouncement[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [editState, setEditState] = useState<Record<number, EditState>>({});

  const load = useCallback(() => {
    if (!open) return;
    setLoading(true);
    setErr('');
    return api<GroupAnnouncement[]>(`/api/groups/${groupId}/announcements/my-assignments`)
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setItems(list);
        setEditState((prev) => {
          const next: Record<number, EditState> = {};
          for (const a of list) {
            const progress = a.myProgress ?? 0;
            const quantityDone = a.myQuantityDone ?? 0;
            const taskStatus = a.myTaskStatus || 'todo';
            const keepNote = prev[a.id]?.note ?? '';
            next[a.id] = {
              taskStatus,
              progress,
              quantityDone,
              note: keepNote,
              savedProgress: progress,
              savedQuantityDone: quantityDone,
              savedTaskStatus: taskStatus,
            };
          }
          return next;
        });
      })
      .catch((e) => {
        setErr(e instanceof Error ? e.message : 'Ошибка загрузки');
        setItems([]);
      })
      .finally(() => setLoading(false));
  }, [groupId, open]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  function patchWork(
    item: GroupAnnouncement,
    patch: Partial<Pick<EditState, 'progress' | 'quantityDone'>>
  ) {
    setEditState((prev) => {
      const st = prev[item.id];
      if (!st) return prev;
      const progress = patch.progress ?? st.progress;
      const quantityDone = patch.quantityDone ?? st.quantityDone;
      const taskStatus = deriveStatusFromWork(progress, quantityDone, item.quantityTarget);
      return {
        ...prev,
        [item.id]: { ...st, progress, quantityDone, taskStatus },
      };
    });
  }

  async function saveProgress(item: GroupAnnouncement, mode: 'progress' | 'comment') {
    const st = editState[item.id];
    if (!st || busyId != null) return;
    const note = st.note.trim();
    const qtyChanged = st.quantityDone !== st.savedQuantityDone;
    const progressChanged = st.progress !== st.savedProgress;
    const statusChanged = st.taskStatus !== st.savedTaskStatus;
    const hasQtyTarget = item.quantityTarget != null && item.quantityTarget > 0;

    if (mode === 'comment') {
      if (!note) {
        setErr('Введите комментарий');
        return;
      }
    } else if (!qtyChanged && !progressChanged && !statusChanged && !note) {
      setErr('Измените прогресс или добавьте комментарий');
      return;
    }

    setBusyId(item.id);
    setErr('');
    try {
      const json: Record<string, unknown> = {};
      if (mode === 'comment') {
        json.note = note;
      } else {
        if (hasQtyTarget && qtyChanged) json.quantityDone = st.quantityDone;
        if (!hasQtyTarget && progressChanged) json.progress = st.progress;
        if (statusChanged && !qtyChanged && !progressChanged) {
          json.taskStatus = st.taskStatus;
        }
        if (note) json.note = note;
      }
      await api(`/api/announcements/${item.id}/progress`, {
        method: 'POST',
        json,
      });
      setEditState((prev) => {
        const cur = prev[item.id];
        if (!cur) return prev;
        return { ...prev, [item.id]: { ...cur, note: '' } };
      });
      onUpdated?.();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusyId(null);
    }
  }

  if (!open) return null;

  return (
    <div
      className="modal-backdrop lc-my-assignments-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal lc-my-assignments-modal"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Мои назначения</h3>
        {loading ? (
          <p className="meta">Загрузка…</p>
        ) : items.length === 0 ? (
          <p className="meta">Активных назначений нет.</p>
        ) : (
          <ul className="lc-my-assignments-list">
            {items.map((item) => {
              const st = editState[item.id];
              const isExpanded = expandedId === item.id;
              const isLinked = item.kind === 'linked_task';
              return (
                <li key={item.id} className="lc-my-assignments-item">
                  <button
                    type="button"
                    className="lc-my-assignments-item-head"
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                  >
                    <span className="pill">{isLinked ? 'С доски' : 'Быстрая'}</span>
                    <span>
                      {item.body.trim().slice(0, 80) ||
                        item.linkedTask?.title ||
                        'Назначение'}
                    </span>
                    <span className="meta">
                      {isLinked
                        ? `${item.linkedTask?.progress ?? 0}% · ${taskStatusLabel(item.linkedTask?.status)}`
                        : `${item.myProgress ?? 0}% · ${taskStatusLabel(item.myTaskStatus)}`}
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="lc-my-assignments-item-body">
                      <AnnouncementCardBody
                        item={item}
                        onOpenImage={onOpenImage}
                        onOpenOnlyOffice={onOpenOnlyOffice}
                        ooEnabled={ooEnabled}
                      />
                      {!isLinked && st && (
                        <div className="lc-my-assignments-form">
                          <label>
                            Статус
                            <select
                              value={st.taskStatus}
                              disabled={busyId === item.id}
                              onChange={(e) =>
                                setEditState((prev) => ({
                                  ...prev,
                                  [item.id]: { ...st, taskStatus: e.target.value },
                                }))
                              }
                            >
                              <option value="todo">К выполнению</option>
                              <option value="in_progress">В работе</option>
                              <option value="done">Выполнено</option>
                            </select>
                          </label>
                          <p className="meta lc-my-assignments-status-hint">
                            При изменении прогресса статус сам станет «В работе» или «Выполнено».
                          </p>
                          {item.quantityTarget != null && item.quantityTarget > 0 ? (
                            <label>
                              Выполнено ({item.quantityTarget})
                              <input
                                type="number"
                                min={0}
                                max={item.quantityTarget}
                                value={st.quantityDone}
                                disabled={busyId === item.id}
                                onChange={(e) =>
                                  patchWork(item, {
                                    quantityDone: Math.min(
                                      item.quantityTarget!,
                                      Math.max(0, +e.target.value || 0)
                                    ),
                                  })
                                }
                              />
                            </label>
                          ) : (
                            <label>
                              Прогресс: {st.progress}%
                              <input
                                type="range"
                                min={0}
                                max={100}
                                value={st.progress}
                                disabled={busyId === item.id}
                                onChange={(e) => patchWork(item, { progress: +e.target.value })}
                              />
                            </label>
                          )}
                          <label>
                            Комментарий
                            <textarea
                              rows={2}
                              value={st.note}
                              disabled={busyId === item.id}
                              onChange={(e) =>
                                setEditState((prev) => ({
                                  ...prev,
                                  [item.id]: { ...st, note: e.target.value },
                                }))
                              }
                              placeholder="Комментарий к обновлению…"
                            />
                          </label>
                          <div className="lc-my-assignments-form-actions">
                            <button
                              type="button"
                              className="primary"
                              disabled={busyId === item.id}
                              onClick={() => void saveProgress(item, 'progress')}
                            >
                              {busyId === item.id ? 'Сохранение…' : 'Обновить прогресс'}
                            </button>
                            <button
                              type="button"
                              disabled={busyId === item.id || !st.note.trim()}
                              onClick={() => void saveProgress(item, 'comment')}
                            >
                              Только комментарий
                            </button>
                          </div>
                        </div>
                      )}
                      {isLinked && item.linkedTask && onOpenLinkedTask && (
                        <button
                          type="button"
                          onClick={() =>
                            onOpenLinkedTask(item.linkedTask!.id, item.linkedTask!.boardId)
                          }
                        >
                          Открыть задачу на доске
                        </button>
                      )}
                      {item.progressLog && item.progressLog.length > 0 && (
                        <details className="lc-my-assignments-history" open>
                          <summary>История обновлений</summary>
                          <ul>
                            {item.progressLog.map((log) => (
                              <li key={log.id}>
                                <span className="meta">{formatWhen(log.createdAt)}</span>
                                {' · '}
                                {taskStatusLabel(log.taskStatus)}
                                {item.quantityTarget != null && item.quantityTarget > 0
                                  ? ` · ${log.quantityDone ?? 0}/${item.quantityTarget}`
                                  : ` · ${log.progress ?? 0}%`}
                                {log.note ? ` — ${log.note}` : ''}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {err && <p className="error">{err}</p>}
        <div className="row-actions">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

export function MyAssignmentsBadgeButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <button type="button" className="lc-my-assignments-badge-btn" onClick={onClick}>
      Мои назначения
      {count > 0 && (
        <span className="lc-my-assignments-badge" aria-label={`Назначений: ${count}`}>
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}
