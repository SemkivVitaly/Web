/**
 * @fileoverview Панель задач группы в воркспейсе: доски (с опциональным паролем), канбан (`TaskBoardCanvas`),
 * иерархический список задач с комментариями, вложениями и журналом активности.
 *
 * Данные: REST (`/api/groups/:id/task-boards`, `/api/task-boards/:id/tasks`, PATCH задач и вложений) и сокет
 * `tasks:refresh` для обновления после изменений другими клиентами. Из чата приходят запросы подсветки задачи
 * и открытия доски без ручного выбора (`focusTaskIdRequest`, `taskRevealRequest`).
 */

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { api, apiForm } from '../api';
import { uiAlert, uiConfirm, uiPrompt } from '../ui/dialogs';
import type { TaskActivityEntry, TaskBoardSummary, TaskNode, User } from '../types';
import { TaskBoardCanvas } from './TaskBoardCanvas';
import { mergeBoardPwFromStore, rememberTaskBoardUnlock } from './taskBoardUnlockStorage';
import {
  TASK_TEXT_PREVIEW_MAX_BYTES,
  fetchUtf8TextLimited,
  formatTextIfJson,
  isTextPreviewableFile,
} from './filePreviewUtils';
import {
  TaskExcelPreviewBody,
  TaskWordPreviewBody,
  isExcelOfficePreviewable,
  isWordDocxPreviewable,
} from './officePreview';

// --- Утилиты: роль модератора, промпт целевого количества для задачи ---

function isModeratorRole(role: string) {
  return role === 'admin' || role === 'moderator';
}

/** Пустая строка / отмена — без счётчика; иначе целое ≥ 1 */
async function promptOptionalQuantityTarget(): Promise<number | undefined> {
  const q = await uiPrompt('Сколько единиц нужно сделать? (пусто — прогресс задаётся ползунком)', {
    title: 'Цель по количеству',
    allowEmpty: true,
  });
  if (q == null) return undefined;
  const t = q.trim();
  if (!t) return undefined;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n) || n < 1) {
    await uiAlert('Введите целое число не меньше 1 или оставьте поле пустым');
    return undefined;
  }
  return n;
}

// --- sessionStorage: какая доска была открыта в этой вкладке (на группу) ---

const TASKS_BOARD_STORAGE = (groupId: number) => `lc-tasks-selected-board-${groupId}`;

function readStoredSelectedBoard(groupId: number): number | null {
  try {
    const raw = sessionStorage.getItem(TASKS_BOARD_STORAGE(groupId));
    if (!raw) return null;
    const n = +raw;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeStoredSelectedBoard(groupId: number, boardId: number | null) {
  try {
    const k = TASKS_BOARD_STORAGE(groupId);
    if (boardId != null) sessionStorage.setItem(k, String(boardId));
    else sessionStorage.removeItem(k);
  } catch {
    /* ignore quota / private mode */
  }
}

type TaskStatusFilter = 'all' | 'todo' | 'in_progress' | 'review' | 'done';

/** Имя + фильтр по статусу; хранится в localStorage на пару (groupId, boardId). */
type TaskSavedView = {
  id: string;
  name: string;
  status: TaskStatusFilter;
};

function taskViewsStorageKey(groupId: number, boardId: number) {
  return `lc_tasks_views_v1_${groupId}_${boardId}`;
}

function loadTaskViews(groupId: number, boardId: number): TaskSavedView[] {
  try {
    const raw = localStorage.getItem(taskViewsStorageKey(groupId, boardId));
    if (!raw) return [];
    const p = JSON.parse(raw) as unknown;
    if (!Array.isArray(p)) return [];
    return p.filter(
      (x: unknown) =>
        x &&
        typeof x === 'object' &&
        typeof (x as TaskSavedView).id === 'string' &&
        typeof (x as TaskSavedView).name === 'string' &&
        typeof (x as TaskSavedView).status === 'string'
    ) as TaskSavedView[];
  } catch {
    return [];
  }
}

function saveTaskViews(groupId: number, boardId: number, views: TaskSavedView[]) {
  try {
    localStorage.setItem(taskViewsStorageKey(groupId, boardId), JSON.stringify(views));
  } catch {
    /* ignore */
  }
}

type TaskAttachmentRow = {
  id: number;
  url: string;
  fileName: string;
  mimeType?: string | null;
};

function isImageTaskAttachment(a: TaskAttachmentRow): boolean {
  const m = (a.mimeType || '').toLowerCase();
  if (m.startsWith('image/')) return true;
  const name = (a.fileName || '').toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|avif|heic)$/i.test(name)) return true;
  try {
    const path = new URL(a.url, 'http://local').pathname.toLowerCase();
    return /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif|heic)$/.test(path);
  } catch {
    return false;
  }
}

function isVideoTaskAttachment(a: TaskAttachmentRow): boolean {
  const m = (a.mimeType || '').toLowerCase();
  if (m.startsWith('video/')) return true;
  return /\.(mp4|webm|ogg|mov|m4v)$/i.test(a.fileName || '');
}

function isAudioTaskAttachment(a: TaskAttachmentRow): boolean {
  const m = (a.mimeType || '').toLowerCase();
  if (m.startsWith('audio/')) return true;
  return /\.(mp3|wav|m4a|ogg|flac)$/i.test(a.fileName || '');
}

function isPdfTaskAttachment(a: TaskAttachmentRow): boolean {
  const m = (a.mimeType || '').toLowerCase();
  if (m === 'application/pdf' || m.includes('pdf')) return true;
  return /\.pdf$/i.test(a.fileName || '');
}

