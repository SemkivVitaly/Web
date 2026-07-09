/**
 * @fileoverview Канбан-доска задач группы: свободное положение карточек (задачи, коллаб-документы, файлы, ссылки, папки),
 * масштаб и панорамирование, совместные курсоры и индикация чужого перетаскивания.
 *
 * Данные: `/api/task-boards/:id/canvas-items`, PATCH/DELETE по элементу, загрузка файла на доску; обновления приходят
 * по `tasks:refresh` и инкрементально по `tasks:canvas-sync`. Слева — `CanvasSolutionExplorer` для навигации по дереву карточек.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { Socket } from 'socket.io-client';
import { api, apiForm, resolveUrl } from '../api';
import { uiConfirm, uiPrompt } from '../ui/dialogs';
import type { CollabDocPickerRow, TaskCanvasItem, TaskNode, User } from '../types';
import { AddItemMenu, CanvasSolutionExplorer } from './SolutionExplorer';
import { readTaskBoardDragItemId, setTaskBoardDragItemData } from './canvasDragMime';
import { inferCollabDocTypeFromFile, isCollabDiskImageFile } from './collabDiskFileMeta';

function canvasFileUrl(url: string | null | undefined): string {
  return url ? resolveUrl(url) : '';
}
import { CanvasCardPreview } from './canvasItemPreview';
import { yjsUpdateToBase64 } from './yjsB64';

// --- Утилиты: плоский список задач для выбора, визуальная обратная связь при DnD папки ---

function flatTasks(nodes: TaskNode[]): TaskNode[] {
  const out: TaskNode[] = [];
  const walk = (list: TaskNode[]) => {
    for (const n of list) {
      const { children, ...rest } = n;
      out.push(rest);
      if (children?.length) walk(children);
    }
  };
  walk(nodes);
  return out;
}

/** Подсказка под курсором и подсветка карточки при переносе папки с канваса. */
function attachFolderDragFeedback(e: DragEvent, displayTitle: string) {
  const handle = e.currentTarget as HTMLElement;
  const card = handle.closest('.lc-canvas-card--folder');
  if (card) card.classList.add('lc-canvas-card--drag-source');

  const ghost = document.createElement('div');
  ghost.className = 'lc-canvas-drag-ghost-folder';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.textContent = `📁 ${displayTitle}`;
  document.body.appendChild(ghost);
  const w = ghost.offsetWidth || 120;
  const h = ghost.offsetHeight || 32;
  e.dataTransfer.setDragImage(ghost, Math.round(w / 2), Math.round(h / 2));

  const cleanup = () => {
    card?.classList.remove('lc-canvas-card--drag-source');
    ghost.remove();
    window.removeEventListener('dragend', cleanup);
  };
  window.addEventListener('dragend', cleanup);
}

// --- Карточки: мини-элемент внутри папки, корневая карточка (в т.ч. папка с drop-зоной) ---

