/**
 * @fileoverview Модалки уведомлений и назначений группы: подтверждение ознакомления и панель модератора.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiForm, resolveUrl } from '../api';
import { uiConfirm } from '../ui/dialogs';
import type { Attachment, User } from '../types';
import { formatMessageClock } from './foundation';
import { MessageImageGrid } from './MessageImageGrid';
import { chatAttachmentSupportsOnlyOffice } from './onlyOfficeAttachment';

export type AnnouncementKind = 'notice' | 'assignment' | 'linked_task';
export type AnnouncementAudience = 'all' | 'selected';

export type AnnouncementAttachment = {
  id: number;
  url: string;
  fileName: string;
  mimeType: string;
  kind: string;
};

export type LinkedTaskSnapshot = {
  id: number;
  title: string;
  boardId: number;
  boardName: string;
  status: string;
  progress: number;
  quantityTarget: number | null;
  quantityDone: number;
  assignee: User | null;
};

export type ProgressLogEntry = {
  id: number;
  taskStatus: string | null;
  progress: number | null;
  quantityDone: number | null;
  note: string | null;
  createdAt: string;
};

export type GroupAnnouncement = {
  id: number;
  groupId: number;
  kind: AnnouncementKind;
  audience: AnnouncementAudience;
  body: string;
  createdAt: string;
  dueAt?: string | null;
  quantityTarget?: number | null;
  author: User;
  attachments: AnnouncementAttachment[];
  recipients?: User[];
  linkedTask?: LinkedTaskSnapshot | null;
  myStatus?: 'acknowledged' | 'need_more' | null;
  myComment?: string | null;
  myRespondedAt?: string | null;
  myTaskStatus?: 'todo' | 'in_progress' | 'done' | null;
  myProgress?: number | null;
  myQuantityDone?: number | null;
  myProgressNote?: string | null;
  progressLog?: ProgressLogEntry[];
};

export type AnnouncementStatsMember = {
  userId: number;
  displayName: string;
  tag: string;
  avatarUrl: string | null;
  status: 'acknowledged' | 'need_more' | 'pending';
  comment: string | null;
  respondedAt: string | null;
  taskStatus?: 'todo' | 'in_progress' | 'done' | null;
  progress?: number | null;
  quantityDone?: number | null;
  progressNote?: string | null;
};

export type AnnouncementStats = {
  announcement: GroupAnnouncement;
  linkedTask?: LinkedTaskSnapshot | null;
  summary: {
    total: number;
    acknowledged: number;
    needMore: number;
    pending: number;
    inProgress?: number;
    done?: number;
  };
  members: AnnouncementStatsMember[];
};

export type TaskPickerItem = {
  id: number;
  title: string;
  boardId: number;
  boardName: string;
};

function formatAnnouncementWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function kindLabel(kind: AnnouncementKind): string {
  if (kind === 'assignment') return 'Быстрая задача';
  if (kind === 'linked_task') return 'Задача с доски';
  return 'Уведомление';
}

function taskStatusLabel(s: string | null | undefined): string {
  if (s === 'in_progress') return 'В работе';
  if (s === 'done') return 'Выполнено';
  if (s === 'todo') return 'К выполнению';
  return '—';
}

export function AnnouncementAttachmentList({
  attachments,
  onOpenImage,
  onOpenOnlyOffice,
  ooEnabled,
}: {
  attachments: AnnouncementAttachment[];
  onOpenImage?: (attachments: AnnouncementAttachment[], attachmentId: number) => void;
  onOpenOnlyOffice?: (attachmentId: number, fileName: string) => void;
  ooEnabled?: boolean;
}) {
  if (!attachments.length) return null;
  const images = attachments.filter((a) => a.kind === 'image');
  const others = attachments.filter((a) => a.kind !== 'image');
  const asAttachments = attachments as unknown as Attachment[];

  return (
    <div className="lc-announcement-attachments">
      {images.length > 0 && onOpenImage ? (
        <MessageImageGrid
          images={images as unknown as Attachment[]}
          allAttachments={asAttachments}
          resolveUrl={resolveUrl}
          onOpenImage={(_all, id) => onOpenImage(attachments, id)}
        />
      ) : (
        images.map((a) => (
          <img key={a.id} className="attach" src={resolveUrl(a.url)} alt={a.fileName} />
        ))
      )}
      {others.map((a) => (
        <div key={a.id} className="lc-announcement-attachment">
          {a.kind === 'video' && <video src={resolveUrl(a.url)} controls />}
          {(a.kind === 'audio' || a.kind === 'voice') && (
            <audio src={resolveUrl(a.url)} controls />
          )}
          {a.kind === 'file' &&
            (ooEnabled && onOpenOnlyOffice && chatAttachmentSupportsOnlyOffice(a.fileName, a.mimeType) ? (
              <button
                type="button"
                className="lc-chat-attach-link"
                onClick={() => onOpenOnlyOffice(a.id, a.fileName)}
              >
                📎 {a.fileName}
              </button>
            ) : (
              <a className="lc-chat-attach-link" href={resolveUrl(a.url)} download={a.fileName}>
                📎 {a.fileName}
              </a>
            ))}
        </div>
      ))}
    </div>
  );
}

export function AnnouncementCardBody({
  item,
  onOpenImage,
  onOpenOnlyOffice,
  ooEnabled,
}: {
  item: GroupAnnouncement;
  onOpenImage?: (attachments: AnnouncementAttachment[], attachmentId: number) => void;
  onOpenOnlyOffice?: (attachmentId: number, fileName: string) => void;
  ooEnabled?: boolean;
}) {
  return (
    <article className="lc-announcement-card">
      <div className="lc-announcement-card-meta">
        <span>{item.author.displayName}</span>
        <span className="pill">{kindLabel(item.kind)}</span>
        <span className="meta">
          {formatAnnouncementWhen(item.createdAt)} · {formatMessageClock(item.createdAt)}
        </span>
      </div>
      {item.dueAt && (
        <p className="meta lc-announcement-due">Срок: {formatAnnouncementWhen(item.dueAt)}</p>
      )}
      {item.linkedTask && (
        <p className="lc-announcement-linked-task">
          Задача: <strong>{item.linkedTask.title}</strong>
          <span className="meta"> · {item.linkedTask.boardName}</span>
        </p>
      )}
      {item.body && <div className="lc-announcement-card-body">{item.body}</div>}
      <AnnouncementAttachmentList
        attachments={item.attachments}
        onOpenImage={onOpenImage}
        onOpenOnlyOffice={onOpenOnlyOffice}
        ooEnabled={ooEnabled}
      />
    </article>
  );
}

function statusLabel(status: AnnouncementStatsMember['status']): string {
  if (status === 'acknowledged') return 'Ознакомлен';
  if (status === 'need_more') return 'Нужно больше информации';
  return 'Не ответил';
}

/** Блокирующая модалка: без ответа закрыть нельзя. */
export function AnnouncementAckModal({
  announcements,
  onResponded,
  onOpenLinkedTask,
  onOpenImage,
  onOpenOnlyOffice,
  ooEnabled,
}: {
  announcements: GroupAnnouncement[];
  onResponded: (announcementId: number) => void;
  onOpenLinkedTask?: (taskId: number, boardId: number) => void;
  onOpenImage?: (attachments: AnnouncementAttachment[], attachmentId: number) => void;
  onOpenOnlyOffice?: (attachmentId: number, fileName: string) => void;
  ooEnabled?: boolean;
}) {
  const current = announcements[0] ?? null;
  const [needMoreMode, setNeedMoreMode] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const prevIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (current?.id !== prevIdRef.current) {
      prevIdRef.current = current?.id ?? null;
      setNeedMoreMode(false);
      setComment('');
      setErr('');
    }
  }, [current?.id]);

  async function respond(status: 'acknowledged' | 'need_more') {
    if (!current || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api(`/api/announcements/${current.id}/respond`, {
        method: 'POST',
        json: {
          status,
          comment: status === 'need_more' ? comment.trim() : undefined,
        },
      });
      onResponded(current.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось отправить ответ');
    } finally {
      setBusy(false);
    }
  }

  if (!current) return null;

  const isTask = current.kind === 'assignment' || current.kind === 'linked_task';
  const title = isTask ? 'Назначение' : 'Объявление группы';
  const ackLabel = isTask ? 'Принял к исполнению' : 'Ознакомлен';

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.stopPropagation()}>
      <div
        className="modal lc-announcement-ack-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-announcement-ack-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="lc-announcement-ack-title">{title}</h3>
        {announcements.length > 1 && (
          <p className="meta lc-announcement-ack-queue">
            Осталось ответить: {announcements.length}
          </p>
        )}
        <AnnouncementCardBody
          item={current}
          onOpenImage={onOpenImage}
          onOpenOnlyOffice={onOpenOnlyOffice}
          ooEnabled={ooEnabled}
        />
        {needMoreMode ? (
          <div className="lc-announcement-comment-box">
            <label htmlFor="lc-announcement-comment">Что нужно уточнить?</label>
            <textarea
              id="lc-announcement-comment"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Опишите, какой информации не хватает…"
              disabled={busy}
            />
            <div className="row-actions lc-announcement-ack-actions">
              <button type="button" disabled={busy} onClick={() => setNeedMoreMode(false)}>
                Назад
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void respond('need_more')}
              >
                Отправить
              </button>
            </div>
          </div>
        ) : (
          <div className="row-actions lc-announcement-ack-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void respond('acknowledged')}
            >
              {ackLabel}
            </button>
            {!isTask && (
              <button type="button" disabled={busy} onClick={() => setNeedMoreMode(true)}>
                Нужно больше информации
              </button>
            )}
            {current.kind === 'linked_task' && current.linkedTask && onOpenLinkedTask && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  onOpenLinkedTask(current.linkedTask!.id, current.linkedTask!.boardId)
                }
              >
                Открыть задачу на доске
              </button>
            )}
          </div>
        )}
        {err && <p className="error">{err}</p>}
      </div>
    </div>
  );
}

