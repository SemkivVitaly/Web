/**
 * @fileoverview Дерево «решения» на канбан-доске: те же `TaskCanvasItem`, что на канвасе, с поиском, сворачиванием папок,
 * DnD между папками и контекстными действиями. Меню добавления (`AddItemMenu`) делегирует тип элемента родителю.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { TaskCanvasItem } from '../types';
import { CanvasCardPreview } from './canvasItemPreview';
import { readTaskBoardDragItemId, setTaskBoardDragItemData } from './canvasDragMime';

// --- Сортировка, фильтр по поиску (включая поддеревья папок), иконки типов ---

function sortItems(list: TaskCanvasItem[]): TaskCanvasItem[] {
  const order = { folder: 0, task: 1, collab_doc: 2, upload: 3, link: 4 };
  return [...list].sort((a, b) => {
    const ka = order[a.kind] ?? 9;
    const kb = order[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    return (a.displayTitle || '').localeCompare(b.displayTitle || '', 'ru');
  });
}

function titleMatchesQueryNorm(item: TaskCanvasItem, qLower: string): boolean {
  if (!qLower) return true;
  return (item.displayTitle || '').toLowerCase().includes(qLower);
}

/** Папка или любой потомок совпадает с запросом (без учёта регистра). */
function subtreeHasMatch(
  item: TaskCanvasItem,
  qLower: string,
  byParent: Map<number | null, TaskCanvasItem[]>
): boolean {
  if (!qLower) return true;
  if (titleMatchesQueryNorm(item, qLower)) return true;
  if (item.kind !== 'folder') return false;
  const kids = byParent.get(item.id) ?? [];
  return kids.some((k) => subtreeHasMatch(k, qLower, byParent));
}

function iconFor(it: TaskCanvasItem) {
  if (it.kind === 'folder') return '📁';
  if (it.kind === 'task') return '✓';
  if (it.kind === 'collab_doc') return it.docPreview?.docType === 'spreadsheet' ? '📊' : '📄';
  if (it.kind === 'link') return '🔗';
  if (it.isImage) return '🖼';
  return '📎';
}

