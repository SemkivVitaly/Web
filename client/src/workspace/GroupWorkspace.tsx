import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type DragEvent as ReactDragEvent,
} from 'react';
import type { Socket } from 'socket.io-client';
import { api, apiForm, resolveUrl } from '../api';
import { uiConfirm, uiPrompt } from '../ui/dialogs';
import type { CollabDocSummary, CollabFolderSummary, User } from '../types';
import {
  inferCollabDocTypeFromDiskImportFile,
  isCollabDiskImageFile,
  assertCollabDiskFileSupported,
  COLLAB_DISK_FILE_ACCEPT,
} from './collabDiskFileMeta';
import {
  buildFolderPwMap,
  mergeDocUnlocksFromStore,
  readCollabUnlock,
  rememberDocUnlock,
  rememberFolderUnlock,
} from './collabUnlockStorage';
import { yjsUpdateToBase64 } from './yjsB64';

/**
 * @fileoverview Вкладка «Документы» группы: дерево папок, список документов, импорт с диска,
 * открытие редактора `CollabDocView` (лениво). Общается с `/api/groups/.../collab-*` и сокетом `collab:tree-refresh`.
 */

/** Редактор открывается отдельным чанком (TipTap/Yjs внутри). */
const CollabDocView = lazy(() =>
  import('./CollabDocView').then((m) => ({ default: m.CollabDocView }))
);

const MessageAttachmentOoView = lazy(() =>
  import('./MessageAttachmentOoView').then((m) => ({ default: m.MessageAttachmentOoView }))
);

/** `dataTransfer.setData` при DnD документа между папками. */
const DOC_MIME = 'application/x-localchat-collab-doc';
/** Аналогично для папок. */
const FOLDER_MIME = 'application/x-localchat-collab-folder';

/**
 * Строка query для `GET .../collab-docs`: текущая папка и при необходимости пароль (не модератор).
 */
function collabDocsQuery(folderId: number | null, folderPw: Record<number, string>, modBypass: boolean) {
  if (folderId == null) return '';
  const p = new URLSearchParams({ folderId: String(folderId) });
  if (!modBypass) {
    const pw = folderPw[folderId];
    if (pw) p.set('folderPassword', pw);
  }
  return `?${p.toString()}`;
}

/**
 * Цепочка предков от `currentId` до корня — для хлебных крошек.
 */
function folderPathParts(
  currentId: number | null,
  allFolders: CollabFolderSummary[]
): CollabFolderSummary[] {
  if (currentId == null) return [];
  const list = Array.isArray(allFolders) ? allFolders : [];
  const byId: Record<number, CollabFolderSummary> = Object.fromEntries(
    list.map((x) => [x.id, x] as const)
  );
  const path: CollabFolderSummary[] = [];
  let cur: number | null = currentId;
  const guard = new Set<number>();
  while (cur != null && !guard.has(cur)) {
    guard.add(cur);
    const f: CollabFolderSummary | undefined = byId[cur];
    if (!f) break;
    path.unshift(f);
    cur = f.parentId;
  }
  return path;
}

/** Текущая папка навигации лежит внутри удаляемого поддерева (сама папка или потомок)? */
function collabFolderIsUnderRoot(
  allFolders: CollabFolderSummary[],
  rootFolderId: number,
  cursorFolderId: number | null
): boolean {
  if (cursorFolderId == null) return false;
  const byId = Object.fromEntries(allFolders.map((f) => [f.id, f]));
  let cur: number | null = cursorFolderId;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    if (cur === rootFolderId) return true;
    cur = byId[cur]?.parentId ?? null;
  }
  return false;
}

/**
 * Панель файлового дерева совместных документов одной группы.
 *
 * @param groupId — id группы
 * @param socket — для `collab:tree-refresh`
 * @param groupRole — `admin` | `moderator` | `member` (обход паролей папок для модов)
 * @param openDocumentId — внешний запрос открыть документ по id (с задач или чата)
 * @param onOpenDocumentHandled — вызвать после попытки открытия (успех/ошибка)
 * @param returnToTasksOnClose / onReturnFromDocument — сценарий «назад на задачи»
 * @param collabJumpFromChat — предзаполненные пароли из чата
 */