export function GroupAnnouncementsModal({
  groupId,
  members: membersProp,
  statsRefreshKey,
  canCreate,
  canViewStats,
  currentUserId,
  userRole,
  onClose,
  onOpenLinkedTask,
  onOpenImage,
  onOpenOnlyOffice,
  ooEnabled,
}: {
  groupId: number;
  members?: User[];
  statsRefreshKey: number;
  canCreate: boolean;
  canViewStats: boolean;
  currentUserId: number;
  userRole: string;
  onClose: () => void;
  onOpenLinkedTask?: (taskId: number, boardId: number) => void;
  onOpenImage?: (attachments: AnnouncementAttachment[], attachmentId: number) => void;
  onOpenOnlyOffice?: (attachmentId: number, fileName: string) => void;
  ooEnabled?: boolean;
}) {
  const [announcements, setAnnouncements] = useState<GroupAnnouncement[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [stats, setStats] = useState<AnnouncementStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(false);
  const [err, setErr] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [createBusy, setCreateBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState<number | null>(null);
  const [kind, setKind] = useState<AnnouncementKind>('notice');
  const [audience, setAudience] = useState<AnnouncementAudience>('all');
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<number[]>([]);
  const [linkedTaskId, setLinkedTaskId] = useState<number | null>(null);
  const [assignOnBoard, setAssignOnBoard] = useState(false);
  const [dueAt, setDueAt] = useState('');
  const [quantityTarget, setQuantityTarget] = useState('');
  const [pickerTasks, setPickerTasks] = useState<TaskPickerItem[]>([]);
  const [groupMembers, setGroupMembers] = useState<User[]>(() =>
    Array.isArray(membersProp) ? membersProp : []
  );
  const [membersLoading, setMembersLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadGroupMembers = useCallback(() => {
    setMembersLoading(true);
    return api<User[]>(`/api/groups/${groupId}/members`)
      .then((rows) => setGroupMembers(Array.isArray(rows) ? rows.filter((m) => !m.banned) : []))
      .catch(() => setGroupMembers([]))
      .finally(() => setMembersLoading(false));
  }, [groupId]);

  useEffect(() => {
    if (Array.isArray(membersProp) && membersProp.length > 0) {
      setGroupMembers(membersProp.filter((m) => !m.banned));
    }
  }, [membersProp]);

  useEffect(() => {
    void loadGroupMembers();
  }, [loadGroupMembers]);

  useEffect(() => {
    if (audience === 'selected' && groupMembers.length === 0 && !membersLoading) {
      void loadGroupMembers();
    }
  }, [audience, groupMembers.length, membersLoading, loadGroupMembers]);

  useEffect(() => {
    void api<TaskPickerItem[]>(`/api/groups/${groupId}/tasks-for-chat-picker`)
      .then((t) => setPickerTasks(Array.isArray(t) ? t : []))
      .catch(() => setPickerTasks([]));
  }, [groupId]);

  const loadList = useCallback(() => {
    setLoading(true);
    setErr('');
    return api<GroupAnnouncement[]>(`/api/groups/${groupId}/announcements`)
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setAnnouncements(list);
        setSelectedId((prev) => {
          if (prev != null && list.some((a) => a.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      })
      .catch((e) => {
        setErr(e instanceof Error ? e.message : 'Ошибка загрузки');
        setAnnouncements([]);
        setSelectedId(null);
      })
      .finally(() => setLoading(false));
  }, [groupId]);

  useEffect(() => {
    void loadList();
  }, [loadList, statsRefreshKey]);

  useEffect(() => {
    if (!canViewStats || selectedId == null) {
      setStats(null);
      return;
    }
    let cancelled = false;
    setStatsLoading(true);
    api<AnnouncementStats>(`/api/announcements/${selectedId}/stats`)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((e) => {
        if (!cancelled) {
          setStats(null);
          setErr(e instanceof Error ? e.message : 'Ошибка загрузки статистики');
        }
      })
      .finally(() => {
        if (!cancelled) setStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, statsRefreshKey, canViewStats]);

  function addFilesFromInput(fileList: FileList | null) {
    if (!fileList?.length) return;
    const incoming = Array.from(fileList);
    setFiles((prev) => {
      const merged = [...prev];
      for (const f of incoming) {
        const dup = merged.some(
          (x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified
        );
        if (!dup) merged.push(f);
      }
      return merged;
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removePendingFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleRecipient(userId: number) {
    setSelectedRecipientIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  }

  async function createAnnouncement(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (kind !== 'linked_task' && !text && files.length === 0) {
      setErr('Введите текст или прикрепите файлы');
      return;
    }
    if (kind === 'linked_task' && !linkedTaskId) {
      setErr('Выберите задачу с доски');
      return;
    }
    if (audience === 'selected' && selectedRecipientIds.length === 0) {
      setErr('Выберите хотя бы одного получателя');
      return;
    }
    setCreateBusy(true);
    setErr('');
    try {
      const fd = new FormData();
      fd.append('body', text);
      fd.append('kind', kind);
      fd.append('audience', audience);
      if (audience === 'selected') {
        fd.append('recipientUserIds', JSON.stringify(selectedRecipientIds));
      }
      if (kind === 'linked_task' && linkedTaskId) {
        fd.append('linkedTaskId', String(linkedTaskId));
        if (assignOnBoard && selectedRecipientIds.length === 1) {
          fd.append('setAssignee', 'true');
        }
      }
      if (kind === 'assignment' && dueAt.trim()) fd.append('dueAt', dueAt.trim());
      if (kind === 'assignment' && quantityTarget.trim()) {
        fd.append('quantityTarget', quantityTarget.trim());
      }
      for (const f of files) fd.append('files', f);
      const created = await apiForm<GroupAnnouncement>(`/api/groups/${groupId}/announcements`, fd);
      setBody('');
      setFiles([]);
      setSelectedRecipientIds([]);
      setLinkedTaskId(null);
      setDueAt('');
      setQuantityTarget('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadList();
      setSelectedId(created.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось создать');
    } finally {
      setCreateBusy(false);
    }
  }

  async function deleteAnnouncement(id: number) {
    if (
      !(await uiConfirm('Удалить это уведомление?', {
        title: 'Удаление',
        danger: true,
        okText: 'Удалить',
      }))
    )
      return;
    setDeleteBusy(id);
    setErr('');
    try {
      await api(`/api/announcements/${id}`, { method: 'DELETE' });
      await loadList();
      setSelectedId((prev) => (prev === id ? null : prev));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось удалить');
    } finally {
      setDeleteBusy(null);
    }
  }

  const selected = announcements.find((a) => a.id === selectedId) ?? null;
  const showTaskStats = stats?.announcement.kind === 'assignment' || stats?.announcement.kind === 'linked_task';
  const canDeleteSelected =
    selected != null && (userRole === 'admin' || selected.author.id === currentUserId);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal lc-announcements-modal"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{canCreate ? 'Уведомления и назначения' : 'История уведомлений'}</h3>
        {canCreate && (
        <form className="lc-announcement-create" onSubmit={(e) => void createAnnouncement(e)}>
          <div className="lc-announcement-form-row">
            <label>
              Тип
              <select
                value={kind}
                disabled={createBusy}
                onChange={(e) => setKind(e.target.value as AnnouncementKind)}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <option value="notice">Уведомление</option>
                <option value="assignment">Быстрая задача</option>
                <option value="linked_task">Задача с доски</option>
              </select>
            </label>
            <label>
              Аудитория
              <select
                value={audience}
                disabled={createBusy}
                onChange={(e) => setAudience(e.target.value as AnnouncementAudience)}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <option value="all">Вся группа</option>
                <option value="selected">Выбранные участники</option>
              </select>
            </label>
          </div>
          {kind === 'linked_task' && (
            <label>
              Задача с доски
              <select
                value={linkedTaskId ?? ''}
                disabled={createBusy}
                onChange={(e) => setLinkedTaskId(e.target.value ? +e.target.value : null)}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <option value="">— выберите —</option>
                {pickerTasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title} ({t.boardName})
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === 'assignment' && (
            <div className="lc-announcement-form-row">
              <label>
                Срок
                <input
                  type="datetime-local"
                  value={dueAt}
                  disabled={createBusy}
                  onChange={(e) => setDueAt(e.target.value)}
                />
              </label>
              <label>
                Целевое количество
                <input
                  type="number"
                  min={1}
                  value={quantityTarget}
                  disabled={createBusy}
                  onChange={(e) => setQuantityTarget(e.target.value)}
                  placeholder="Необязательно"
                />
              </label>
            </div>
          )}
          {audience === 'selected' && (
            <div className="lc-announcement-recipients">
              <span className="lc-announcement-recipients-label">Получатели</span>
              {membersLoading ? (
                <p className="meta">Загрузка участников…</p>
              ) : groupMembers.length === 0 ? (
                <p className="meta">Участники не найдены.</p>
              ) : (
                <ul className="lc-announcement-recipients-list">
                  {groupMembers.map((m) => (
                    <li key={m.id}>
                      <label className="lc-announcement-recipient-row">
                        <input
                          type="checkbox"
                          checked={selectedRecipientIds.includes(m.id)}
                          disabled={createBusy}
                          onChange={() => toggleRecipient(m.id)}
                        />
                        <span>
                          {m.displayName}
                          <span className="meta"> @{m.tag}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {kind === 'linked_task' && selectedRecipientIds.length === 1 && (
                <label className="lc-announcement-set-assignee">
                  <input
                    type="checkbox"
                    checked={assignOnBoard}
                    disabled={createBusy}
                    onChange={(e) => setAssignOnBoard(e.target.checked)}
                  />
                  Назначить исполнителем на доске
                </label>
              )}
            </div>
          )}
          <label>
            Текст
            <textarea
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                kind === 'linked_task'
                  ? 'Комментарий к назначению (необязательно)…'
                  : 'Текст уведомления…'
              }
              disabled={createBusy}
            />
          </label>
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={createBusy}
              onChange={(e) => addFilesFromInput(e.target.files)}
            />
            <button type="submit" className="primary" disabled={createBusy}>
              {createBusy ? 'Публикация…' : 'Опубликовать'}
            </button>
          </div>
          {files.length > 0 && (
            <ul className="lc-announcement-pending-files" style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0' }}>
              {files.map((f, i) => (
                <li key={`${f.name}-${f.size}-${f.lastModified}`} className="row-actions" style={{ gap: '0.5rem' }}>
                  <span className="meta">{f.name}</span>
                  <button type="button" disabled={createBusy} onClick={() => removePendingFile(i)}>
                    Убрать
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
        )}
        {err && <p className="error">{err}</p>}
        {loading ? (
          <p className="meta">Загрузка…</p>
        ) : announcements.length === 0 ? (
          <p className="meta">Пока ничего не опубликовано.</p>
        ) : (
          <div className="lc-announcements-layout">
            <ul className="lc-announcements-list">
              {announcements.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className={selectedId === a.id ? 'primary' : ''}
                    onClick={() => setSelectedId(a.id)}
                  >
                    <span className="lc-announcements-list-title">
                      <span className="pill">{kindLabel(a.kind)}</span>{' '}
                      {a.body.trim().slice(0, 60) || a.linkedTask?.title || '(без текста)'}
                    </span>
                    <span className="meta">{formatAnnouncementWhen(a.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {selected && (
              <div className="lc-announcements-detail">
                <AnnouncementCardBody
                  item={selected}
                  onOpenImage={onOpenImage}
                  onOpenOnlyOffice={onOpenOnlyOffice}
                  ooEnabled={ooEnabled}
                />
                <div className="row-actions">
                  {canDeleteSelected && (
                  <button
                    type="button"
                    className="danger"
                    disabled={deleteBusy === selected.id}
                    onClick={() => void deleteAnnouncement(selected.id)}
                  >
                    {deleteBusy === selected.id ? 'Удаление…' : 'Удалить'}
                  </button>
                  )}
                  {selected.kind === 'linked_task' && selected.linkedTask && onOpenLinkedTask && (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenLinkedTask(selected.linkedTask!.id, selected.linkedTask!.boardId)
                      }
                    >
                      Открыть на доске
                    </button>
                  )}
                </div>
                {canViewStats && statsLoading ? (
                  <p className="meta">Загрузка статистики…</p>
                ) : canViewStats && stats ? (
                  <>
                    {stats.linkedTask && (
                      <div className="lc-announcement-linked-stats meta">
                        Прогресс задачи на доске: {stats.linkedTask.progress}% ·{' '}
                        {taskStatusLabel(stats.linkedTask.status)}
                        {stats.linkedTask.assignee && (
                          <> · {stats.linkedTask.assignee.displayName}</>
                        )}
                      </div>
                    )}
                    <div className="lc-announcement-stats-summary">
                      <span className="pill lc-announcement-status-pill lc-announcement-status-pill--ack">
                        Ознакомлены: {stats.summary.acknowledged}
                      </span>
                      <span className="pill lc-announcement-status-pill lc-announcement-status-pill--need">
                        Нужно больше: {stats.summary.needMore}
                      </span>
                      <span className="pill lc-announcement-status-pill lc-announcement-status-pill--pending">
                        Не ответили: {stats.summary.pending}
                      </span>
                      {showTaskStats && stats.summary.inProgress != null && (
                        <span className="pill lc-announcement-status-pill lc-announcement-status-pill--progress">
                          В работе: {stats.summary.inProgress}
                        </span>
                      )}
                      {showTaskStats && stats.summary.done != null && (
                        <span className="pill lc-announcement-status-pill lc-announcement-status-pill--ack">
                          Выполнено: {stats.summary.done}
                        </span>
                      )}
                    </div>
                    <div className="lc-announcement-stats-table-wrap">
                      <table className="lc-announcement-stats-table">
                        <thead>
                          <tr>
                            <th>ФИО</th>
                            <th>Статус</th>
                            {showTaskStats && <th>Задача</th>}
                            {showTaskStats && <th>Прогресс</th>}
                            <th>Комментарий</th>
                            <th>Время</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(stats.members ?? []).map((m) => (
                            <tr key={m.userId}>
                              <td>
                                {m.displayName}
                                <span className="meta"> @{m.tag}</span>
                              </td>
                              <td>
                                <span
                                  className={`pill lc-announcement-status-pill lc-announcement-status-pill--${
                                    m.status === 'acknowledged'
                                      ? 'ack'
                                      : m.status === 'need_more'
                                        ? 'need'
                                        : 'pending'
                                  }`}
                                >
                                  {statusLabel(m.status)}
                                </span>
                              </td>
                              {showTaskStats && (
                                <td>{taskStatusLabel(m.taskStatus)}</td>
                              )}
                              {showTaskStats && (
                                <td>
                                  {stats.announcement.kind === 'assignment'
                                    ? `${m.progress ?? 0}%`
                                    : stats.linkedTask
                                      ? `${stats.linkedTask.progress}%`
                                      : '—'}
                                </td>
                              )}
                              <td>{m.progressNote || m.comment || '—'}</td>
                              <td className="meta">
                                {m.respondedAt ? formatAnnouncementWhen(m.respondedAt) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </div>
        )}
        <div className="row-actions">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