/** Всплывающее меню типов новых элементов на доске; `onPick` — ключ сценария (папка, файл, ссылка, …). */
export function AddItemMenu({
  onPick,
  onClose,
}: {
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const opts: { key: string; label: string }[] = [
    { key: 'folder', label: 'Папка' },
    { key: 'task_new', label: 'Новая задача' },
    { key: 'task_existing', label: 'Задача из списка…' },
    { key: 'file', label: 'Файл с компьютера' },
    { key: 'doc_site', label: 'Документ из группы…' },
    {
      key: 'doc_disk',
      label: 'Импорт с диска (OnlyOffice: Word/Excel-форматы; иначе встроенный редактор)',
    },
    { key: 'link', label: 'Ссылка' },
  ];
  return (
    <div className="lc-solution-add-menu" role="menu">
      {opts.map((o) => (
        <button key={o.key} type="button" role="menuitem" onClick={() => onPick(o.key)}>
          {o.label}
        </button>
      ))}
      <button type="button" className="lc-solution-add-cancel" onClick={onClose}>
        Отмена
      </button>
    </div>
  );
}

// --- Строка дерева: выбор папки, превью в портале, DnD, действия переименования/удаления ---

function ExplorerRow({
  item,
  depth,
  children,
  selectedFolderId,
  onSelectFolder,
  onActivateItem,
  folderChildCount,
  folderExpanded,
  onToggleFolderExpand,
  onDelete,
  onRename,
  onEditLink,
  onPatchParent,
  onDragStartItem,
  announceDrag,
  remoteDragLabelFor,
}: {
  item: TaskCanvasItem;
  depth: number;
  children: ReactNode;
  selectedFolderId: number | null;
  onSelectFolder: (id: number | null) => void;
  /** Задача, документ, файл, ссылка — как клик по карточке на доске */
  onActivateItem?: (item: TaskCanvasItem) => void;
  /** Для папки: число прямых дочерних элементов на доске */
  folderChildCount?: number;
  folderExpanded?: boolean;
  onToggleFolderExpand?: (folderId: number) => void;
  onDelete: (id: number) => void;
  onRename: (id: number) => void;
  onEditLink?: (id: number) => void;
  onPatchParent: (itemId: number, parentId: number | null) => void;
  onDragStartItem: (id: number) => void;
  announceDrag?: (phase: 'start' | 'end', canvasItemId: number | null) => void;
  remoteDragLabelFor?: (canvasItemId: number) => string;
}) {
  const [hover, setHover] = useState(false);
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null);
  const liRef = useRef<HTMLLIElement>(null);

  useLayoutEffect(() => {
    if (!hover || !liRef.current) {
      setPopPos(null);
      return;
    }
    const r = liRef.current.getBoundingClientRect();
    setPopPos({ top: r.top, left: r.right + 8 });
  }, [hover, item.id, depth, item.displayTitle]);

  useEffect(() => {
    if (!hover) return;
    const close = () => setHover(false);
    const sc = liRef.current?.closest('.lc-solution-tree-scroll');
    sc?.addEventListener('scroll', close, { passive: true });
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      sc?.removeEventListener('scroll', close);
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
    };
  }, [hover]);

  const isFolder = item.kind === 'folder';
  const selected = isFolder && selectedFolderId === item.id;
  const peerDrag = remoteDragLabelFor?.(item.id);
  const hasFolderChildren = isFolder && (folderChildCount ?? 0) > 0;
  const expanded = folderExpanded !== false;

  const twistCol =
    hasFolderChildren && onToggleFolderExpand ? (
      <button
        type="button"
        className="lc-solution-folder-twist"
        aria-expanded={expanded}
        aria-label={expanded ? 'Свернуть папку' : 'Развернуть папку'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFolderExpand(item.id);
        }}
      >
        {expanded ? '▼' : '▶'}
      </button>
    ) : (
      <span className="lc-solution-folder-twist lc-solution-folder-twist--spacer" aria-hidden />
    );

  return (
    <li
      ref={liRef}
      className="lc-solution-tree-li"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className={`lc-solution-row${selected ? ' lc-solution-row--selected' : ''}${peerDrag ? ' lc-solution-row--peer-drag' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={peerDrag ? `Переносит: ${peerDrag}` : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const cid = readTaskBoardDragItemId(e.dataTransfer);
          if (cid == null || cid === item.id) return;
          if (isFolder) onPatchParent(cid, item.id);
          else onPatchParent(cid, item.parentItemId ?? null);
        }}
      >
        {twistCol}
        <span
          className="lc-solution-drag-handle"
          draggable
          title="Перетащить"
          onDragStart={(e: DragEvent) => {
            e.stopPropagation();
            setTaskBoardDragItemData(e.dataTransfer, item.id);
            onDragStartItem(item.id);
            announceDrag?.('start', item.id);
          }}
          onDragEnd={() => announceDrag?.('end', null)}
        >
          ⠿
        </span>
        <button
          type="button"
          className="lc-solution-row-main"
          onClick={() => {
            if (isFolder) onSelectFolder(item.id);
            else if (onActivateItem) onActivateItem(item);
            else onSelectFolder(null);
          }}
        >
          <span className="lc-solution-row-icon" aria-hidden>
            {iconFor(item)}
          </span>
          <span className="lc-solution-row-title">{item.displayTitle}</span>
        </button>
        <span className="lc-solution-row-actions">
          {isFolder && (
            <button type="button" title="Переименовать" onClick={() => onRename(item.id)}>
              ✎
            </button>
          )}
          {item.kind === 'link' && onEditLink && (
            <button type="button" title="Изменить ссылку" onClick={() => onEditLink(item.id)}>
              ✎
            </button>
          )}
          <button type="button" className="danger" title="Убрать с доски" onClick={() => onDelete(item.id)}>
            ×
          </button>
        </span>
      </div>
      {hover &&
        popPos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="lc-canvas-hover-pop lc-solution-hover-pop-portal"
            style={{ position: 'fixed', top: popPos.top, left: popPos.left, zIndex: 5000 }}
            role="tooltip"
          >
            <strong>{item.displayTitle}</strong>
            <CanvasCardPreview item={item} />
          </div>,
          document.body
        )}
      {children}
    </li>
  );
}

/**
 * Панель-обозреватель иерархии карточек доски (`byParent` — как на канвасе).
 *
 * @param byParent — дочерние элементы по `parentItemId` (`null` = корень)
 * @param selectedFolderId — какая папка выделена для контекста «добавить внутрь»
 * @param onSelectFolder — смена выделенной папки
 * @param onActivateItem — клик по не-папке: как по карточке (задача, документ, файл, ссылка)
 * @param onDelete / onRenameFolder / onEditLink — операции над элементом
 * @param onPatchParent — перенос элемента в другую папку или в корень (DnD)
 * @param addMenuOpen / setAddMenuOpen / onAddPick — управление меню добавления
 * @param announceDrag / remoteDragLabelFor — синхронизация перетаскивания с канвасом
 */
export function CanvasSolutionExplorer({
  byParent,
  selectedFolderId,
  onSelectFolder,
  onActivateItem,
  onDelete,
  onRenameFolder,
  onEditLink,
  onPatchParent,
  addMenuOpen,
  setAddMenuOpen,
  onAddPick,
  announceDrag,
  remoteDragLabelFor,
}: {
  byParent: Map<number | null, TaskCanvasItem[]>;
  selectedFolderId: number | null;
  onSelectFolder: (id: number | null) => void;
  onActivateItem?: (item: TaskCanvasItem) => void;
  onDelete: (id: number) => void;
  onRenameFolder: (id: number) => void;
  onEditLink?: (id: number) => void;
  onPatchParent: (itemId: number, parentId: number | null) => void;
  addMenuOpen: boolean;
  setAddMenuOpen: (v: boolean) => void;
  onAddPick: (key: string) => void;
  announceDrag?: (phase: 'start' | 'end', canvasItemId: number | null) => void;
  remoteDragLabelFor?: (canvasItemId: number) => string;
}) {
  const [, setDragTick] = useState(0);
  const onDragStartItem = useCallback(() => setDragTick((x) => x + 1), []);
  /** id папок со свёрнутым содержимым (по умолчанию все развёрнуты) */
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<number>>(() => new Set());
  const [structureSearch, setStructureSearch] = useState('');

  const toggleFolderExpanded = useCallback((folderId: number) => {
    setCollapsedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  const rootDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const cid = readTaskBoardDragItemId(e.dataTransfer);
      if (cid == null) return;
      onPatchParent(cid, null);
    },
    [onPatchParent]
  );

  const renderNodes = useCallback(
    (parentId: number | null, depth: number, underMatchingAncestor: boolean): ReactNode => {
      const qLower = structureSearch.trim().toLowerCase();
      const filterOn = qLower.length > 0;
      const allList = sortItems(byParent.get(parentId) ?? []);
      const list = filterOn
        ? underMatchingAncestor
          ? allList
          : allList.filter((it) => subtreeHasMatch(it, qLower, byParent))
        : allList;
      if (list.length === 0) {
        if (filterOn && depth === 0 && parentId == null) {
          return <p className="meta lc-solution-search-empty">Нет элементов по этому запросу</p>;
        }
        return null;
      }
      const parentKey = parentId === null ? '' : String(parentId);
      return (
        <ul
          className="lc-solution-tree-ul"
          data-parent-folder={parentKey}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            e.stopPropagation();
            const cid = readTaskBoardDragItemId(e.dataTransfer);
            if (cid == null) return;
            const pid = parentKey === '' ? null : +parentKey;
            onPatchParent(cid, pid);
          }}
        >
          {list.map((it) => {
            const childList = byParent.get(it.id) ?? [];
            const nextUnder = underMatchingAncestor || (filterOn && titleMatchesQueryNorm(it, qLower));
            let visibleChildCount = childList.length;
            if (filterOn && !nextUnder) {
              visibleChildCount = sortItems(childList).filter((ch) => subtreeHasMatch(ch, qLower, byParent)).length;
            }
            const folderChildCount = it.kind === 'folder' ? visibleChildCount : 0;
            const folderExpanded =
              filterOn || it.kind !== 'folder' || !collapsedFolderIds.has(it.id);
            return (
              <ExplorerRow
                key={it.id}
                item={it}
                depth={depth}
                selectedFolderId={selectedFolderId}
                onSelectFolder={onSelectFolder}
                onActivateItem={onActivateItem}
                folderChildCount={folderChildCount}
                folderExpanded={folderExpanded}
                onToggleFolderExpand={toggleFolderExpanded}
                onDelete={onDelete}
                onRename={onRenameFolder}
                onEditLink={onEditLink}
                onPatchParent={onPatchParent}
                onDragStartItem={onDragStartItem}
                announceDrag={announceDrag}
                remoteDragLabelFor={remoteDragLabelFor}
              >
                {it.kind === 'folder' && folderExpanded && folderChildCount > 0
                  ? renderNodes(it.id, depth + 1, nextUnder)
                  : null}
              </ExplorerRow>
            );
          })}
        </ul>
      );
    },
    [
      byParent,
      collapsedFolderIds,
      structureSearch,
      selectedFolderId,
      onSelectFolder,
      onActivateItem,
      toggleFolderExpanded,
      onDelete,
      onRenameFolder,
      onEditLink,
      onPatchParent,
      onDragStartItem,
      announceDrag,
      remoteDragLabelFor,
    ]
  );

  const tree = useMemo(() => renderNodes(null, 0, false), [renderNodes]);

  return (
    <aside className="lc-solution-explorer" aria-label="Обозреватель решения">
      <div className="lc-solution-explorer-head">
        <strong>Структура</strong>
        <div className="lc-solution-explorer-add-wrap">
          <button type="button" className="primary" onClick={() => setAddMenuOpen(!addMenuOpen)}>
            Добавить
          </button>
          {addMenuOpen && (
            <AddItemMenu
              onPick={(k) => {
                setAddMenuOpen(false);
                onAddPick(k);
              }}
              onClose={() => setAddMenuOpen(false)}
            />
          )}
        </div>
      </div>
      <div className="lc-solution-search">
        <input
          type="search"
          value={structureSearch}
          onChange={(e) => setStructureSearch(e.target.value)}
          placeholder="Поиск по названию…"
          aria-label="Поиск по названию в структуре"
          autoComplete="off"
        />
      </div>
      <p className="meta lc-solution-explorer-hint">
        Поиск фильтрует дерево по подстроке в названии (без учёта регистра). Папка выделена — новые элементы из «Добавить» попадут в неё. ▶/▼ у папки — свернуть или развернуть вложенное. Клик по задаче, документу, файлу или ссылке открывает их (как на доске). Тяните за ⠿: на папку (внутрь), на строку уровня корня или на «Корень доски», чтобы вынуть из папки; с канваса — прямо на папку в дереве или в область папки.
      </p>
      <div
        className="lc-solution-root-drop"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={rootDrop}
      >
        <span className="meta">▼ Корень доски (сюда — вынуть из папки)</span>
      </div>
      <div className="lc-solution-tree-scroll">{tree}</div>
    </aside>
  );
}

export { DND_EXPLORER_ITEM as DND_EXPLORER } from './canvasDragMime';