export function GroupWorkspace({
  groupId,
  socket,
  me,
  groupRole,
  openDocumentId,
  onOpenDocumentHandled,
  returnToTasksOnClose,
  onReturnFromDocument,
  collabJumpFromChat,
  onCollabJumpFromChatApplied,
  openMessageAttachment,
  onCloseMessageAttachment,
}: {
  groupId: number;
  socket: Socket;
  me: User;
  groupRole: string;
  /** Просмотр вложения из чата (та же оболочка, что у открытого документа) */
  openMessageAttachment?: { id: number; fileName: string; ooMode?: 'view' | 'edit' } | null;
  onCloseMessageAttachment?: () => void;
  /** Открыть документ с другой вкладки (например с доски задач) */
  openDocumentId?: number | null;
  onOpenDocumentHandled?: () => void;
  /** Документ открыт из вкладки «Задачи» — «Назад» вернуть на задачи */
  returnToTasksOnClose?: boolean;
  onReturnFromDocument?: () => void;
  /** Пароли, введенные при переходе из чата (до открытия редактора) */
  collabJumpFromChat?: {
    docId: number;
    folderId: number | null;
    docPassword: string;
    folderPassword: string;
    docFingerprint: string | null;
    folderFingerprint: string | null;
  } | null;
  onCollabJumpFromChatApplied?: () => void;
}) {
  // --- Состояние дерева, выбранный документ, модалки, DnD ---

  const [folders, setFolders] = useState<CollabFolderSummary[]>([]);
  const [docs, setDocs] = useState<CollabDocSummary[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<number | null>(null);
  const [folderPw, setFolderPw] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<CollabDocSummary | null>(null);
  const [passwords, setPasswords] = useState<Record<number, string>>({});
  const [modalDoc, setModalDoc] = useState(false);
  const [modalFolder, setModalFolder] = useState(false);
  const [editFolder, setEditFolder] = useState<CollabFolderSummary | null>(null);
  const [folderDeleteWithContents, setFolderDeleteWithContents] = useState(false);
  const [editDoc, setEditDoc] = useState<CollabDocSummary | null>(null);
  const [err, setErr] = useState('');
  const [dragActive, setDragActive] = useState<{ kind: 'doc' | 'folder'; id: number } | null>(null);
  const collabDiskRef = useRef<HTMLInputElement>(null);
  const [collabDiskBusy, setCollabDiskBusy] = useState(false);
  const [collabFileDragOver, setCollabFileDragOver] = useState(false);
  const [docNameSearch, setDocNameSearch] = useState('');

  const isMod = groupRole === 'admin' || groupRole === 'moderator';

  // --- Загрузка папок/документов, сокет, синхронизация паролей из storage, внешнее открытие doc ---

  const refresh = useCallback(async () => {
    const q = collabDocsQuery(currentFolderId, folderPw, isMod);
    const [fl, dl] = await Promise.all([
      api<CollabFolderSummary[]>(`/api/groups/${groupId}/collab-folders`),
      api<CollabDocSummary[]>(`/api/groups/${groupId}/collab-docs${q}`),
    ]);
    setFolders(Array.isArray(fl) ? fl : []);
    setDocs(Array.isArray(dl) ? dl : []);
  }, [groupId, currentFolderId, folderPw, isMod]);

  useEffect(() => {
    refresh().catch((e: Error) => setErr(e.message));
  }, [refresh]);

  useEffect(() => {
    if (!socket) return;
    const onTree = (p: { groupId?: number }) => {
      if (p?.groupId === groupId) void refresh();
    };
    socket.on('collab:tree-refresh', onTree);
    return () => {
      socket.off('collab:tree-refresh', onTree);
    };
  }, [socket, groupId, refresh]);

  useEffect(() => {
    setFolderPw(buildFolderPwMap(groupId, folders));
  }, [groupId, folders]);

  useEffect(() => {
    setPasswords((prev) => mergeDocUnlocksFromStore(groupId, docs, prev));
  }, [groupId, docs]);

  useEffect(() => {
    if (editFolder) setFolderDeleteWithContents(false);
  }, [editFolder?.id]);

  useEffect(() => {
    if (!collabJumpFromChat || openDocumentId !== collabJumpFromChat.docId) return;
    const j = collabJumpFromChat;
    if (j.folderId != null && j.folderPassword.trim() && j.folderFingerprint) {
      setFolderPw((prev) => ({ ...prev, [j.folderId!]: j.folderPassword }));
      rememberFolderUnlock(groupId, j.folderId, j.folderFingerprint, j.folderPassword);
    }
    if (j.docPassword.trim() && j.docFingerprint) {
      setPasswords((prev) => ({ ...prev, [j.docId]: j.docPassword }));
      rememberDocUnlock(groupId, j.docId, j.docFingerprint, j.docPassword);
    }
    onCollabJumpFromChatApplied?.();
  }, [openDocumentId, collabJumpFromChat, groupId, onCollabJumpFromChatApplied]);

  useEffect(() => {
    if (openDocumentId == null || !Number.isFinite(openDocumentId)) return;
    const id = openDocumentId;
    void (async () => {
      try {
        const meta = await api<{
          id: number;
          folderId: number | null;
          name: string;
          description: string;
          docType: 'richtext' | 'spreadsheet';
          hasPassword: boolean;
          passwordFingerprint: string | null;
          updatedAt: string;
          createdById: number;
        }>(`/api/collab-docs/${id}/meta`);
        setCurrentFolderId(meta.folderId ?? null);
        setSelected({
          id: meta.id,
          folderId: meta.folderId,
          name: meta.name,
          description: meta.description ?? '',
          docType: meta.docType,
          hasPassword: meta.hasPassword,
          passwordFingerprint: meta.passwordFingerprint ?? null,
          updatedAt: meta.updatedAt,
          createdById: meta.createdById,
        });
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        onOpenDocumentHandled?.();
      }
    })();
  }, [openDocumentId, onOpenDocumentHandled]);

  useEffect(() => {
    setSelected((prev) => {
      if (!prev) return prev;
      const d = docs.find((x) => x.id === prev.id);
      return d ?? prev;
    });
  }, [docs]);

  useEffect(() => {
    if (openMessageAttachment) setSelected(null);
  }, [openMessageAttachment?.id]);

  const canDeleteDoc = (d: CollabDocSummary) => d.createdById === me.id || isMod;
  const canEditFolder = (f: CollabFolderSummary) => f.createdById === me.id || isMod;

  const subfolders = useMemo(() => {
    const list = Array.isArray(folders) ? folders : [];
    return list.filter((f) =>
      currentFolderId == null ? f.parentId == null : f.parentId === currentFolderId
    );
  }, [folders, currentFolderId]);

  const breadcrumbs = useMemo(
    () => folderPathParts(currentFolderId, folders),
    [currentFolderId, folders]
  );

  const docSearchNeedle = docNameSearch.trim().toLowerCase();
  const visibleDocs = useMemo(() => {
    if (!docSearchNeedle) return docs;
    return docs.filter((d) => String(d.name || '').toLowerCase().includes(docSearchNeedle));
  }, [docs, docSearchNeedle]);

  // --- Обход папок, открытие документа, импорт с диска, DnD перемещения ---

  async function enterFolder(f: CollabFolderSummary) {
    if (!isMod && f.hasPassword && !folderPw[f.id]) {
      let p = '';
      if (f.passwordFingerprint) {
        const e = readCollabUnlock(groupId).folders[String(f.id)];
        if (e && e.fp === f.passwordFingerprint) p = e.pw;
      }
      if (!p) {
        p = (await uiPrompt(`Пароль папки «${f.name}»`, { title: 'Требуется пароль' })) || '';
        if (!p) return;
      }
      setFolderPw((prev) => ({ ...prev, [f.id]: p }));
      rememberFolderUnlock(groupId, f.id, f.passwordFingerprint, p);
    }
    setCurrentFolderId(f.id);
  }

  async function openDoc(d: CollabDocSummary) {
    if (!isMod && d.hasPassword && !passwords[d.id]) {
      let p = '';
      if (d.passwordFingerprint) {
        const e = readCollabUnlock(groupId).docs[String(d.id)];
        if (e && e.fp === d.passwordFingerprint) p = e.pw;
      }
      if (!p) {
        p = (await uiPrompt(`Пароль для «${d.name}»`, { title: 'Требуется пароль' })) || '';
        if (!p) return;
      }
      setPasswords((prev) => ({ ...prev, [d.id]: p }));
      rememberDocUnlock(groupId, d.id, d.passwordFingerprint, p);
    }
    setSelected(d);
  }

  const folderPasswordForOpenDoc =
    isMod || currentFolderId == null ? '' : folderPw[currentFolderId] || '';

  const handleCollabDiskFile = useCallback(
    async (f: File, folderOverride?: number | null) => {
      setErr('');
      let docType: 'richtext' | 'spreadsheet';
      try {
        docType = inferCollabDocTypeFromDiskImportFile(f);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Недопустимый файл');
        return;
      }
      const folderForCreate = folderOverride !== undefined ? folderOverride : currentFolderId;
      setCollabDiskBusy(true);
      const base = f.name.replace(/\.[^.]+$/, '') || f.name;
      let docId = 0;
      try {
        const json: Record<string, unknown> = {
          name: base,
          docType,
          description: `Импорт из файла ${f.name}`,
        };
        if (folderForCreate != null) {
          json.folderId = folderForCreate;
          if (!isMod) {
            const pw = folderPw[folderForCreate];
            if (pw) json.folderPassword = pw;
          }
        }
        const docMeta = await api<{ id: number }>(`/api/groups/${groupId}/collab-docs`, {
          method: 'POST',
          json,
        });
        docId = docMeta.id;
        let ooEnabled = false;
        try {
          const en = await api<{ enabled: boolean }>('/api/onlyoffice/enabled');
          ooEnabled = !!en.enabled;
        } catch {
          ooEnabled = false;
        }
        if (ooEnabled && !isCollabDiskImageFile(f)) {
          const fd = new FormData();
          fd.append('file', f);
          if (!isMod && folderForCreate != null) {
            const fpw = folderPw[folderForCreate];
            if (fpw) fd.append('folderPassword', fpw);
          }
          await apiForm(`/api/collab-docs/${docId}/import-onlyoffice`, fd);
        } else {
          const seed = await import('./collabImportSeed');
          const access: Record<string, string> = {};
          if (!isMod && folderForCreate != null) {
            const fpw = folderPw[folderForCreate];
            if (fpw) access.folderPassword = fpw;
          }
          if (docType === 'spreadsheet') {
            const data = await f.arrayBuffer();
            const update = seed.buildSpreadsheetYUpdateFromFile(f, data);
            await api(`/api/collab-docs/${docId}/y-seed`, {
              method: 'POST',
              json: { initialStateBase64: yjsUpdateToBase64(update), ...access },
            });
          } else if (isCollabDiskImageFile(f)) {
            const fdImg = new FormData();
            fdImg.append('file', f);
            if (!isMod && folderForCreate != null) {
              const fpw = folderPw[folderForCreate];
              if (fpw) fdImg.append('folderPassword', fpw);
            }
            const { url } = await apiForm<{ url: string }>(`/api/collab-docs/${docId}/collab-image-upload`, fdImg);
            const alt = (f.name.replace(/\.[^.]+$/, '') || f.name || 'фото').slice(0, 200);
            const update = await seed.buildRichTextYUpdateFromImageUrl(resolveUrl(url), alt);
            await api(`/api/collab-docs/${docId}/y-seed`, {
              method: 'POST',
              json: { initialStateBase64: yjsUpdateToBase64(update), ...access },
            });
          } else {
            const update = await seed.buildRichTextYUpdateFromFile(f);
            await api(`/api/collab-docs/${docId}/y-seed`, {
              method: 'POST',
              json: { initialStateBase64: yjsUpdateToBase64(update), ...access },
            });
          }
        }
        await refresh();
      } catch (e) {
        setErr((e as Error).message);
        if (docId > 0) {
          try {
            await api(`/api/collab-docs/${docId}`, { method: 'DELETE' });
          } catch {
            /* noop */
          }
        }
      } finally {
        setCollabDiskBusy(false);
      }
    },
    [groupId, currentFolderId, folderPw, isMod, refresh]
  );

  async function moveDocToFolder(docId: number, targetFolderId: number | null) {
    const docRow = docs.find((x) => x.id === docId);
    const body: Record<string, unknown> = { folderId: targetFolderId };
    if (!isMod && docRow?.hasPassword) {
      let sp = passwords[docId] || '';
      if (!sp) {
        sp = (await uiPrompt(`Пароль документа «${docRow.name}», чтобы переместить его`, { title: 'Требуется пароль' })) || '';
        if (!sp) return;
        setPasswords((prev) => ({ ...prev, [docId]: sp }));
        rememberDocUnlock(groupId, docId, docRow.passwordFingerprint, sp);
      }
      body.sourceDocPassword = sp;
    }
    if (targetFolderId != null && !isMod) {
      const tf = folders.find((x) => x.id === targetFolderId);
      if (tf?.hasPassword) {
        let pw = folderPw[targetFolderId] || '';
        if (!pw) {
          pw = (await uiPrompt(`Пароль папки «${tf.name}», куда переносите документ`, { title: 'Требуется пароль' })) || '';
          if (!pw) return;
          setFolderPw((prev) => ({ ...prev, [targetFolderId]: pw }));
          rememberFolderUnlock(groupId, targetFolderId, tf.passwordFingerprint, pw);
        }
        body.targetFolderPassword = pw;
      }
    }
    await api(`/api/collab-docs/${docId}`, { method: 'PATCH', json: body });
    await refresh();
  }

  async function moveFolderToFolder(movingFolderId: number, targetParentId: number | null) {
    if (targetParentId === movingFolderId) return;
    const movingFolder = folders.find((x) => x.id === movingFolderId);
    const body: Record<string, unknown> = { parentId: targetParentId };
    if (!isMod && movingFolder?.hasPassword) {
      let sp = folderPw[movingFolderId] || '';
      if (!sp) {
        sp = (await uiPrompt(`Пароль папки «${movingFolder.name}», чтобы переместить её`, { title: 'Требуется пароль' })) || '';
        if (!sp) return;
        setFolderPw((prev) => ({ ...prev, [movingFolderId]: sp }));
        rememberFolderUnlock(groupId, movingFolderId, movingFolder.passwordFingerprint, sp);
      }
      body.sourceFolderPassword = sp;
    }
    if (targetParentId != null && !isMod) {
      const tf = folders.find((x) => x.id === targetParentId);
      if (tf?.hasPassword) {
        let pw = folderPw[targetParentId] || '';
        if (!pw) {
          pw = (await uiPrompt(`Пароль папки назначения «${tf.name}»`, { title: 'Требуется пароль' })) || '';
          if (!pw) return;
          setFolderPw((prev) => ({ ...prev, [targetParentId]: pw }));
          rememberFolderUnlock(groupId, targetParentId, tf.passwordFingerprint, pw);
        }
        body.targetParentFolderPassword = pw;
      }
    }
    await api(`/api/collab-folders/${movingFolderId}`, { method: 'PATCH', json: body });
    await refresh();
  }

  async function handleDropOnFolder(e: ReactDragEvent, targetFolderId: number | null) {
    e.preventDefault();
    setDragActive(null);
    const fromDisk = e.dataTransfer.files?.[0];
    if (fromDisk) {
      try {
        assertCollabDiskFileSupported(fromDisk);
        void handleCollabDiskFile(fromDisk, targetFolderId);
      } catch (er) {
        setErr(er instanceof Error ? er.message : 'Неподдерживаемый файл');
      }
      return;
    }
    const docId = e.dataTransfer.getData(DOC_MIME);
    const folderId = e.dataTransfer.getData(FOLDER_MIME);
    try {
      if (docId) {
        await moveDocToFolder(+docId, targetFolderId);
      } else if (folderId) {
        const fid = +folderId;
        if (fid === targetFolderId) return;
        await moveFolderToFolder(fid, targetFolderId);
      }
    } catch (er) {
      setErr((er as Error).message);
    }
  }

  const isOsFileDrag = useCallback((e: ReactDragEvent) => {
    const dt = e.dataTransfer;
    if ([...dt.types].includes('Files')) return true;
    if (dt.items?.length) {
      return Array.from(dt.items).some((it) => it.kind === 'file');
    }
    return false;
  }, []);

  const onCollabPanelFileDragOver = useCallback(
    (e: ReactDragEvent) => {
      if (!isOsFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setCollabFileDragOver(true);
    },
    [isOsFileDrag]
  );

  const onCollabPanelFileDragLeave = useCallback((e: ReactDragEvent) => {
    const rel = e.relatedTarget as Node | null;
    if (rel && e.currentTarget.contains(rel)) return;
    setCollabFileDragOver(false);
  }, []);

  const onCollabPanelFileDrop = useCallback(
    (e: ReactDragEvent) => {
      setCollabFileDragOver(false);
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      const f = e.dataTransfer.files?.[0];
      if (!f) return;
      try {
        assertCollabDiskFileSupported(f);
        void handleCollabDiskFile(f);
      } catch (er) {
        setErr(er instanceof Error ? er.message : 'Неподдерживаемый файл');
      }
    },
    [handleCollabDiskFile]
  );

  // --- Полноэкранный редактор (отдельный чанк) ---

  if (openMessageAttachment) {
    return (
      <Suspense fallback={<p className="meta lc-workspace-suspense">Загрузка просмотра…</p>}>
        <MessageAttachmentOoView
          attachmentId={openMessageAttachment.id}
          fileName={openMessageAttachment.fileName}
          ooMode={openMessageAttachment.ooMode ?? 'view'}
          onBack={() => onCloseMessageAttachment?.()}
        />
      </Suspense>
    );
  }

  if (selected) {
    const pw = isMod || !selected.hasPassword ? '' : passwords[selected.id] ?? '';
    return (
      <Suspense fallback={<p className="meta lc-workspace-suspense">Загрузка редактора…</p>}>
        <CollabDocView
          docId={selected.id}
          docType={selected.docType}
          docName={selected.name}
          docDescription={selected.description ?? ''}
          canEditMeta={selected.createdById === me.id || isMod}
          password={pw}
          folderPassword={isMod ? undefined : folderPasswordForOpenDoc || undefined}
          socket={socket}
          onBack={() => {
            setSelected(null);
            if (returnToTasksOnClose) onReturnFromDocument?.();
          }}
          onMetaSaved={() => void refresh()}
        />
      </Suspense>
    );
  }

  return (
    <div
      className={`lc-workspace-panel${collabFileDragOver ? ' lc-workspace-panel--file-drop' : ''}`}
      onDragOver={onCollabPanelFileDragOver}
      onDragLeave={onCollabPanelFileDragLeave}
      onDrop={onCollabPanelFileDrop}
    >
      <input
        ref={collabDiskRef}
        type="file"
        accept={COLLAB_DISK_FILE_ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void handleCollabDiskFile(file);
        }}
      />
      <div className="row-actions lc-doc-toolbar">
        <button type="button" className="primary" onClick={() => setModalFolder(true)}>
          + Папка
        </button>
        <button type="button" className="primary" onClick={() => setModalDoc(true)}>
          + Документ / таблица
        </button>
        <button
          type="button"
          disabled={collabDiskBusy}
          onClick={() => collabDiskRef.current?.click()}
          title="Word, Excel или фото (JPEG, PNG, …)"
        >
          {collabDiskBusy ? 'Загрузка…' : 'Загрузить с диска'}
        </button>
        <label className="lc-workspace-name-search">
          <span className="lc-workspace-name-search-label">Поиск</span>
          <input
            type="search"
            className="lc-workspace-search-input"
            value={docNameSearch}
            onChange={(e) => setDocNameSearch(e.target.value)}
            placeholder="Название документа"
            aria-label="Поиск документов по названию"
          />
        </label>
      </div>

      <nav className="lc-doc-breadcrumbs" aria-label="Папки">
        <button
          type="button"
          className="lc-crumb"
          onClick={() => setCurrentFolderId(null)}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = isOsFileDrag(e) ? 'copy' : 'move';
          }}
          onDrop={(e) => void handleDropOnFolder(e, null)}
        >
          Документы
        </button>
        {breadcrumbs.map((f) => (
          <span key={f.id} className="lc-crumb-wrap">
            <span className="lc-crumb-sep">/</span>
            <button
              type="button"
              className="lc-crumb"
              onClick={() => setCurrentFolderId(f.id)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = isOsFileDrag(e) ? 'copy' : 'move';
              }}
              onDrop={(e) => void handleDropOnFolder(e, f.id)}
            >
              {f.name}
            </button>
          </span>
        ))}
      </nav>

      {currentFolderId != null && (
        <div
          className={`lc-doc-drop-root${dragActive != null ? ' lc-doc-drop-root--active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = isOsFileDrag(e) ? 'copy' : 'move';
          }}
          onDrop={(e) => void handleDropOnFolder(e, null)}
        >
          Перетащите документ или папку сюда — в корень группы
        </div>
      )}

      {err && <p className="error">{err}</p>}

      <ul className="lc-doc-list">
        {subfolders.map((f) => (
          <li key={f.id} className="lc-doc-list-item">
            <span
              className="lc-doc-drag-handle"
              draggable
              title="Перетащите в другую папку"
              onDragStart={(e) => {
                e.dataTransfer.setData(FOLDER_MIME, String(f.id));
                e.dataTransfer.effectAllowed = 'move';
                setDragActive({ kind: 'folder', id: f.id });
              }}
              onDragEnd={() => setDragActive(null)}
            >
              ⠿
            </span>
            <button
              type="button"
              className="lc-folder-card"
              onClick={() => enterFolder(f)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = isOsFileDrag(e) ? 'copy' : 'move';
              }}
              onDrop={(e) => void handleDropOnFolder(e, f.id)}
            >
              <span className="lc-folder-card-icon" aria-hidden>
                📁
              </span>
              <span className="lc-doc-card-body">
                <span className="lc-doc-card-name">
                  {f.name} {f.hasPassword ? '🔒' : ''}
                </span>
                <span className="lc-doc-card-meta">Папка</span>
              </span>
            </button>
            {canEditFolder(f) && (
              <button
                type="button"
                className="lc-doc-delete"
                title="Редактировать папку"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditFolder(f);
                }}
              >
                Изменить
              </button>
            )}
          </li>
        ))}

        {visibleDocs.map((d) => (
          <li key={d.id} className="lc-doc-list-item">
            <span
              className="lc-doc-drag-handle"
              draggable
              title="Перетащите в папку"
              onDragStart={(e) => {
                e.dataTransfer.setData(DOC_MIME, String(d.id));
                e.dataTransfer.effectAllowed = 'move';
                setDragActive({ kind: 'doc', id: d.id });
              }}
              onDragEnd={() => setDragActive(null)}
            >
              ⠿
            </span>
            <button
              type="button"
              className={`lc-doc-card lc-doc-card--${d.docType}`}
              onClick={() => openDoc(d)}
            >
              <span className="lc-doc-card-icon" aria-hidden>
                {d.docType === 'richtext' ? 'W' : 'X'}
              </span>
              <span className="lc-doc-card-body">
                <span className="lc-doc-card-name">
                  {d.name} {d.hasPassword ? '🔒' : ''}
                </span>
                {d.description?.trim() && (
                  <span className="lc-doc-card-desc">{d.description.trim()}</span>
                )}
                <span className="lc-doc-card-meta">
                  {d.docType === 'richtext' ? 'Microsoft Word' : 'Microsoft Excel'} · {d.updatedAt}
                </span>
              </span>
            </button>
            {canDeleteDoc(d) && (
              <div className="lc-doc-row-actions">
                <button
                  type="button"
                  className="lc-doc-delete"
                  title="Переименовать, пароль"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditDoc(d);
                  }}
                >
                  Изменить
                </button>
                <button
                  type="button"
                  className="danger lc-doc-delete"
                  title="Удалить документ"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!(await uiConfirm(`Удалить документ «${d.name}»?`, { title: 'Удаление документа', danger: true, okText: 'Удалить' }))) return;
                    try {
                      await api(`/api/collab-docs/${d.id}`, { method: 'DELETE' });
                      setSelected((s) => (s?.id === d.id ? null : s));
                      refresh();
                    } catch (er) {
                      setErr((er as Error).message);
                    }
                  }}
                >
                  Удалить
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {subfolders.length === 0 && visibleDocs.length === 0 && !err && (
        <p className="meta">
          {docSearchNeedle && docs.length > 0
            ? 'Нет документов с таким названием в этой папке.'
            : 'В этой папке пусто. Создайте папку или документ.'}
        </p>
      )}

      {modalDoc && (
        <div className="modal-backdrop" role="presentation" onClick={() => setModalDoc(false)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Новый документ</h3>
            <form
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const name = String(fd.get('name') || '').trim();
                if (!name) {
                  setErr('Введите название документа');
                  return;
                }
                const json: Record<string, unknown> = {
                  name,
                  docType: fd.get('docType'),
                  description: String(fd.get('description') || '').trim() || undefined,
                  password: fd.get('password') || undefined,
                };
                if (currentFolderId != null) {
                  json.folderId = currentFolderId;
                  if (!isMod) {
                    const pw = folderPw[currentFolderId];
                    if (pw) json.folderPassword = pw;
                  }
                }
                try {
                  await api(`/api/groups/${groupId}/collab-docs`, {
                    method: 'POST',
                    json,
                  });
                  setModalDoc(false);
                  refresh();
                } catch (er) {
                  setErr((er as Error).message);
                }
              }}
            >
              <div className="field">
                <label>Название</label>
                <input name="name" />
              </div>
              <div className="field">
                <label>Описание</label>
                <textarea name="description" rows={3} className="lc-textarea-field" placeholder="Необязательно" />
              </div>
              <div className="field">
                <label>Тип</label>
                <select name="docType" className="lc-select-field" defaultValue="richtext">
                  <option value="richtext">Документ Word</option>
                  <option value="spreadsheet">Книга Excel</option>
                </select>
              </div>
              <div className="field">
                <label>Пароль (необязательно)</label>
                <input name="password" type="password" />
              </div>
              <button type="submit" className="primary">
                Создать
              </button>
            </form>
            <button type="button" style={{ marginTop: 12 }} onClick={() => setModalDoc(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {modalFolder && (
        <div className="modal-backdrop" role="presentation" onClick={() => setModalFolder(false)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Новая папка</h3>
            <form
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const name = String(fd.get('name') || '').trim();
                if (!name) {
                  setErr('Введите название папки');
                  return;
                }
                const json: Record<string, unknown> = {
                  name,
                  password: fd.get('password') || undefined,
                };
                if (currentFolderId != null) {
                  json.parentId = currentFolderId;
                  if (!isMod) {
                    const pw = folderPw[currentFolderId];
                    if (pw) json.parentFolderPassword = pw;
                  }
                }
                try {
                  await api(`/api/groups/${groupId}/collab-folders`, {
                    method: 'POST',
                    json,
                  });
                  setModalFolder(false);
                  refresh();
                } catch (er) {
                  setErr((er as Error).message);
                }
              }}
            >
              <div className="field">
                <label>Название</label>
                <input name="name" />
              </div>
              <div className="field">
                <label>Пароль папки (необязательно)</label>
                <input name="password" type="password" />
              </div>
              <button type="submit" className="primary">
                Создать
              </button>
            </form>
            <button type="button" style={{ marginTop: 12 }} onClick={() => setModalFolder(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {editDoc && (
        <div className="modal-backdrop" role="presentation" onClick={() => setEditDoc(null)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Документ «{editDoc.name}»</h3>
            <form
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const clear = fd.get('clearPassword') === 'on';
                const newPw = String(fd.get('newPassword') || '').trim();
                const name = String(fd.get('name') || '').trim();
                if (!name) {
                  setErr('Введите название документа');
                  return;
                }
                const json: Record<string, unknown> = {
                  name,
                  description: String(fd.get('description') || '').trim(),
                };
                if (clear) json.clearPassword = true;
                else if (newPw) json.password = newPw;
                try {
                  await api(`/api/collab-docs/${editDoc.id}`, { method: 'PATCH', json });
                  setEditDoc(null);
                  await refresh();
                } catch (er) {
                  setErr((er as Error).message);
                }
              }}
            >
              <div className="field">
                <label>Название</label>
                <input name="name" defaultValue={editDoc.name} />
              </div>
              <div className="field">
                <label>Описание</label>
                <textarea
                  name="description"
                  rows={3}
                  className="lc-textarea-field"
                  defaultValue={editDoc.description ?? ''}
                />
              </div>
              <div className="field">
                <label>Новый пароль (оставьте пустым, если не меняете)</label>
                <input name="newPassword" type="password" autoComplete="new-password" />
              </div>
              <div className="field lc-field-checkbox">
                <label>
                  <input name="clearPassword" type="checkbox" /> Снять пароль с документа
                </label>
              </div>
              <button type="submit" className="primary">
                Сохранить
              </button>
            </form>
            <button type="button" style={{ marginTop: 12 }} onClick={() => setEditDoc(null)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {editFolder && (
        <div className="modal-backdrop" role="presentation" onClick={() => setEditFolder(null)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Папка «{editFolder.name}»</h3>
            <form
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const clear = fd.get('clearPassword') === 'on';
                const newPw = String(fd.get('newPassword') || '').trim();
                const name = String(fd.get('name') || '').trim();
                if (!name) {
                  setErr('Введите название папки');
                  return;
                }
                const json: Record<string, unknown> = { name };
                if (clear) json.clearPassword = true;
                else if (newPw) json.password = newPw;
                try {
                  await api(`/api/collab-folders/${editFolder.id}`, {
                    method: 'PATCH',
                    json,
                  });
                  setEditFolder(null);
                  refresh();
                } catch (er) {
                  setErr((er as Error).message);
                }
              }}
            >
              <div className="field">
                <label>Название</label>
                <input name="name" defaultValue={editFolder.name} />
              </div>
              <div className="field">
                <label>Новый пароль (оставьте пустым, если не меняете)</label>
                <input name="newPassword" type="password" />
              </div>
              <div className="field lc-field-checkbox">
                <label>
                  <input name="clearPassword" type="checkbox" /> Снять пароль с папки
                </label>
              </div>
              <button type="submit" className="primary">
                Сохранить
              </button>
            </form>
            <div className="field lc-field-checkbox" style={{ marginTop: 12 }}>
              <label>
                <input
                  type="checkbox"
                  checked={folderDeleteWithContents}
                  onChange={(e) => setFolderDeleteWithContents(e.target.checked)}
                />{' '}
                Удалить содержимое папки
              </label>
              <p className="meta" style={{ margin: '0.35rem 0 0' }}>
                {folderDeleteWithContents
                  ? 'Будут безвозвратно удалены все вложенные папки и документы.'
                  : 'Вложенные папки и документы переносятся на один уровень вверх (к родителю этой папки).'}
              </p>
            </div>
            <button
              type="button"
              className="danger"
              style={{ marginTop: 12 }}
              onClick={async () => {
                const msg = folderDeleteWithContents
                  ? `Удалить папку «${editFolder.name}» вместе со всем содержимым? Это нельзя отменить.`
                  : `Удалить папку «${editFolder.name}»? Содержимое останется в группе — на уровень выше.`;
                if (!(await uiConfirm(msg, { title: 'Удаление папки', danger: true, okText: 'Удалить' }))) return;
                const del = editFolder;
                try {
                  await api(`/api/collab-folders/${del.id}?deleteContents=${folderDeleteWithContents ? '1' : '0'}`, {
                    method: 'DELETE',
                  });
                  if (folderDeleteWithContents) {
                    if (
                      currentFolderId != null &&
                      (currentFolderId === del.id || collabFolderIsUnderRoot(folders, del.id, currentFolderId))
                    ) {
                      setCurrentFolderId(del.parentId ?? null);
                    }
                  } else if (currentFolderId === del.id) {
                    setCurrentFolderId(del.parentId ?? null);
                  }
                  setEditFolder(null);
                  await refresh();
                } catch (er) {
                  setErr((er as Error).message);
                }
              }}
            >
              Удалить папку
            </button>
            <button type="button" style={{ marginTop: 12 }} onClick={() => setEditFolder(null)}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