function MiniCanvasItem({
  item,
  boardPassword,
  onPatch,
  onDelete,
  onOpenCollab,
  onOpenTask,
  onOpenImage,
  me,
  canModerate,
  announceDrag,
  remoteDragLabel,
}: {
  item: TaskCanvasItem;
  boardPassword: string;
  onPatch: (id: number, body: Record<string, unknown>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onOpenCollab: (docId: number) => void;
  onOpenTask: (taskId: number) => void;
  onOpenImage: (url: string) => void;
  me: User;
  canModerate: boolean;
  announceDrag?: (phase: 'start' | 'end', canvasItemId: number | null) => void;
  remoteDragLabel?: string;
}) {
  const [hover, setHover] = useState(false);
  const canDrag = !item.pinned;
  const canRemove = item.createdById === me.id || canModerate;

  return (
    <div
      className={`lc-canvas-mini${item.pinned ? ' lc-canvas-mini--pinned' : ''}${remoteDragLabel ? ' lc-canvas-remote-peer-drag' : ''}`}
      draggable={canDrag}
      title={remoteDragLabel ? `Переносит: ${remoteDragLabel}` : undefined}
      onDragStart={(e: DragEvent) => {
        setTaskBoardDragItemData(e.dataTransfer, item.id);
        announceDrag?.('start', item.id);
      }}
      onDragEnd={() => announceDrag?.('end', null)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className="lc-canvas-mini-main"
        onClick={() => {
          if (item.kind === 'task' && item.taskId) onOpenTask(item.taskId);
          else if (item.kind === 'collab_doc' && item.collabDocumentId) onOpenCollab(item.collabDocumentId);
          else if (item.kind === 'upload' && item.isImage && item.fileUrl) onOpenImage(canvasFileUrl(item.fileUrl));
          else if (item.kind === 'upload' && item.fileUrl) window.open(canvasFileUrl(item.fileUrl), '_blank', 'noopener,noreferrer');
          else if (item.kind === 'link' && item.linkUrl) window.open(item.linkUrl, '_blank', 'noopener,noreferrer');
        }}
      >
        <span className="lc-canvas-mini-icon" aria-hidden>
          {item.kind === 'folder'
            ? '📁'
            : item.kind === 'task'
              ? '✓'
              : item.kind === 'collab_doc'
                ? item.docPreview?.docType === 'spreadsheet'
                  ? '📊'
                  : '📄'
                : item.kind === 'link'
                  ? '🔗'
                  : item.isImage
                    ? '🖼'
                    : '📎'}
        </span>
        <span className="lc-canvas-mini-title">{item.displayTitle}</span>
      </button>
      <div className="lc-canvas-mini-actions">
        <button
          type="button"
          title={item.pinned ? 'Снять закрепление' : 'Закрепить (без перетаскивания)'}
          onClick={() =>
            void onPatch(item.id, { password: boardPassword || undefined, pinned: !item.pinned })
          }
        >
          {item.pinned ? '🔓' : '📌'}
        </button>
        {canRemove && (
          <button type="button" className="danger" title="Убрать с доски" onClick={() => void onDelete(item.id)}>
            ×
          </button>
        )}
      </div>
      {hover && (
        <div className="lc-canvas-hover-pop" role="tooltip">
          <strong>{item.displayTitle}</strong>
          <CanvasCardPreview item={item} />
        </div>
      )}
    </div>
  );
}

function CanvasRootCard({
  item,
  children,
  boardPassword,
  onPatch,
  onDelete,
  onOpenCollab,
  onOpenTask,
  onOpenImage,
  me,
  canModerate,
  onBringToFront,
  announceDrag,
  remoteDragLabelFor,
}: {
  item: TaskCanvasItem;
  children: TaskCanvasItem[];
  boardPassword: string;
  onPatch: (id: number, body: Record<string, unknown>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onOpenCollab: (docId: number) => void;
  onOpenTask: (taskId: number) => void;
  onOpenImage: (url: string) => void;
  me: User;
  canModerate: boolean;
  onBringToFront: (id: number) => void;
  announceDrag?: (phase: 'start' | 'end', canvasItemId: number | null) => void;
  remoteDragLabelFor?: (canvasItemId: number) => string;
}) {
  const [hover, setHover] = useState(false);
  const canDrag = !item.pinned && item.kind !== 'folder';
  const folderDrag = !item.pinned && item.kind === 'folder';
  const canRemove = item.createdById === me.id || canModerate;

  const style: CSSProperties = {
    left: item.positionX,
    top: item.positionY,
    width: item.width,
    minHeight: item.height,
    zIndex: item.zIndex,
  };

  if (item.kind === 'folder') {
    const onFolderDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    };
    const onFolderDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const cid = readTaskBoardDragItemId(e.dataTransfer);
      if (cid == null || cid === item.id) return;
      void onPatch(cid, {
        password: boardPassword || undefined,
        parentItemId: item.id,
        positionX: 0,
        positionY: 0,
      });
    };

    const folderPeer = remoteDragLabelFor?.(item.id);
    return (
      <div
        className={`lc-canvas-card lc-canvas-card--folder${item.pinned ? ' lc-canvas-card--pinned' : ''}${folderPeer ? ' lc-canvas-remote-peer-drag' : ''}`}
        style={style}
        title={folderPeer ? `Переносит: ${folderPeer}` : undefined}
        onDragOver={onFolderDragOver}
        onDrop={onFolderDrop}
      >
        <div
          className="lc-canvas-card-head"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          {folderDrag ? (
            <span
              className="lc-canvas-folder-drag"
              draggable
              title="Переместить папку (под курсором — метка «Папка»)"
              onDragStart={(e: DragEvent) => {
                e.stopPropagation();
                setTaskBoardDragItemData(e.dataTransfer, item.id);
                attachFolderDragFeedback(e, item.displayTitle);
                announceDrag?.('start', item.id);
              }}
              onDragEnd={() => announceDrag?.('end', null)}
            >
              ⠿
            </span>
          ) : null}
          <span className="lc-canvas-card-title">📁 {item.displayTitle}</span>
          <span className="lc-canvas-card-actions">
            <button
              type="button"
              title={item.pinned ? 'Снять закрепление' : 'Закрепить'}
              onClick={() =>
                void onPatch(item.id, { password: boardPassword || undefined, pinned: !item.pinned })
              }
            >
              {item.pinned ? '🔓' : '📌'}
            </button>
            {canRemove && (
              <button type="button" className="danger" onClick={() => void onDelete(item.id)}>
                ×
              </button>
            )}
          </span>
        </div>
        <div
          className="lc-canvas-folder-drop"
          {...(children.length === 0
            ? {
                onMouseEnter: () => setHover(true),
                onMouseLeave: () => setHover(false),
              }
            : {})}
        >
          {children.length === 0 ? (
            <span className="meta">Перетащите сюда задачи, файлы или документы</span>
          ) : (
            children.map((ch) => (
              <MiniCanvasItem
                key={ch.id}
                item={ch}
                boardPassword={boardPassword}
                onPatch={onPatch}
                onDelete={onDelete}
                onOpenCollab={onOpenCollab}
                onOpenTask={onOpenTask}
                onOpenImage={onOpenImage}
                me={me}
                canModerate={canModerate}
                announceDrag={announceDrag}
                remoteDragLabel={remoteDragLabelFor?.(ch.id)}
              />
            ))
          )}
        </div>
        {hover && (
          <div className="lc-canvas-hover-pop lc-canvas-hover-pop--folder" role="tooltip">
            <strong>{item.displayTitle}</strong>
            <CanvasCardPreview item={item} />
          </div>
        )}
      </div>
    );
  }

  const rootPeer = remoteDragLabelFor?.(item.id);
  return (
    <div
      className={`lc-canvas-card${item.pinned ? ' lc-canvas-card--pinned' : ''}${item.kind === 'link' ? ' lc-canvas-card--link' : ''}${rootPeer ? ' lc-canvas-remote-peer-drag' : ''}`}
      style={style}
      title={rootPeer ? `Переносит: ${rootPeer}` : undefined}
      draggable={canDrag}
      onDragStart={(e: DragEvent) => {
        setTaskBoardDragItemData(e.dataTransfer, item.id);
        announceDrag?.('start', item.id);
      }}
      onDragEnd={() => announceDrag?.('end', null)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="lc-canvas-card-head">
        <button
          type="button"
          className="lc-canvas-card-title-btn"
          onClick={() => {
            if (item.kind === 'task' && item.taskId) onOpenTask(item.taskId);
            else if (item.kind === 'collab_doc' && item.collabDocumentId) onOpenCollab(item.collabDocumentId);
            else if (item.kind === 'upload' && item.isImage && item.fileUrl) onOpenImage(canvasFileUrl(item.fileUrl));
            else if (item.kind === 'upload' && item.fileUrl) window.open(canvasFileUrl(item.fileUrl), '_blank', 'noopener,noreferrer');
            else if (item.kind === 'link' && item.linkUrl) window.open(item.linkUrl, '_blank', 'noopener,noreferrer');
          }}
        >
          {item.displayTitle}
        </button>
        <span className="lc-canvas-card-actions">
          <button type="button" title="Поверх остальных" onClick={() => onBringToFront(item.id)}>
            ⬆
          </button>
          <button
            type="button"
            title={item.pinned ? 'Снять закрепление' : 'Закрепить'}
            onClick={() =>
              void onPatch(item.id, { password: boardPassword || undefined, pinned: !item.pinned })
            }
          >
            {item.pinned ? '🔓' : '📌'}
          </button>
          {canRemove && (
            <button type="button" className="danger" onClick={() => void onDelete(item.id)}>
              ×
            </button>
          )}
        </span>
      </div>
      <div className="meta lc-canvas-card-meta">{item.previewLine}</div>
      {item.kind === 'upload' && item.isImage && item.fileUrl && (
        <button type="button" className="lc-canvas-card-thumb-btn" onClick={() => onOpenImage(canvasFileUrl(item.fileUrl!))}>
          <img src={canvasFileUrl(item.fileUrl)} alt="" className="lc-canvas-card-thumb" />
        </button>
      )}
      {hover && (
        <div className="lc-canvas-hover-pop" role="tooltip">
          <strong>{item.displayTitle}</strong>
          <CanvasCardPreview item={item} />
        </div>
      )}
    </div>
  );
}

// --- Типы присутствия на канвасе и слияние элемента после `tasks:canvas-sync` ---

type RemoteCursor = {
  displayName: string;
  color: string;
  x: number;
  y: number;
  ts: number;
};

type RemoteDrag = {
  displayName: string;
  color: string;
  canvasItemId: number | null;
  ts: number;
};

function remoteDragNamesOnItem(remoteDrags: Record<number, RemoteDrag>, itemId: number): string {
  const names = Object.values(remoteDrags)
    .filter((d) => d.canvasItemId === itemId)
    .map((d) => d.displayName);
  return names.length ? names.join(', ') : '';
}

function mergeUpsert(prev: TaskCanvasItem[], item: TaskCanvasItem): TaskCanvasItem[] {
  const ix = prev.findIndex((i) => i.id === item.id);
  if (ix === -1) return [...prev, item];
  const c = [...prev];
  c[ix] = item;
  return c;
}

/**
 * Интерактивный канвас одной доски задач (пароль передаётся в API в теле/query).
 *
 * @param groupId — группа (импорт документа с диска, плоский список коллаб-документов)
 * @param boardId — активная доска
 * @param boardPassword — пароль доски, если задан на сервере
 * @param socket — курсоры, перетаскивание, `tasks:canvas-sync`
 * @param taskTreeRoots — дерево задач для привязки существующих задач к карточкам
 * @param me — текущий пользователь
 * @param groupRole — для прав модератора на удаление чужих карточек
 * @param onReloadTasks — после операций, влияющих на список задач в панели
 * @param onOpenCollabDocument — открыть редактор коллаб-документа
 * @param onFocusTaskInList — прокрутить к задаче в боковом списке (из проводника/мини-карточки)
 */
export function TaskBoardCanvas({
  groupId,
  boardId,
  boardPassword,
  socket,
  taskTreeRoots,
  me,
  groupRole,
  onReloadTasks,
  onOpenCollabDocument,
  onFocusTaskInList,
}: {
  groupId: number;
  boardId: number;
  boardPassword: string;
  socket: Socket;
  taskTreeRoots: TaskNode[];
  me: User;
  groupRole: string;
  onReloadTasks: () => Promise<void>;
  onOpenCollabDocument: (docId: number) => void;
  onFocusTaskInList: (taskId: number) => void;
}) {
  // --- Состояние: элементы канваса, пан/масштаб, «призраки» курсоров и DnD других пользователей ---

  const [items, setItems] = useState<TaskCanvasItem[]>([]);
  const [docsPick, setDocsPick] = useState<CollabDocPickerRow[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [cursors, setCursors] = useState<Record<number, RemoteCursor>>({});
  const [remoteDrags, setRemoteDrags] = useState<Record<number, RemoteDrag>>({});
  const [selectedExplorerFolderId, setSelectedExplorerFolderId] = useState<number | null>(null);
  const [explorerAddOpen, setExplorerAddOpen] = useState(false);
  const [canvasCtx, setCanvasCtx] = useState<{
    clientX: number;
    clientY: number;
    canvasX: number;
    canvasY: number;
  } | null>(null);
  const [tasksPickOpen, setTasksPickOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  /** Панорама доски перетаскиванием ЛКМ по пустому месту. */
  const panDragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(
    null
  );
  const [isPanning, setIsPanning] = useState(false);
  const pointerEmitAt = useRef(0);
  const pendingPosRef = useRef<{ parentId: number | null; getPos: () => { x: number; y: number } } | null>(null);
  const canvasFileRef = useRef<HTMLInputElement>(null);
  const docDiskRef = useRef<HTMLInputElement>(null);
  const canModerate = groupRole === 'admin' || groupRole === 'moderator';

  // --- Плоский список задач для диалога привязки карточки; преобразование координат viewport ↔ canvas ---

  const allTasks = useMemo(() => flatTasks(taskTreeRoots), [taskTreeRoots]);

  // Выход из полноэкранного режима доски по Escape.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const clientToCanvas = useCallback((clientX: number, clientY: number) => {
    const surface = surfaceRef.current;
    if (!surface) return { x: 0, y: 0 };
    const sr = surface.getBoundingClientRect();
    const s = scaleRef.current;
    const x = (clientX - sr.left) / s;
    const y = (clientY - sr.top) / s;
    return { x, y };
  }, []);

  // --- Загрузка карточек; сброс пан/масштаба при смене доски; сокет: tasks:refresh и tasks:canvas-sync ---

  const loadCanvas = useCallback(async () => {
    const q = boardPassword ? `?password=${encodeURIComponent(boardPassword)}` : '';
    try {
      const list = await api<TaskCanvasItem[]>(`/api/task-boards/${boardId}/canvas-items${q}`);
      setItems(Array.isArray(list) ? list : []);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
      setItems([]);
    }
  }, [boardId, boardPassword]);

  useEffect(() => {
    void loadCanvas();
  }, [loadCanvas]);

  useEffect(() => {
    panRef.current = { x: 0, y: 0 };
    scaleRef.current = 1;
    setPan({ x: 0, y: 0 });
    setScale(1);
    setCursors({});
    setRemoteDrags({});
    setSelectedExplorerFolderId(null);
    setExplorerAddOpen(false);
    setCanvasCtx(null);
    setTasksPickOpen(false);
    pendingPosRef.current = null;
  }, [boardId]);

  useEffect(() => {
    const h = (p: { boardId: number }) => {
      if (p.boardId === boardId) void loadCanvas();
    };
    socket.on('tasks:refresh', h);
    return () => {
      socket.off('tasks:refresh', h);
    };
  }, [socket, boardId, loadCanvas]);

  useEffect(() => {
    const onSync = (p: { boardId: number; action: string; item?: TaskCanvasItem; itemId?: number }) => {
      if (p.boardId !== boardId) return;
      if (p.action === 'remove' && p.itemId != null) {
        setItems((prev) => prev.filter((i) => i.id !== p.itemId));
        return;
      }
      if (p.action === 'upsert' && p.item) {
        setItems((prev) => mergeUpsert(prev, p.item!));
      }
    };
    socket.on('tasks:canvas-sync', onSync);
    return () => {
      socket.off('tasks:canvas-sync', onSync);
    };
  }, [socket, boardId]);

  // --- Сокет: чужие курсоры, перетаскивание; колесо масштаба/пан; уход с доски ---

  useEffect(() => {
    const onCur = (p: {
      boardId: number;
      userId: number;
      displayName?: string;
      color?: string;
      x?: number;
      y?: number;
      ts?: number;
      leave?: boolean;
    }) => {
      if (p.boardId !== boardId) return;
      if (p.leave) {
        setCursors((prev) => {
          const n = { ...prev };
          delete n[p.userId];
          return n;
        });
        return;
      }
      if (p.userId === me.id) return;
      const displayName = p.displayName;
      const color = p.color;
      const x = p.x;
      const y = p.y;
      const ts = p.ts;
      if (displayName == null || color == null || x == null || y == null || ts == null) return;
      const uid = p.userId;
      setCursors((prev) => ({
        ...prev,
        [uid]: { displayName, color, x, y, ts },
      }));
    };
    socket.on('taskboard:cursors', onCur);
    return () => {
      socket.off('taskboard:cursors', onCur);
    };
  }, [socket, boardId, me.id]);

  const announceDrag = useCallback(
    (phase: 'start' | 'end', canvasItemId: number | null) => {
      socket.emit('taskboard:drag', { boardId, phase, canvasItemId });
    },
    [socket, boardId]
  );

  const remoteDragLabelFor = useCallback(
    (id: number) => remoteDragNamesOnItem(remoteDrags, id),
    [remoteDrags]
  );

  useEffect(() => {
    const onDrag = (p: {
      boardId: number;
      userId: number;
      displayName?: string;
      color?: string;
      phase?: string;
      canvasItemId?: number | null;
      ts?: number;
    }) => {
      if (p.boardId !== boardId) return;
      if (p.userId === me.id) return;
      if (p.phase === 'end') {
        setRemoteDrags((prev) => {
          const n = { ...prev };
          delete n[p.userId];
          return n;
        });
        return;
      }
      if (p.phase !== 'start' || p.displayName == null || p.color == null || p.ts == null) return;
      const displayName = p.displayName;
      const color = p.color;
      const ts = p.ts;
      const canvasItemId = p.canvasItemId ?? null;
      const uid = p.userId;
      setRemoteDrags((prev) => ({
        ...prev,
        [uid]: { displayName, color, canvasItemId, ts },
      }));
    };
    socket.on('taskboard:drag', onDrag);
    return () => {
      socket.off('taskboard:drag', onDrag);
    };
  }, [socket, boardId, me.id]);

  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      setRemoteDrags((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          const uid = +k;
          if (now - next[uid].ts > 14000) {
            delete next[uid];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1200);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      setCursors((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          const id = +k;
          if (now - next[id].ts > 4000) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 900);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    return () => {
      socket.emit('taskboard:pointer-leave', { boardId });
    };
  }, [socket, boardId]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const w = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const next = Math.min(2.5, Math.max(0.25, scaleRef.current - e.deltaY * 0.001));
        scaleRef.current = next;
        setScale(next);
      } else {
        e.preventDefault();
        const p = panRef.current;
        const n = { x: p.x - e.deltaX, y: p.y - e.deltaY };
        panRef.current = n;
        setPan(n);
      }
    };
    el.addEventListener('wheel', w, { passive: false });
    return () => el.removeEventListener('wheel', w);
  }, [boardId]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('.lc-canvas-ctx-menu, .lc-solution-add-menu, .lc-solution-explorer-add-wrap')) return;
      setCanvasCtx(null);
      setExplorerAddOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  // --- REST: перемещение/размер/z-index карточек; добавление из проводника, файла, диска, ссылки ---

  const emitPointer = useCallback(
    (e: ReactMouseEvent) => {
      const now = Date.now();
      if (now - pointerEmitAt.current < 42) return;
      pointerEmitAt.current = now;
      const { x, y } = clientToCanvas(e.clientX, e.clientY);
      socket.emit('taskboard:pointer', { boardId, x, y });
    },
    [boardId, clientToCanvas, socket]
  );

  /** Старт панорамы ЛКМ: только по пустому месту доски (не по карточке/кнопке). */
  const onViewportMouseDown = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (
      el.closest(
        '.lc-canvas-card, .lc-canvas-mini, .lc-canvas-remote-cursor, button, a, input, textarea, select, [role="button"], .lc-canvas-ctx-menu'
      )
    ) {
      return;
    }
    panDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    };
    setIsPanning(true);
  }, []);

  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e: MouseEvent) => {
      const d = panDragRef.current;
      if (!d) return;
      const n = { x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) };
      panRef.current = n;
      setPan(n);
    };
    const onUp = () => {
      panDragRef.current = null;
      setIsPanning(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isPanning]);

  const patchItem = useCallback(
    async (id: number, body: Record<string, unknown>) => {
      const updated = await api<TaskCanvasItem>(`/api/task-board-canvas/${id}`, {
        method: 'PATCH',
        json: { password: boardPassword || undefined, ...body },
      });
      setItems((prev) => mergeUpsert(prev, updated));
    },
    [boardPassword]
  );

  const deleteItem = useCallback(
    async (id: number) => {
      if (!(await uiConfirm('Убрать элемент с доски?', { danger: true, okText: 'Убрать' }))) return;
      const q = boardPassword ? `?password=${encodeURIComponent(boardPassword)}` : '';
      await api(`/api/task-board-canvas/${id}${q}`, { method: 'DELETE' });
      setItems((prev) => prev.filter((i) => i.id !== id));
    },
    [boardPassword]
  );

  const handleCanvasDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const cid = readTaskBoardDragItemId(e.dataTransfer);
      if (cid == null) return;
      const { x, y } = clientToCanvas(e.clientX, e.clientY);
      void patchItem(cid, { parentItemId: null, positionX: Math.max(8, x - 40), positionY: Math.max(8, y - 24) });
    },
    [clientToCanvas, patchItem]
  );

  const nextStagger = useCallback(
    (parentId: number | null) => {
      const sibs = items.filter((i) => i.parentItemId === parentId);
      const n = sibs.length;
      return { x: 40 + (n % 6) * 28, y: 40 + (n % 4) * 36 };
    },
    [items]
  );

  const byParent = useMemo(() => {
    const m = new Map<number | null, TaskCanvasItem[]>();
    for (const it of items) {
      const k = it.parentItemId;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(it);
    }
    return m;
  }, [items]);

  const roots = byParent.get(null) ?? [];

  const surfaceSize = useMemo(() => {
    const pad = 420;
    let w = 1200;
    let h = 640;
    for (const it of items) {
      if (it.parentItemId != null) continue;
      w = Math.max(w, it.positionX + it.width + pad);
      h = Math.max(h, it.positionY + Math.max(it.height, 160) + pad);
    }
    return { minWidth: w, minHeight: h };
  }, [items]);

  const loadDocPicker = useCallback(async () => {
    const list = await api<CollabDocPickerRow[]>(`/api/groups/${groupId}/collab-docs-flat`);
    setDocsPick(Array.isArray(list) ? list : []);
  }, [groupId]);

  const linkDocWithPending = useCallback(
    async (docId: number) => {
      const p = pendingPosRef.current;
      pendingPosRef.current = null;
      const parentId = p?.parentId ?? null;
      const pos = p?.getPos() ?? nextStagger(parentId);
      const json: Record<string, unknown> = {
        password: boardPassword || undefined,
        kind: 'collab_doc',
        collabDocumentId: docId,
        positionX: pos.x,
        positionY: pos.y,
      };
      if (parentId != null) json.parentItemId = parentId;
      const created = await api<TaskCanvasItem>(`/api/task-boards/${boardId}/canvas-items`, {
        method: 'POST',
        json,
      });
      setDocsPick([]);
      setItems((prev) => mergeUpsert(prev, created));
    },
    [boardId, boardPassword, nextStagger]
  );

  const linkExistingTaskWithPending = useCallback(
    async (taskId: number) => {
      const p = pendingPosRef.current;
      pendingPosRef.current = null;
      const parentId = p?.parentId ?? null;
      const pos = p?.getPos() ?? nextStagger(parentId);
      const json: Record<string, unknown> = {
        password: boardPassword || undefined,
        kind: 'task',
        taskId,
        positionX: pos.x,
        positionY: pos.y,
      };
      if (parentId != null) json.parentItemId = parentId;
      const created = await api<TaskCanvasItem>(`/api/task-boards/${boardId}/canvas-items`, {
        method: 'POST',
        json,
      });
      setTasksPickOpen(false);
      setItems((prev) => mergeUpsert(prev, created));
    },
    [boardId, boardPassword, nextStagger]
  );

  const onCanvasFilePicked = useCallback(
    async (f: File) => {
      const p = pendingPosRef.current;
      pendingPosRef.current = null;
      const parentId = p?.parentId ?? null;
      const pos = p?.getPos() ?? nextStagger(parentId);
      const fd = new FormData();
      fd.append('file', f);
      if (boardPassword) fd.append('password', boardPassword);
      if (parentId != null) fd.append('parentItemId', String(parentId));
      fd.append('positionX', String(pos.x));
      fd.append('positionY', String(pos.y));
      const created = await apiForm<TaskCanvasItem>(`/api/task-boards/${boardId}/canvas-upload`, fd);
      setItems((prev) => mergeUpsert(prev, created));
    },
    [boardId, boardPassword, nextStagger]
  );

  const onDocDiskPicked = useCallback(
    async (f: File) => {
      const p = pendingPosRef.current;
      pendingPosRef.current = null;
      const parentId = p?.parentId ?? null;
      const pos = p?.getPos() ?? nextStagger(parentId);
      const base = f.name.replace(/\.[^.]+$/, '') || f.name;
      const docType = inferCollabDocTypeFromFile(f);
      let docId: number;
      try {
        const docMeta = await api<{ id: number }>(`/api/groups/${groupId}/collab-docs`, {
          method: 'POST',
          json: {
            name: base,
            docType,
            description: `Импорт из файла ${f.name}`,
            taskBoardOnly: true,
          },
        });
        docId = docMeta.id;
      } catch (e) {
        setErr((e as Error).message);
        return;
      }
      let ooEnabled = false;
      try {
        const en = await api<{ enabled: boolean }>('/api/onlyoffice/enabled');
        ooEnabled = !!en.enabled;
      } catch {
        ooEnabled = false;
      }

      try {
        if (ooEnabled && !isCollabDiskImageFile(f)) {
          const fd = new FormData();
          fd.append('file', f);
          if (boardPassword) fd.append('password', boardPassword);
          await apiForm(`/api/collab-docs/${docId}/import-onlyoffice`, fd);
        } else {
          const seed = await import('./collabImportSeed');
          let update: Uint8Array;
          if (docType === 'spreadsheet') {
            const data = await f.arrayBuffer();
            update = seed.buildSpreadsheetYUpdateFromFile(f, data);
          } else if (isCollabDiskImageFile(f)) {
            const fdImg = new FormData();
            fdImg.append('file', f);
            const { url } = await apiForm<{ url: string }>(`/api/collab-docs/${docId}/collab-image-upload`, fdImg);
            const alt = (f.name.replace(/\.[^.]+$/, '') || f.name || 'фото').slice(0, 200);
            update = await seed.buildRichTextYUpdateFromImageUrl(resolveUrl(url), alt);
          } else {
            update = await seed.buildRichTextYUpdateFromFile(f);
          }
          await api(`/api/collab-docs/${docId}/y-seed`, {
            method: 'POST',
            json: { initialStateBase64: yjsUpdateToBase64(update) },
          });
        }
      } catch (e) {
        setErr((e as Error).message);
        try {
          await api(`/api/collab-docs/${docId}`, { method: 'DELETE' });
        } catch {
          /* noop */
        }
        return;
      }
      try {
        const json: Record<string, unknown> = {
          password: boardPassword || undefined,
          kind: 'collab_doc',
          collabDocumentId: docId,
          positionX: pos.x,
          positionY: pos.y,
        };
        if (parentId != null) json.parentItemId = parentId;
        const created = await api<TaskCanvasItem>(`/api/task-boards/${boardId}/canvas-items`, {
          method: 'POST',
          json,
        });
        setItems((prev) => mergeUpsert(prev, created));
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [boardId, boardPassword, groupId, nextStagger]
  );

  const explorerPatchParent = useCallback(
    async (itemId: number, parentId: number | null) => {
      await patchItem(itemId, {
        parentItemId: parentId,
        positionX: 0,
        positionY: 0,
      });
    },
    [patchItem]
  );

  async function renameExplorerFolder(id: number) {
    const it = items.find((i) => i.id === id && i.kind === 'folder');
    if (!it) return;
    const t = await uiPrompt('Новое имя папки', { title: 'Переименование папки', defaultValue: it.displayTitle });
    if (t == null || !t.trim()) return;
    void patchItem(id, { title: t.trim() });
  }

  async function editLinkItem(id: number) {
    const it = items.find((i) => i.id === id && i.kind === 'link');
    if (!it) return;
    const nt = await uiPrompt('Заголовок ссылки', { title: 'Изменить ссылку', defaultValue: it.displayTitle, allowEmpty: true });
    if (nt === null) return;
    const nu = await uiPrompt('URL', { title: 'Изменить ссылку', defaultValue: it.linkUrl || '' });
    if (nu == null || !String(nu).trim()) return;
    void patchItem(id, { title: nt.trim(), linkUrl: String(nu).trim() });
  }

  async function runAddPick(
    key: string,
    source: 'explorer' | 'canvas',
    canvasPoint?: { x: number; y: number }
  ) {
    setExplorerAddOpen(false);
    setCanvasCtx(null);
    const parentForAdd = source === 'explorer' ? selectedExplorerFolderId : null;
    const getPos = (): { x: number; y: number } =>
      source === 'canvas' && canvasPoint
        ? { x: Math.max(8, canvasPoint.x - 40), y: Math.max(8, canvasPoint.y - 24) }
        : nextStagger(parentForAdd);

    try {
      switch (key) {
        case 'folder': {
          const name = await uiPrompt('Название папки на доске', { title: 'Новая папка' });
          if (!name?.trim()) return;
          const pos = getPos();
          const json: Record<string, unknown> = {
            password: boardPassword || undefined,
            kind: 'folder',
            title: name.trim(),
            positionX: pos.x,
            positionY: pos.y,
          };
          if (parentForAdd != null) json.parentItemId = parentForAdd;
          const created = await api<TaskCanvasItem>(`/api/task-boards/${boardId}/canvas-items`, {
            method: 'POST',
            json,
          });
          setItems((prev) => mergeUpsert(prev, created));
          break;
        }
        case 'task_new': {
          const title = await uiPrompt('Название задачи', { title: 'Новая задача' });
          if (!title?.trim()) return;
          const qtyQ = await uiPrompt('Сколько единиц нужно сделать? (пусто — прогресс ползунком)', {
            title: 'Новая задача',
            allowEmpty: true,
          });
          let quantityTarget: number | undefined;
          if (qtyQ != null && qtyQ.trim()) {
            const n = parseInt(qtyQ.trim(), 10);
            if (!Number.isFinite(n) || n < 1) {
              setErr('Цель по количеству: целое число ≥ 1 или пусто');
              return;
            }
            quantityTarget = n;
          }
          const t = await api<TaskNode>(`/api/task-boards/${boardId}/tasks`, {
            method: 'POST',
            json: {
              password: boardPassword || undefined,
              title: title.trim(),
              description: '',
              ...(quantityTarget != null ? { quantityTarget } : {}),
            },
          });
          const pos = getPos();
          const json: Record<string, unknown> = {
            password: boardPassword || undefined,
            kind: 'task',
            taskId: t.id,
            positionX: pos.x,
            positionY: pos.y,
          };
          if (parentForAdd != null) json.parentItemId = parentForAdd;
          const created = await api<TaskCanvasItem>(`/api/task-boards/${boardId}/canvas-items`, {
            method: 'POST',
            json,
          });
          await onReloadTasks();
          setItems((prev) => mergeUpsert(prev, created));
          break;
        }
        case 'task_existing': {
          pendingPosRef.current = { parentId: parentForAdd, getPos };
          setTasksPickOpen(true);
          break;
        }
        case 'file': {
          pendingPosRef.current = { parentId: parentForAdd, getPos };
          canvasFileRef.current?.click();
          break;
        }
        case 'doc_site': {
          pendingPosRef.current = { parentId: parentForAdd, getPos };
          await loadDocPicker();
          break;
        }
        case 'doc_disk': {
          pendingPosRef.current = { parentId: parentForAdd, getPos };
          docDiskRef.current?.click();
          break;
        }
        case 'link': {
          const url = await uiPrompt('URL ссылки', { title: 'Новая ссылка' });
          if (url == null || !String(url).trim()) return;
          const title = await uiPrompt('Подпись (необязательно)', { title: 'Новая ссылка', allowEmpty: true });
          if (title === null) return;
          const pos = getPos();
          const json: Record<string, unknown> = {
            password: boardPassword || undefined,
            kind: 'link',
            linkUrl: String(url).trim(),
            title: String(title).trim(),
            positionX: pos.x,
            positionY: pos.y,
          };
          if (parentForAdd != null) json.parentItemId = parentForAdd;
          const created = await api<TaskCanvasItem>(`/api/task-boards/${boardId}/canvas-items`, {
            method: 'POST',
            json,
          });
          setItems((prev) => mergeUpsert(prev, created));
          break;
        }
        default:
          break;
      }
    } catch (e) {
      setErr((e as Error).message);
      pendingPosRef.current = null;
    }
  }

  const onExplorerActivate = useCallback(
    (item: TaskCanvasItem) => {
      if (item.kind === 'task' && item.taskId) onFocusTaskInList(item.taskId);
      else if (item.kind === 'collab_doc' && item.collabDocumentId) onOpenCollabDocument(item.collabDocumentId);
      else if (item.kind === 'upload' && item.isImage && item.fileUrl) setLightbox(canvasFileUrl(item.fileUrl));
      else if (item.kind === 'upload' && item.fileUrl) window.open(canvasFileUrl(item.fileUrl), '_blank', 'noopener,noreferrer');
      else if (item.kind === 'link' && item.linkUrl) window.open(item.linkUrl, '_blank', 'noopener,noreferrer');
    },
    [onFocusTaskInList, onOpenCollabDocument]
  );

  // --- Разметка: вьюпорт, surface, проводник, контекстное меню добавления ---

  const transformStyle: CSSProperties = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
    transformOrigin: '0 0',
  };

  return (
    <div className={`lc-task-canvas-wrap${fullscreen ? ' lc-task-canvas-wrap--fullscreen' : ''}`}>
      {err && <p className="error">{err}</p>}
      <input
        ref={canvasFileRef}
        type="file"
        className="lc-sr-only"
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onCanvasFilePicked(f);
        }}
      />
      <input
        ref={docDiskRef}
        type="file"
        className="lc-sr-only"
        aria-hidden
        accept=".txt,.md,.html,.htm,.csv,.xlsx,.xls,text/plain,text/html,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onDocDiskPicked(f);
        }}
      />

      <div className="lc-task-canvas-layout">
        <CanvasSolutionExplorer
          byParent={byParent}
          selectedFolderId={selectedExplorerFolderId}
          onSelectFolder={setSelectedExplorerFolderId}
          onActivateItem={onExplorerActivate}
          onDelete={(id) => void deleteItem(id)}
          onRenameFolder={renameExplorerFolder}
          onEditLink={editLinkItem}
          onPatchParent={(itemId, parentId) => void explorerPatchParent(itemId, parentId)}
          addMenuOpen={explorerAddOpen}
          setAddMenuOpen={setExplorerAddOpen}
          onAddPick={(k) => void runAddPick(k, 'explorer')}
          announceDrag={announceDrag}
          remoteDragLabelFor={remoteDragLabelFor}
        />
        <div className="lc-task-canvas-main">
          <div className="lc-task-canvas-toolbar">
            <span className="lc-canvas-zoom">
              <button
                type="button"
                title="Уменьшить (или Ctrl + колёсико)"
                onClick={() => {
                  const next = Math.max(0.25, scaleRef.current - 0.1);
                  scaleRef.current = next;
                  setScale(next);
                }}
              >
                −
              </button>
              <span className="meta">{Math.round(scale * 100)}%</span>
              <button
                type="button"
                title="Увеличить"
                onClick={() => {
                  const next = Math.min(2.5, scaleRef.current + 0.1);
                  scaleRef.current = next;
                  setScale(next);
                }}
              >
                +
              </button>
              <button
                type="button"
                title="Сбросить масштаб и сдвиг"
                onClick={() => {
                  panRef.current = { x: 0, y: 0 };
                  scaleRef.current = 1;
                  setPan({ x: 0, y: 0 });
                  setScale(1);
                }}
              >
                Сброс вида
              </button>
              <button
                type="button"
                className="lc-task-canvas-fullscreen-btn"
                title={fullscreen ? 'Свернуть (Esc)' : 'Открыть доску на весь экран'}
                aria-pressed={fullscreen}
                onClick={() => setFullscreen((v) => !v)}
              >
                {fullscreen ? '✕ Свернуть' : '⛶ Во весь экран'}
              </button>
            </span>
            <span className="meta lc-task-canvas-hint">
              ПКМ по пустому месту доски — добавить. Колёсико — панорама, Ctrl+колёсико — масштаб. Поверхность
              растёт вместе с карточками.
            </span>
          </div>

          {docsPick.length > 0 && (
            <div
              className="lc-canvas-doc-pick modal-backdrop"
              role="presentation"
              onClick={() => {
                pendingPosRef.current = null;
                setDocsPick([]);
              }}
            >
              <div className="modal lc-canvas-doc-pick-inner" role="dialog" onClick={(e) => e.stopPropagation()}>
                <h3>Документ на доску</h3>
                <ul className="lc-canvas-doc-pick-list">
                  {docsPick.map((d) => (
                    <li key={d.id}>
                      <button type="button" onClick={() => void linkDocWithPending(d.id)}>
                        {d.docType === 'spreadsheet' ? '📊' : '📄'} {d.hasPassword ? '🔒 ' : ''}
                        {d.name}
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => {
                    pendingPosRef.current = null;
                    setDocsPick([]);
                  }}
                >
                  Закрыть
                </button>
              </div>
            </div>
          )}

          {tasksPickOpen && (
            <div
              className="lc-canvas-doc-pick modal-backdrop"
              role="presentation"
              onClick={() => {
                pendingPosRef.current = null;
                setTasksPickOpen(false);
              }}
            >
              <div className="modal lc-canvas-doc-pick-inner" role="dialog" onClick={(e) => e.stopPropagation()}>
                <h3>Задача из списка</h3>
                {allTasks.length === 0 ? (
                  <p className="meta">Нет задач на доске.</p>
                ) : (
                  <ul className="lc-canvas-doc-pick-list">
                    {allTasks.map((t) => (
                      <li key={t.id}>
                        <button type="button" onClick={() => void linkExistingTaskWithPending(t.id)}>
                          {t.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  onClick={() => {
                    pendingPosRef.current = null;
                    setTasksPickOpen(false);
                  }}
                >
                  Закрыть
                </button>
              </div>
            </div>
          )}

          <div
            ref={viewportRef}
            className={`lc-canvas-viewport${isPanning ? ' lc-canvas-viewport--panning' : ''}`}
            onMouseDown={onViewportMouseDown}
            onMouseMove={emitPointer}
            onMouseLeave={() => socket.emit('taskboard:pointer-leave', { boardId })}
          >
            <div className="lc-canvas-transform-layer" style={transformStyle}>
              <div
                ref={surfaceRef}
                className="lc-task-canvas-surface"
                style={surfaceSize}
                onContextMenu={(e) => {
                  const el = e.target as HTMLElement;
                  if (el.closest('.lc-canvas-card, .lc-canvas-mini, .lc-canvas-remote-cursor')) return;
                  e.preventDefault();
                  const { x, y } = clientToCanvas(e.clientX, e.clientY);
                  setCanvasCtx({
                    clientX: e.clientX,
                    clientY: e.clientY,
                    canvasX: x,
                    canvasY: y,
                  });
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDrop={handleCanvasDrop}
              >
                {roots.length === 0 && (
                  <div className="lc-task-canvas-empty meta">
                    Доска пуста. ПКМ по сетке — добавить элемент. В папку — бросить на карточку папки; из папки —
                    перетащить элемент на поле доски. Папку целиком — только за ⠿ в шапке. Синхронизация по сокету;
                    курсоры — при наведении на область доски.
                  </div>
                )}
                {roots.map((item) => (
                  <CanvasRootCard
                    key={item.id}
                    item={item}
                    children={(byParent.get(item.id) ?? []).filter((c) => c.kind !== 'folder')}
                    boardPassword={boardPassword}
                    onPatch={patchItem}
                    onDelete={deleteItem}
                    onOpenCollab={onOpenCollabDocument}
                    onOpenTask={onFocusTaskInList}
                    onOpenImage={(url) => setLightbox(url)}
                    me={me}
                    canModerate={canModerate}
                    announceDrag={announceDrag}
                    remoteDragLabelFor={remoteDragLabelFor}
                    onBringToFront={(id) => {
                      const maxZ = items.reduce((m, i) => Math.max(m, i.zIndex), 0);
                      void patchItem(id, { zIndex: maxZ + 1 });
                    }}
                  />
                ))}
                {Object.entries(cursors).map(([uid, c]) => (
                  <div
                    key={uid}
                    className="lc-canvas-remote-cursor"
                    style={
                      {
                        left: c.x,
                        top: c.y,
                        '--lc-cursor-color': c.color,
                      } as CSSProperties
                    }
                  >
                    <span className="lc-canvas-remote-cursor-dot" />
                    <span className="lc-canvas-remote-cursor-name">{c.displayName}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {canvasCtx && (
        <div
          className="lc-canvas-ctx-menu"
          style={{
            position: 'fixed',
            left: Math.min(canvasCtx.clientX, window.innerWidth - 220),
            top: Math.min(canvasCtx.clientY, window.innerHeight - 320),
            zIndex: 10000,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <AddItemMenu
            onPick={(k) => void runAddPick(k, 'canvas', { x: canvasCtx.canvasX, y: canvasCtx.canvasY })}
            onClose={() => setCanvasCtx(null)}
          />
        </div>
      )}

      {lightbox && (
        <div
          className="modal-backdrop lc-canvas-lightbox"
          role="presentation"
          onClick={() => setLightbox(null)}
        >
          <button type="button" className="lc-canvas-lightbox-close" aria-label="Закрыть">
            ×
          </button>
          <img src={lightbox} alt="" className="lc-canvas-lightbox-img" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
