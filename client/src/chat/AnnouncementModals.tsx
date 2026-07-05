/**
 * @fileoverview Модалки объявлений группы: блокирующее подтверждение ознакомления и панель модератора.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiForm, resolveUrl } from '../api';
import { uiConfirm } from '../ui/dialogs';
import type { User } from '../types';
import { formatMessageClock } from './foundation';

export type AnnouncementAttachment = {
  id: number;
  url: string;
  fileName: string;
  mimeType: string;
  kind: string;
};

export type GroupAnnouncement = {
  id: number;
  groupId: number;
  body: string;
  createdAt: string;
  author: User;
  attachments: AnnouncementAttachment[];
  myStatus?: 'acknowledged' | 'need_more' | null;
  myComment?: string | null;
  myRespondedAt?: string | null;
};

export type AnnouncementStatsMember = {
  userId: number;
  displayName: string;
  tag: string;
  avatarUrl: string | null;
  status: 'acknowledged' | 'need_more' | 'pending';
  comment: string | null;
  respondedAt: string | null;
};

export type AnnouncementStats = {
  announcement: GroupAnnouncement;
  summary: {
    total: number;
    acknowledged: number;
    needMore: number;
    pending: number;
  };
  members: AnnouncementStatsMember[];
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

function AnnouncementAttachmentList({ attachments }: { attachments: AnnouncementAttachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className="lc-announcement-attachments">
      {attachments.map((a) => (
        <div key={a.id} className="lc-announcement-attachment">
          {a.kind === 'image' && (
            <img className="attach" src={resolveUrl(a.url)} alt={a.fileName} />
          )}
          {a.kind === 'video' && <video src={resolveUrl(a.url)} controls />}
          {(a.kind === 'audio' || a.kind === 'voice') && (
            <audio src={resolveUrl(a.url)} controls />
          )}
          {a.kind === 'file' && (
            <a className="lc-chat-attach-link" href={resolveUrl(a.url)} download={a.fileName}>
              📎 {a.fileName}
            </a>
          )}
        </div>
      ))}
    </div>
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
}: {
  announcements: GroupAnnouncement[];
  onResponded: (announcementId: number) => void;
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

  return (
    <div className="modal-backdrop lc-announcement-ack-backdrop" role="presentation">
      <div
        className="modal lc-announcement-ack-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-announcement-ack-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="lc-announcement-ack-title">Объявление группы</h3>
        {announcements.length > 1 && (
          <p className="meta lc-announcement-ack-queue">
            Осталось ответить: {announcements.length}
          </p>
        )}
        <article className="lc-announcement-card">
          <div className="lc-announcement-card-meta">
            <span>{current.author.displayName}</span>
            <span className="meta">
              {formatAnnouncementWhen(current.createdAt)} · {formatMessageClock(current.createdAt)}
            </span>
          </div>
          {current.body && <div className="lc-announcement-card-body">{current.body}</div>}
          <AnnouncementAttachmentList attachments={current.attachments} />
        </article>
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
              Ознакомлен
            </button>
            <button type="button" disabled={busy} onClick={() => setNeedMoreMode(true)}>
              Нужно больше информации
            </button>
          </div>
        )}
        {err && <p className="error">{err}</p>}
      </div>
    </div>
  );
}

export function GroupAnnouncementsModal({
  groupId,
  statsRefreshKey,
  onClose,
}: {
  groupId: number;
  statsRefreshKey: number;
  onClose: () => void;
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  }, [loadList]);

  useEffect(() => {
    if (selectedId == null) {
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
  }, [selectedId, statsRefreshKey]);

  async function createAnnouncement(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text && files.length === 0) {
      setErr('Введите текст или прикрепите файлы');
      return;
    }
    setCreateBusy(true);
    setErr('');
    try {
      const fd = new FormData();
      fd.append('body', text);
      for (const f of files) fd.append('files', f);
      const created = await apiForm<GroupAnnouncement>(`/api/groups/${groupId}/announcements`, fd);
      setBody('');
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadList();
      setSelectedId(created.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось создать объявление');
    } finally {
      setCreateBusy(false);
    }
  }

  async function deleteAnnouncement(id: number) {
    if (!(await uiConfirm('Удалить это объявление?', { title: 'Удаление объявления', danger: true, okText: 'Удалить' }))) return;
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

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal lc-announcements-modal"
        role="dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Объявления</h3>
        <form className="lc-announcement-create" onSubmit={(e) => void createAnnouncement(e)}>
          <label>
            Новое объявление
            <textarea
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Текст объявления…"
              disabled={createBusy}
            />
          </label>
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={createBusy}
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <button type="submit" className="primary" disabled={createBusy}>
              {createBusy ? 'Публикация…' : 'Опубликовать'}
            </button>
          </div>
          {files.length > 0 && (
            <p className="meta">Вложений: {files.length}</p>
          )}
        </form>
        {err && <p className="error">{err}</p>}
        {loading ? (
          <p className="meta">Загрузка…</p>
        ) : announcements.length === 0 ? (
          <p className="meta">Объявлений пока нет.</p>
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
                      {a.body.trim().slice(0, 80) || '(без текста)'}
                    </span>
                    <span className="meta">{formatAnnouncementWhen(a.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {selected && (
              <div className="lc-announcements-detail">
                <div className="lc-announcement-card">
                  <div className="lc-announcement-card-meta">
                    <span>{selected.author.displayName}</span>
                    <span className="meta">{formatAnnouncementWhen(selected.createdAt)}</span>
                  </div>
                  {selected.body && (
                    <div className="lc-announcement-card-body">{selected.body}</div>
                  )}
                  <AnnouncementAttachmentList attachments={selected.attachments} />
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="danger"
                    disabled={deleteBusy === selected.id}
                    onClick={() => void deleteAnnouncement(selected.id)}
                  >
                    {deleteBusy === selected.id ? 'Удаление…' : 'Удалить'}
                  </button>
                </div>
                {statsLoading ? (
                  <p className="meta">Загрузка статистики…</p>
                ) : stats ? (
                  <>
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
                    </div>
                    <div className="lc-announcement-stats-table-wrap">
                      <table className="lc-announcement-stats-table">
                        <thead>
                          <tr>
                            <th>ФИО</th>
                            <th>Статус</th>
                            <th>Комментарий</th>
                            <th>Время</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.members.map((m) => (
                            <tr key={m.userId}>
                              <td>
                                {m.displayName}
                                <span className="meta"> @{m.tag}</span>
                              </td>
                              <td>
                                <span
                                  className={`pill lc-announcement-status-pill lc-announcement-status-pill--${m.status === 'acknowledged' ? 'ack' : m.status === 'need_more' ? 'need' : 'pending'}`}
                                >
                                  {statusLabel(m.status)}
                                </span>
                              </td>
                              <td>{m.comment || '—'}</td>
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