type TaskFilePreviewState =
  | { kind: 'image'; url: string }
  | { kind: 'pdf'; url: string }
  | { kind: 'text'; url: string; fileName: string }
  | { kind: 'word'; url: string; fileName: string }
  | { kind: 'excel'; url: string; fileName: string };

function TaskAttachmentTextPreviewBody({ url, fileName }: { url: string; fileName: string }) {
  const [state, setState] = useState<'loading' | 'err' | 'ready'>('loading');
  const [body, setBody] = useState('');

  useEffect(() => {
    let cancel = false;
    setState('loading');
    setBody('');
    (async () => {
      const res = await fetchUtf8TextLimited(url, TASK_TEXT_PREVIEW_MAX_BYTES);
      if (cancel) return;
      if (!res.ok) {
        setBody(res.error);
        setState('err');
        return;
      }
      const fmt = fileName.toLowerCase().endsWith('.json') ? formatTextIfJson(res.text) : res.text;
      setBody(fmt);
      setState('ready');
    })();
    return () => {
      cancel = true;
    };
  }, [url, fileName]);

  if (state === 'loading') return <p className="meta lc-task-text-preview-status">Загрузка…</p>;
  if (state === 'err') return <p className="error lc-task-text-preview-status">{body}</p>;
  return <pre className="lc-task-text-preview-pre">{body}</pre>;
}

function flashTaskRowInDom(taskId: number): boolean {
  const el = document.getElementById(`lc-task-in-list-${taskId}`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  el.classList.add('lc-task-flash');
  window.setTimeout(() => el.classList.remove('lc-task-flash'), 1400);
  return true;
}

function taskIdInTree(nodes: TaskNode[], id: number): boolean {
  for (const n of nodes) {
    if (n.id === id) return true;
    const ch = n.children;
    if (ch?.length && taskIdInTree(ch, id)) return true;
  }
  return false;
}

function formatTaskActivityLine(a: TaskActivityEntry): string {
  const name = a.author.displayName || `@${a.author.tag}` || 'Участник';
  const p = a.payload;
  switch (a.action) {
    case 'task_created':
      return `${name}: создал(а) задачу «${String(p.title ?? '')}»${p.quantityTarget ? ` (цель: ${p.quantityTarget} ед.)` : ''}`;
    case 'title':
      return `${name}: изменил(а) заголовок`;
    case 'description':
      return `${name}: изменил(а) описание`;
    case 'status':
      return `${name}: статус «${p.from}» → «${p.to}»`;
    case 'progress':
      return `${name}: прогресс ${p.from}% → ${p.to}%`;
    case 'quantity_add':
      return `${name}: к счётчику +${p.add} (${p.doneBefore}→${p.doneAfter} из ${p.target})`;
    case 'quantity_target':
      return `${name}: цель по количеству: ${p.before == null ? 'нет' : p.before} → ${p.after == null ? 'нет' : p.after}`;
    case 'assignee':
      return `${name}: изменил(а) исполнителя`;
    case 'parent':
      return `${name}: изменил(а) вложенность в дереве`;
    case 'comment_add': {
      const text = String(p.preview ?? '');
      return `${name}: комментарий — ${text}${text.length >= 160 ? '…' : ''}`;
    }
    case 'attachment_add':
      return `${name}: прикрепил(а) файл «${String(p.fileName ?? '')}»`;
    default:
      return `${name}: ${a.action}`;
  }
}

type TreeNode = TaskNode & { children: TreeNode[] };

function filterTaskTreeByStatus(nodes: TreeNode[], status: TaskStatusFilter): TreeNode[] {
  if (status === 'all') return nodes;
  const out: TreeNode[] = [];
  for (const n of nodes) {
    const ch = filterTaskTreeByStatus(n.children, status);
    if (n.status === status) {
      out.push({ ...n, children: n.children });
    } else if (ch.length > 0) {
      out.push({ ...n, children: ch });
    }
  }
  return out;
}

function filterTaskTreeByTitle(nodes: TreeNode[], rawQuery: string): TreeNode[] {
  const needle = rawQuery.trim().toLowerCase();
  if (!needle) return nodes;
  const out: TreeNode[] = [];
  for (const n of nodes) {
    const ch = filterTaskTreeByTitle(n.children, needle);
    const selfMatch = String(n.title || '').toLowerCase().includes(needle);
    if (selfMatch) {
      out.push({ ...n, children: n.children });
    } else if (ch.length > 0) {
      out.push({ ...n, children: ch });
    }
  }
  return out;
}

function toTree(flat: TaskNode[]): TreeNode[] {
  const list = Array.isArray(flat) ? flat : [];
  const map = new Map<number, TreeNode>();
  for (const t of list) {
    map.set(t.id, { ...t, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const t of list) {
    const n = map.get(t.id)!;
    if (t.parentId == null) roots.push(n);
    else {
      const p = map.get(t.parentId);
      if (p) p.children.push(n);
      else roots.push(n);
    }
  }
  return roots;
}

// --- Список задач: рекурсивное дерево и строка с раскрытием комментариев / превью файлов ---

function TaskTree({
  nodes,
  depth,
  boardId,
  boardPassword,
  onChanged,
  me,
  groupRole,
  onTaskListContext,
}: {
  nodes: TreeNode[];
  depth: number;
  boardId: number;
  boardPassword: string;
  onChanged: () => void;
  me: User;
  groupRole: string;
  onTaskListContext?: (taskId: number) => void;
}) {
  const [openComments, setOpenComments] = useState<Record<number, boolean>>({});

  return (
    <ul className={`lc-task-tree depth-${depth}`}>
      {nodes.map((t) => (
        <li key={t.id}>
          <TaskRow
            task={t}
            depth={depth}
            boardId={boardId}
            boardPassword={boardPassword}
            onChanged={onChanged}
            commentsOpen={!!openComments[t.id]}
            onToggleComments={() => setOpenComments((o) => ({ ...o, [t.id]: !o[t.id] }))}
            me={me}
            groupRole={groupRole}
            onTaskListContext={onTaskListContext}
          />
          {t.children.length > 0 && (
            <TaskTree
              nodes={t.children}
              depth={depth + 1}
              boardId={boardId}
              boardPassword={boardPassword}
              onChanged={onChanged}
              me={me}
              groupRole={groupRole}
              onTaskListContext={onTaskListContext}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function TaskRow({
  task,
  depth,
  boardId,
  boardPassword,
  onChanged,
  commentsOpen,
  onToggleComments,
  me,
  groupRole,
  onTaskListContext,
}: {
  task: TreeNode;
  depth: number;
  boardId: number;
  boardPassword: string;
  onChanged: () => void;
  commentsOpen: boolean;
  onToggleComments: () => void;
  me: User;
  groupRole: string;
  onTaskListContext?: (taskId: number) => void;
}) {
  const [localTitle, setLocalTitle] = useState(task.title);
  const titleDirty = useRef(false);
  useEffect(() => {
    if (!titleDirty.current) setLocalTitle(task.title);
  }, [task.title]);
  const [localDescription, setLocalDescription] = useState(task.description);
  const descDirty = useRef(false);
  useEffect(() => {
    if (!descDirty.current) setLocalDescription(task.description);
  }, [task.description]);
  const [commentText, setCommentText] = useState('');
  const [pendingCommentFiles, setPendingCommentFiles] = useState<File[]>([]);
  const [commentsFileDropHover, setCommentsFileDropHover] = useState(false);
  const commentPhotoInputRef = useRef<HTMLInputElement>(null);
  const [comments, setComments] = useState<{ id: number; body: string; author: User; createdAt: string }[]>([]);
  const [atts, setAtts] = useState<TaskAttachmentRow[]>([]);
  const [filePreview, setFilePreview] = useState<TaskFilePreviewState | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityRows, setActivityRows] = useState<TaskActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const loadExtra = useCallback(async () => {
    const q = boardPassword ? `?password=${encodeURIComponent(boardPassword)}` : '';
    const [c, a] = await Promise.all([
      api<{ id: number; body: string; author: User; createdAt: string }[]>(`/api/tasks/${task.id}/comments${q}`),
      api<TaskAttachmentRow[]>(`/api/tasks/${task.id}/attachments${q}`),
    ]);
    setComments(c);
    setAtts(a);
  }, [task.id, boardPassword]);

  useEffect(() => {
    if (commentsOpen) loadExtra();
  }, [commentsOpen, loadExtra]);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const q = boardPassword ? `?password=${encodeURIComponent(boardPassword)}` : '';
      const rows = await api<TaskActivityEntry[]>(`/api/tasks/${task.id}/activity${q}`);
      setActivityRows(Array.isArray(rows) ? rows : []);
    } catch (e) {
      await uiAlert((e as Error).message);
    } finally {
      setActivityLoading(false);
    }
  }, [task.id, boardPassword]);

  useEffect(() => {
    if (activityOpen) void loadActivity();
  }, [activityOpen, loadActivity]);

  async function savePatch(body: Record<string, unknown>) {
    try {
      await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        json: { password: boardPassword || undefined, ...body },
      });
      onChanged();
      if (activityOpen) void loadActivity();
    } catch (er) {
      await uiAlert((er as Error).message);
    }
  }

  const canDeleteTask =
    isModeratorRole(groupRole) || (task.createdById != null && task.createdById === me.id);
  const canDeleteComment = (authorId: number) =>
    isModeratorRole(groupRole) || authorId === me.id;

  async function uploadTaskAttachmentFiles(files: File[]) {
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file);
      if (boardPassword) fd.append('password', boardPassword);
      await apiForm(`/api/tasks/${task.id}/attachments`, fd);
    }
    await loadExtra();
    onChanged();
    if (activityOpen) void loadActivity();
  }

  async function sendTaskComment() {
    const textTrim = commentText.trim();
    const files = pendingCommentFiles;
    if (!textTrim && files.length === 0) return;
    try {
      if (files.length) await uploadTaskAttachmentFiles(files);
      const bodyToSend =
        textTrim ||
        (files.length ? files.map((f) => `📎 ${f.name}`).join('; ') : '');
      if (bodyToSend.trim()) {
        await api(`/api/tasks/${task.id}/comments`, {
          method: 'POST',
          json: { password: boardPassword || undefined, body: bodyToSend },
        });
      }
      setCommentText('');
      setPendingCommentFiles([]);
      if (commentPhotoInputRef.current) commentPhotoInputRef.current.value = '';
      loadExtra();
      onChanged();
      if (activityOpen) void loadActivity();
    } catch (er) {
      await uiAlert((er as Error).message);
    }
  }

  return (
    <div
      id={`lc-task-in-list-${task.id}`}
      className="lc-task-row"
      style={{ marginLeft: depth * 16 }}
      onPointerDownCapture={() => onTaskListContext?.(task.id)}
    >
      <div className="lc-task-main">
        <div className="lc-task-topline">
          <input
            className="lc-task-title"
            value={localTitle}
            onChange={(e) => {
              titleDirty.current = true;
              setLocalTitle(e.target.value);
            }}
            onBlur={async () => {
              titleDirty.current = false;
              if (localTitle !== task.title) await savePatch({ title: localTitle });
            }}
          />
          <span
            className="pill"
            title="Свой % — от ползунка или счётчика; эффективный — с учётом подзадач (не 100%, пока не готовы все дочерние)"
          >
            {task.quantityTarget != null && task.quantityTarget > 0 ? (
              <>
                счёт {task.quantityDone}/{task.quantityTarget} → {task.progress}% · эфф. {task.effectiveProgress}%
              </>
            ) : (
              <>
                свой {task.progress}% · эфф. {task.effectiveProgress}%
              </>
            )}
          </span>
        </div>
        <textarea
          className="lc-task-description"
          rows={2}
          placeholder="Описание задачи…"
          value={localDescription}
          onChange={(e) => {
            descDirty.current = true;
            setLocalDescription(e.target.value);
          }}
          onBlur={async () => {
            descDirty.current = false;
            if (localDescription !== task.description) await savePatch({ description: localDescription });
          }}
        />
      </div>
      <div className="lc-task-controls">
        <select
          className="lc-select-compact"
          value={task.status}
          onChange={(e) => void savePatch({ status: e.target.value })}
        >
          <option value="todo">К выполнению</option>
          <option value="in_progress">В работе</option>
          <option value="review">На проверке</option>
          <option value="done">Готово</option>
        </select>
        <input
          type="range"
          min={0}
          max={100}
          value={task.progress}
          disabled={task.quantityTarget != null && task.quantityTarget > 0}
          title={
            task.quantityTarget != null && task.quantityTarget > 0
              ? 'Прогресс от счётчика — ползунок отключён'
              : undefined
          }
          onChange={(e) => void savePatch({ progress: +e.target.value })}
        />
        {task.quantityTarget != null && task.quantityTarget > 0 ? (
          <button
            type="button"
            title="Добавить к числу выполненных единиц"
            onClick={async () => {
              const left = task.quantityTarget! - task.quantityDone;
              const raw = await uiPrompt(`Сколько единиц отметить сделанными? (осталось ${left})`, {
                title: 'Отметить выполненное',
                defaultValue: '1',
              });
              if (raw == null || !String(raw).trim()) return;
              const n = parseInt(String(raw).trim(), 10);
              if (!Number.isFinite(n) || n < 1) {
                await uiAlert('Введите целое число ≥ 1');
                return;
              }
              void savePatch({ quantityAdd: n });
            }}
          >
            + к счёту
          </button>
        ) : null}
        <button
          type="button"
          onClick={async () => {
            const title = await uiPrompt('Подзадача', { title: 'Новая подзадача', defaultValue: 'Новая подзадача' });
            if (!title) return;
            const description = (await uiPrompt('Описание подзадачи (необязательно)', { title: 'Новая подзадача', allowEmpty: true })) || '';
            const quantityTarget = await promptOptionalQuantityTarget();
            try {
              await api(`/api/task-boards/${boardId}/tasks`, {
                method: 'POST',
                json: {
                  password: boardPassword || undefined,
                  parentId: task.id,
                  title,
                  description: description.trim() || undefined,
                  ...(quantityTarget != null ? { quantityTarget } : {}),
                },
              });
              onChanged();
            } catch (er) {
              await uiAlert((er as Error).message);
            }
          }}
        >
          + Подзадача
        </button>
        <button type="button" onClick={onToggleComments}>
          Комментарии ({comments.length})
        </button>
        <button type="button" onClick={() => setActivityOpen((o) => !o)}>
          Ход работы{activityOpen ? ' ▴' : ' ▾'}
        </button>
        {canDeleteTask && (
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (!(await uiConfirm('Удалить задачу и подзадачи?', { title: 'Удаление задачи', danger: true, okText: 'Удалить' }))) return;
              const q = boardPassword ? `?password=${encodeURIComponent(boardPassword)}` : '';
              await api(`/api/tasks/${task.id}${q}`, { method: 'DELETE' });
              onChanged();
            }}
          >
            Удалить
          </button>
        )}
      </div>
      {activityOpen && (
        <div className="lc-task-activity-panel">
          <div className="lc-task-activity-head">Кто что менял</div>
          {activityLoading ? (
            <p className="meta">Загрузка…</p>
          ) : activityRows.length === 0 ? (
            <p className="meta">Записей пока нет (появятся после изменений задачи).</p>
          ) : (
            <ul className="lc-task-activity-list">
              {activityRows.map((r) => (
                <li key={r.id}>
                  <span className="lc-task-activity-time">{r.createdAt}</span>
                  <span className="lc-task-activity-text">{formatTaskActivityLine(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {commentsOpen && (
        <div
          className={`lc-task-comments${commentsFileDropHover ? ' lc-task-comments--file-drop' : ''}`}
          onDragEnter={(e) => {
            if (![...e.dataTransfer.types].includes('Files')) return;
            e.preventDefault();
            setCommentsFileDropHover(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setCommentsFileDropHover(false);
          }}
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => {
            e.preventDefault();
            setCommentsFileDropHover(false);
            const list = e.dataTransfer.files?.length ? [...e.dataTransfer.files] : [];
            if (list.length) void uploadTaskAttachmentFiles(list).catch((er) => void uiAlert((er as Error).message));
          }}
        >
          <p className="meta lc-task-comments-drop-hint">
            Вложения и комментарии — можно перетащить файлы сюда.
          </p>
          {atts.map((x) => (
            <div key={x.id} className="lc-task-attach-block">
              <a href={x.url} target="_blank" rel="noreferrer">
                📎 {x.fileName}
              </a>
              {isImageTaskAttachment(x) && (
                <button
                  type="button"
                  className="lc-task-thumb-btn"
                  title="Открыть предпросмотр"
                  onClick={() => setFilePreview({ url: x.url, kind: 'image' })}
                >
                  <img src={x.url} alt="" className="lc-task-thumb" />
                </button>
              )}
              {isVideoTaskAttachment(x) && !isImageTaskAttachment(x) && (
                <video
                  src={x.url}
                  controls
                  className="lc-task-thumb lc-task-thumb--video"
                  preload="metadata"
                />
              )}
              {isAudioTaskAttachment(x) && !isImageTaskAttachment(x) && !isVideoTaskAttachment(x) && (
                <audio src={x.url} controls className="lc-task-audio-preview" />
              )}
              {isPdfTaskAttachment(x) && !isImageTaskAttachment(x) && (
                <button
                  type="button"
                  className="lc-task-pdf-preview-link"
                  onClick={() => setFilePreview({ url: x.url, kind: 'pdf' })}
                >
                  Предпросмотр PDF
                </button>
              )}
              {isWordDocxPreviewable(x.mimeType, x.fileName) &&
                !isImageTaskAttachment(x) &&
                !isVideoTaskAttachment(x) &&
                !isAudioTaskAttachment(x) &&
                !isPdfTaskAttachment(x) && (
                  <button
                    type="button"
                    className="lc-task-pdf-preview-link"
                    onClick={() =>
                      setFilePreview({
                        url: x.url,
                        kind: 'word',
                        fileName: x.fileName || 'документ.docx',
                      })
                    }
                  >
                    Предпросмотр Word
                  </button>
                )}
              {isExcelOfficePreviewable(x.mimeType, x.fileName) &&
                !isImageTaskAttachment(x) &&
                !isVideoTaskAttachment(x) &&
                !isAudioTaskAttachment(x) &&
                !isPdfTaskAttachment(x) &&
                !isWordDocxPreviewable(x.mimeType, x.fileName) && (
                  <button
                    type="button"
                    className="lc-task-pdf-preview-link"
                    onClick={() =>
                      setFilePreview({
                        url: x.url,
                        kind: 'excel',
                        fileName: x.fileName || 'книга.xlsx',
                      })
                    }
                  >
                    Предпросмотр Excel
                  </button>
                )}
              {isTextPreviewableFile(x.mimeType, x.fileName) &&
                !isImageTaskAttachment(x) &&
                !isVideoTaskAttachment(x) &&
                !isAudioTaskAttachment(x) &&
                !isPdfTaskAttachment(x) &&
                !isWordDocxPreviewable(x.mimeType, x.fileName) &&
                !isExcelOfficePreviewable(x.mimeType, x.fileName) && (
                  <button
                    type="button"
                    className="lc-task-pdf-preview-link"
                    onClick={() =>
                      setFilePreview({ url: x.url, kind: 'text', fileName: x.fileName || 'файл' })
                    }
                  >
                    Предпросмотр текста
                  </button>
                )}
            </div>
          ))}
          {comments.map((c) => (
            <div key={c.id} className="lc-comment">
              <div className="lc-comment-head">
                <span>
                  <strong>{c.author.displayName}</strong> · {c.createdAt}
                </span>
                {canDeleteComment(c.author.id) && (
                  <button
                    type="button"
                    className="danger lc-comment-delete"
                    title="Удалить комментарий"
                    onClick={async () => {
                      if (!(await uiConfirm('Удалить этот комментарий?', { title: 'Удаление комментария', danger: true, okText: 'Удалить' }))) return;
                      const q = boardPassword ? `?password=${encodeURIComponent(boardPassword)}` : '';
                      await api(`/api/tasks/${task.id}/comments/${c.id}${q}`, { method: 'DELETE' });
                      loadExtra();
                      onChanged();
                    }}
                  >
                    Удалить
                  </button>
                )}
              </div>
              <div>{c.body}</div>
            </div>
          ))}
          {pendingCommentFiles.length > 0 && (
            <div className="lc-task-comment-pending-files meta">
              {pendingCommentFiles.map((f, i) => (
                <span key={`${f.name}-${i}`} className="lc-task-comment-pending-file">
                  {f.name}
                  <button
                    type="button"
                    className="lc-task-comment-pending-photo-clear"
                    aria-label="Убрать файл"
                    onClick={() =>
                      setPendingCommentFiles((prev) => prev.filter((_, j) => j !== i))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div
            className="row-actions lc-task-comment-compose"
            onDragOver={(e) => {
              if (![...e.dataTransfer.types].includes('Files')) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={(e) => {
              e.preventDefault();
              const list = [...(e.dataTransfer.files || [])];
              if (list.length) setPendingCommentFiles((prev) => [...prev, ...list]);
            }}
          >
            <input
              className="lc-task-comment-field"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Комментарий… (можно перетащить файлы)"
            />
            <input
              ref={commentPhotoInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const fl = e.target.files?.length ? [...e.target.files] : [];
                if (fl.length) setPendingCommentFiles((prev) => [...prev, ...fl]);
                e.target.value = '';
              }}
            />
            <button type="button" onClick={() => commentPhotoInputRef.current?.click()}>
              Прикрепить файлы
            </button>
            <button type="button" className="primary" onClick={() => void sendTaskComment()}>
              Отправить
            </button>
          </div>
        </div>
      )}
      {filePreview && (
        <div
          className="modal-backdrop lc-task-file-lightbox"
          role="presentation"
          onClick={() => setFilePreview(null)}
        >
          <div
            className={`lc-task-file-lightbox-inner${
              filePreview.kind === 'text'
                ? ' lc-task-file-lightbox-inner--text'
                : filePreview.kind === 'word' || filePreview.kind === 'excel'
                  ? ' lc-task-file-lightbox-inner--office'
                  : ''
            }`}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="lc-task-file-lightbox-close"
              aria-label="Закрыть"
              onClick={() => setFilePreview(null)}
            >
              ×
            </button>
            {filePreview.kind === 'image' ? (
              <img src={filePreview.url} alt="" className="lc-task-file-lightbox-img" />
            ) : filePreview.kind === 'pdf' ? (
              <iframe title="PDF" src={filePreview.url} className="lc-task-file-lightbox-pdf" />
            ) : filePreview.kind === 'text' ? (
              <>
                <div className="lc-task-file-lightbox-caption meta">{filePreview.fileName}</div>
                <TaskAttachmentTextPreviewBody url={filePreview.url} fileName={filePreview.fileName} />
              </>
            ) : filePreview.kind === 'word' ? (
              <>
                <div className="lc-task-file-lightbox-caption meta">{filePreview.fileName}</div>
                <TaskWordPreviewBody url={filePreview.url} />
              </>
            ) : filePreview.kind === 'excel' ? (
              <>
                <div className="lc-task-file-lightbox-caption meta">{filePreview.fileName}</div>
                <TaskExcelPreviewBody url={filePreview.url} />
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Панель задач внутри группового воркспейса: выбор доски, канбан и древовидный список.
 *
 * @param groupId — идентификатор группы
 * @param socket — клиент Socket.IO (подписка на `tasks:refresh`)
 * @param me — текущий пользователь (права на удаление своих сущностей)
 * @param groupRole — роль в группе (`admin` / `moderator` / …) для модераторских действий
 * @param onOpenCollabDocument — открыть коллаб-документ; второй аргумент — задача для контекста «назад» из редактора
 * @param focusTaskIdRequest — снаружи: прокрутить и подсветить задачу в списке (например после возврата с документа)
 * @param onFocusTaskIdRequestHandled — вызвать после попытки обработать `focusTaskIdRequest`
 * @param taskRevealRequest — из чата: переключить доску и подсветить задачу (если пароль уже известен)
 * @param onTaskRevealHandled — вызвать после сценария `taskRevealRequest`
 */
export function TasksPanel({
  groupId,
  socket,
  me,
  groupRole,
  onOpenCollabDocument,
  focusTaskIdRequest,
  onFocusTaskIdRequestHandled,
  taskRevealRequest,
  onTaskRevealHandled,
}: {
  groupId: number;
  socket: Socket;
  me: User;
  groupRole: string;
  /** Второй аргумент — задача из списка/канваса, к которой вернуться после «Назад» из документа */
  onOpenCollabDocument: (docId: number, listContextTaskId?: number | null) => void;
  /** После возврата с документа: прокрутка и подсветка строки задачи в списке */
  focusTaskIdRequest?: number | null;
  onFocusTaskIdRequestHandled?: () => void;
  /** Открыть доску без пароля и подсветить задачу (переход из чата) */
  taskRevealRequest?: { taskId: number; boardId: number; nonce: number } | null;
  onTaskRevealHandled?: () => void;
}) {
  // --- Состояние: доски, выбранная доска, плоский список задач, пароли, фильтр и сохранённые виды ---

  const [boards, setBoards] = useState<TaskBoardSummary[]>([]);
  const [selectedBoard, setSelectedBoardState] = useState<number | null>(() =>
    readStoredSelectedBoard(groupId)
  );
  const [tasks, setTasks] = useState<TaskNode[]>([]);
  const [boardPw, setBoardPw] = useState<Record<number, string>>({});
  const [modal, setModal] = useState(false);
  const [editBoard, setEditBoard] = useState<TaskBoardSummary | null>(null);
  const [err, setErr] = useState('');
  const [boardsReady, setBoardsReady] = useState(false);
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>('all');
  const [taskTitleSearch, setTaskTitleSearch] = useState('');
  const [savedViews, setSavedViews] = useState<TaskSavedView[]>([]);
  const listContextTaskIdRef = useRef<number | null>(null);

  const setSelectedBoard = useCallback(
    (id: number | null) => {
      setSelectedBoardState(id);
      writeStoredSelectedBoard(groupId, id);
    },
    [groupId]
  );

  useEffect(() => {
    setSelectedBoardState(readStoredSelectedBoard(groupId));
  }, [groupId]);

  useEffect(() => {
    listContextTaskIdRef.current = null;
  }, [selectedBoard]);

  const storedBoardPw = useMemo(() => mergeBoardPwFromStore(groupId, boards), [groupId, boards]);
  const effectiveBoardPw = useMemo(
    () => ({ ...storedBoardPw, ...boardPw }),
    [storedBoardPw, boardPw]
  );
  const currentPw = selectedBoard != null ? effectiveBoardPw[selectedBoard] || '' : '';
  const canDeleteBoard = (b: TaskBoardSummary) => b.createdById === me.id || isModeratorRole(groupRole);
  const canEditBoard = canDeleteBoard;

  // --- Загрузка досок и задач; сокет обновляет дерево при изменениях на сервере ---

  const loadBoards = useCallback(async () => {
    const b = await api<TaskBoardSummary[]>(`/api/groups/${groupId}/task-boards`);
    setBoards(Array.isArray(b) ? b : []);
  }, [groupId]);

  const loadTasks = useCallback(async () => {
    if (selectedBoard == null) return;
    const pw = effectiveBoardPw[selectedBoard] || '';
    const q = pw ? `?password=${encodeURIComponent(pw)}` : '';
    try {
      const t = await api<TaskNode[]>(`/api/task-boards/${selectedBoard}/tasks${q}`);
      setTasks(Array.isArray(t) ? t : []);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
      setTasks([]);
    }
  }, [selectedBoard, effectiveBoardPw]);

  useEffect(() => {
    setBoardsReady(false);
    void loadBoards()
      .then(() => setBoardsReady(true))
      .catch((e: Error) => {
        setBoardsReady(true);
        setErr(e.message);
      });
  }, [loadBoards]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    const h = (p: { boardId: number }) => {
      if (p.boardId === selectedBoard) loadTasks();
      loadBoards();
    };
    socket.on('tasks:refresh', h);
    return () => {
      socket.off('tasks:refresh', h);
    };
  }, [socket, selectedBoard, loadTasks, loadBoards]);

  // --- Дерево из плоского API, фильтр по статусу, локальные «быстрые виды» ---

  const tree = useMemo(() => toTree(tasks), [tasks]);

  useEffect(() => {
    if (selectedBoard == null) {
      setSavedViews([]);
      return;
    }
    setSavedViews(loadTaskViews(groupId, selectedBoard));
    setStatusFilter('all');
    setTaskTitleSearch('');
  }, [groupId, selectedBoard]);

  const filteredTree = useMemo(() => {
    const byStatus = filterTaskTreeByStatus(tree, statusFilter);
    return filterTaskTreeByTitle(byStatus, taskTitleSearch);
  }, [tree, statusFilter, taskTitleSearch]);

  const registerListContextTask = useCallback((taskId: number) => {
    listContextTaskIdRef.current = taskId;
  }, []);

  const focusTaskInList = useCallback((taskId: number) => {
    listContextTaskIdRef.current = taskId;
    flashTaskRowInDom(taskId);
  }, []);

  const openCollabFromBoard = useCallback(
    (docId: number) => {
      onOpenCollabDocument(docId, listContextTaskIdRef.current);
    },
    [onOpenCollabDocument]
  );

  // --- Запросы из родителя: подсветка задачи, открытие доски из чата ---

  useEffect(() => {
    if (focusTaskIdRequest == null || !Number.isFinite(focusTaskIdRequest) || focusTaskIdRequest <= 0) {
      return;
    }
    const id = focusTaskIdRequest;
    const done = () => onFocusTaskIdRequestHandled?.();
    if (flashTaskRowInDom(id)) {
      done();
      return;
    }
    const t = window.setTimeout(() => {
      flashTaskRowInDom(id);
      done();
    }, 380);
    return () => clearTimeout(t);
  }, [focusTaskIdRequest, tasks, selectedBoard, onFocusTaskIdRequestHandled]);

  useEffect(() => {
    if (!taskRevealRequest || !onTaskRevealHandled) return;
    if (!boardsReady) return;
    const { taskId, boardId } = taskRevealRequest;
    const board = boards.find((b) => b.id === boardId);
    if (!board) {
      onTaskRevealHandled();
      return;
    }
    if (board.hasPassword && !(effectiveBoardPw[boardId] ?? '').trim()) {
      onTaskRevealHandled();
      return;
    }
    if (selectedBoard !== boardId) {
      setSelectedBoard(boardId);
      return;
    }
    if (tasks.length === 0) return;
    if (!taskIdInTree(tasks, taskId)) {
      onTaskRevealHandled();
      return;
    }
    flashTaskRowInDom(taskId);
    onTaskRevealHandled();
  }, [
    taskRevealRequest,
    boardsReady,
    boards,
    effectiveBoardPw,
    selectedBoard,
    tasks,
    setSelectedBoard,
    onTaskRevealHandled,
  ]);

  // --- UI: выбор доски с запросом пароля при необходимости ---

  async function selectBoard(b: TaskBoardSummary) {
    if (b.hasPassword && !(effectiveBoardPw[b.id] ?? '').trim()) {
      const p = (await uiPrompt(`Пароль доски «${b.name}»`, { title: 'Требуется пароль', localStorageNotice: true })) || '';
      if (!p) return;
      setBoardPw((prev) => ({ ...prev, [b.id]: p }));
      rememberTaskBoardUnlock(groupId, b.id, b.passwordFingerprint, p);
    }
    setSelectedBoard(b.id);
  }

  // --- Разметка: список досок | канбан + фильтр + дерево; модалки создания/редактирования доски ---

  return (
    <div className="lc-workspace-panel">
      <div className="row-actions">
        <button type="button" className="primary" onClick={() => setModal(true)}>
          + Доска задач
        </button>
        {selectedBoard != null && (
          <button type="button" onClick={() => setSelectedBoard(null)}>
            Все доски
          </button>
        )}
      </div>
      {err && <p className="error">{err}</p>}

      {selectedBoard == null && (
        <ul className="lc-doc-list">
          {boards.map((b) => (
            <li key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <button
                type="button"
                className="chat-item"
                style={{ flex: 1, textAlign: 'left' }}
                onClick={() => selectBoard(b)}
              >
                <span>
                  {b.name} {b.hasPassword ? '🔒' : ''}
                </span>
              </button>
              {canEditBoard(b) && (
                <button type="button" onClick={() => setEditBoard(b)}>
                  Изменить
                </button>
              )}
              {canDeleteBoard(b) && (
                <button
                  type="button"
                  className="danger"
                  onClick={async () => {
                    if (!(await uiConfirm(`Удалить доску «${b.name}» и все задачи?`, { title: 'Удаление доски', danger: true, okText: 'Удалить' }))) return;
                    let pw = effectiveBoardPw[b.id] || '';
                    if (b.hasPassword && !pw) {
                      pw = (await uiPrompt('Пароль доски', { title: 'Требуется пароль', localStorageNotice: true })) || '';
                      if (!pw) return;
                    }
                    const q = pw ? `?password=${encodeURIComponent(pw)}` : '';
                    await api(`/api/task-boards/${b.id}${q}`, { method: 'DELETE' });
                    loadBoards();
                  }}
                >
                  Удалить
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {selectedBoard != null && (
        <>
          <TaskBoardCanvas
            groupId={groupId}
            boardId={selectedBoard}
            boardPassword={currentPw}
            socket={socket}
            taskTreeRoots={filteredTree}
            me={me}
            groupRole={groupRole}
            onReloadTasks={loadTasks}
            onOpenCollabDocument={openCollabFromBoard}
            onFocusTaskInList={focusTaskInList}
          />
          <div className="row-actions lc-task-list-toolbar lc-task-filter-bar">
            <label className="lc-workspace-name-search lc-task-title-search">
              <span className="lc-workspace-name-search-label">Название</span>
              <input
                type="search"
                className="lc-workspace-search-input"
                value={taskTitleSearch}
                onChange={(e) => setTaskTitleSearch(e.target.value)}
                placeholder="Поиск по названию задачи"
                aria-label="Поиск задач по названию"
              />
            </label>
            <label className="lc-task-filter-label">
              Статус
              <select
                className="lc-select-field"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as TaskStatusFilter)}
              >
                <option value="all">Все</option>
                <option value="todo">К выполнению</option>
                <option value="in_progress">В работе</option>
                <option value="review">На проверке</option>
                <option value="done">Готово</option>
              </select>
            </label>
            <button
              type="button"
              title="Сохранить текущий фильтр как быстрый вид"
              onClick={async () => {
                const name = await uiPrompt('Название сохранённого вида', { title: 'Сохранить вид' });
                if (name == null || !name.trim()) return;
                const id = `v_${Date.now()}`;
                const next: TaskSavedView[] = [
                  ...savedViews,
                  { id, name: name.trim(), status: statusFilter },
                ];
                setSavedViews(next);
                saveTaskViews(groupId, selectedBoard, next);
              }}
            >
              Сохранить вид
            </button>
            {savedViews.length > 0 && (
              <span className="lc-task-saved-views">
                {savedViews.map((v) => (
                  <span key={v.id} className="lc-task-saved-view-chip">
                    <button type="button" className="lc-task-saved-view-apply" onClick={() => setStatusFilter(v.status)}>
                      {v.name}
                    </button>
                    <button
                      type="button"
                      className="lc-task-saved-view-remove"
                      title="Удалить вид"
                      aria-label={`Удалить вид ${v.name}`}
                      onClick={() => {
                        const next = savedViews.filter((x) => x.id !== v.id);
                        setSavedViews(next);
                        saveTaskViews(groupId, selectedBoard, next);
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="row-actions lc-task-list-toolbar">
            <button
              type="button"
              className="primary"
              onClick={async () => {
                const title = await uiPrompt('Название задачи (корень)', { title: 'Новая задача' });
                if (!title) return;
                const description = (await uiPrompt('Описание (необязательно)', { title: 'Новая задача', allowEmpty: true })) || '';
                const quantityTarget = await promptOptionalQuantityTarget();
                try {
                  await api(`/api/task-boards/${selectedBoard}/tasks`, {
                    method: 'POST',
                    json: {
                      password: currentPw || undefined,
                      title,
                      description: description.trim() || undefined,
                      ...(quantityTarget != null ? { quantityTarget } : {}),
                    },
                  });
                  loadTasks();
                } catch (er) {
                  await uiAlert((er as Error).message);
                }
              }}
            >
              + Задача (список)
            </button>
          </div>
          <TaskTree
            nodes={filteredTree}
            depth={0}
            boardId={selectedBoard}
            boardPassword={currentPw}
            onChanged={loadTasks}
            me={me}
            groupRole={groupRole}
            onTaskListContext={registerListContextTask}
          />
        </>
      )}

      {editBoard && (
        <div className="modal-backdrop" role="presentation" onClick={() => setEditBoard(null)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Доска «{editBoard.name}»</h3>
            <form
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const clear = fd.get('clearPassword') === 'on';
                const newPw = String(fd.get('newPassword') || '').trim();
                const name = String(fd.get('name') || '').trim();
                if (!name) {
                  await uiAlert('Введите название доски');
                  return;
                }
                const json: Record<string, unknown> = { name };
                if (clear) json.clearPassword = true;
                else if (newPw) json.password = newPw;
                try {
                  await api(`/api/task-boards/${editBoard.id}`, { method: 'PATCH', json });
                  setEditBoard(null);
                  loadBoards();
                } catch (er) {
                  await uiAlert((er as Error).message);
                }
              }}
            >
              <div className="field">
                <label>Название</label>
                <input name="name" defaultValue={editBoard.name} />
              </div>
              <div className="field">
                <label>Новый пароль доски (пусто — не менять)</label>
                <input name="newPassword" type="password" />
              </div>
              <div className="field lc-field-checkbox">
                <label>
                  <input name="clearPassword" type="checkbox" /> Снять пароль с доски
                </label>
              </div>
              <button type="submit" className="primary">
                Сохранить
              </button>
            </form>
            <button type="button" style={{ marginTop: 12 }} onClick={() => setEditBoard(null)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {modal && (
        <div className="modal-backdrop" role="presentation" onClick={() => setModal(false)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Новая доска</h3>
            <form
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const name = String(fd.get('name') || '').trim();
                if (!name) {
                  await uiAlert('Введите название доски');
                  return;
                }
                try {
                  await api(`/api/groups/${groupId}/task-boards`, {
                    method: 'POST',
                    json: {
                      name,
                      password: fd.get('password') || undefined,
                    },
                  });
                  setModal(false);
                  loadBoards();
                } catch (er) {
                  await uiAlert((er as Error).message);
                }
              }}
            >
              <div className="field">
                <label>Название</label>
                <input name="name" />
              </div>
              <div className="field">
                <label>Пароль доски (необязательно)</label>
                <input name="password" type="password" />
              </div>
              <button type="submit" className="primary">
                Создать
              </button>
            </form>
            <button type="button" style={{ marginTop: 12 }} onClick={() => setModal(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
