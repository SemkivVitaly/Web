/**
 * @fileoverview Главный экран мессенджера после авторизации.
 *
 * Здесь собраны: сайдбар (группы, личные чаты, кастомные вкладки), лента сообщений,
 * композер с вложениями и `#`/`-упоминаниями`, вложения/поиск по чату, треды,
 * интеграция с вкладками «Документы» и «Задачи» (lazy), Socket.IO для realtime,
 * модалки (профиль, коллеги, группы, аудит и т.д.).
 *
 * Общую логику времени, таймлайна, иконок и персистенции навигации см. {@link ./chat/foundation}.
 */

import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  useId,
  lazy,
  Suspense,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { io, Socket } from 'socket.io-client';
import { api, apiForm, apiFormWithProgress, getToken, getApiOrigin, resolveUrl, resolveAttachmentThumbUrl } from './api';
import { compressImageFilesForUpload } from './chat/imageCompress';
import { uiConfirm, uiPrompt } from './ui/dialogs';
import type {
  User,
  Message,
  MessageWorkspaceLink,
  GroupSummary,
  DirectSummary,
  ChatPref,
  ChatAttachmentIndexItem,
  ChatLinkIndexItem,
  MessageReactionGroup,
  InvitePolicy,
  Attachment,
} from './types';
import { normalizeLoadedMessage } from './chat/messageNormalize';
import { ChatImageLightbox, type ChatImageLightboxItem } from './chat/ChatImageLightbox';
import { capComposerPhotoFiles, MessageImageGrid, MAX_MESSAGE_PHOTOS } from './chat/MessageImageGrid';
import { PhotoAnnotator } from './chat/PhotoAnnotator';
import {
  AnnouncementAckModal,
  GroupAnnouncementsModal,
  type GroupAnnouncement,
  type AnnouncementAttachment,
} from './chat/AnnouncementModals';
import { MyAssignmentsBadgeButton, MyAssignmentsPanel } from './chat/MyAssignmentsPanel';
import {
  readCollabUnlock,
  rememberDocUnlock,
  rememberFolderUnlock,
} from './workspace/collabUnlockStorage';
import { getStoredTaskBoardPassword, rememberTaskBoardUnlock } from './workspace/taskBoardUnlockStorage';
import {
  type Active,
  type GroupTab,
  type ToastPayload,
  type CustomChatTab,
  type AttachmentGalleryTab,
  type MemberReadCursor,
  loadNavState,
  saveNavState,
  readCollabOpenFromTasksSession,
  writeCollabOpenFromTasksSession,
  clearCollabOpenFromTasksSession,
  tryOsMessageNotification,
  playChatNotifySound,
  CUSTOM_CHAT_TABS_KEY,
  CHAT_TAB_DND_MIME,
  parseTabChatDrag,
  syncSocketChatRooms,
  loadCustomChatTabs,
  ChatFavStarButton,
  isChatMutedPrefs,
  attachmentMatchesGalleryTab,
  messageBodyWithSearchMarks,
  previewMessageLine,
  CHAT_TIMEZONE,
  isoToMoscowYmd,
  formatMessageClock,
  formatReceiptWhen,
  MsgReadTicks,
  type MessageReader,
  groupMemberChatEventKind,
  buildChatTimeline,
  directOwnMessageRead,
  groupOwnMessageRead,
  normalizeSearchDateRange,
  CHAT_EMOJIS,
  REACTION_QUICK,
  IconReplyQuick,
  IconMenuReply,
  IconMenuForward,
  IconMenuStar,
  IconMenuCopy,
  IconMenuFriend,
  IconMenuTrash,
  IconMenuSelect,
  IconMenuChevron,
  IconMenuEdit,
  IconHeaderSearch,
  canUseInviteInGroupMod,
  mentionQueryAtCursor,
  mentionAllMatchesAutocompleteQuery,
  hashQueryAtCursor,
  IconMenuPin,
} from './chat/foundation';
import { chatAttachmentSupportsOnlyOffice } from './chat/onlyOfficeAttachment';

/** Ленивая подгрузка тяжёлых панелей рабочей области группы (code splitting). */
const GroupWorkspace = lazy(() =>
  import('./workspace/GroupWorkspace').then((m) => ({ default: m.GroupWorkspace }))
);
const MessageAttachmentOoView = lazy(() =>
  import('./workspace/MessageAttachmentOoView').then((m) => ({ default: m.MessageAttachmentOoView }))
);
const TasksPanel = lazy(() =>
  import('./workspace/TasksPanel').then((m) => ({ default: m.TasksPanel }))
);

/** Размер страницы при первой загрузке ленты и при подгрузке «старее» (`before=id`). */
const MESSAGES_PAGE_SIZE = 80;

type ComposerMentionPick = { userId: number; insert: string };

type MentionPickerItem = { kind: 'all' } | { kind: 'user'; user: User };

/** Id упомянутых из списка @: только если соответствующая вставка «Имя, » ещё есть в тексте (по порядку выбора). */
function mentionUserIdsMatchingBody(picks: readonly ComposerMentionPick[], body: string): number[] {
  let rest = body;
  const ids: number[] = [];
  for (const p of picks) {
    const idx = rest.indexOf(p.insert);
    if (idx < 0) continue;
    ids.push(p.userId);
    rest = rest.slice(0, idx) + rest.slice(idx + p.insert.length);
  }
  return ids;
}

function mentionPicksFromStoredIds(ids: number[], groupMembers: User[]): ComposerMentionPick[] {
  const out: ComposerMentionPick[] = [];
  for (const uid of ids) {
    const u = groupMembers.find((m) => m.id === uid);
    if (!u) continue;
    const label = (u.displayName || '').trim() || u.tag;
    out.push({ userId: uid, insert: `${label}, ` });
  }
  return out;
}

function messageBelongsToChat(m: Message, chat: { kind: 'group' | 'direct'; id: number }): boolean {
  return chat.kind === 'group' ? m.groupId === chat.id : m.directId === chat.id;
}

function messagesBelongToChat(messages: Message[], chat: { kind: 'group' | 'direct'; id: number }): boolean {
  return messages.length > 0 && messages.every((m) => messageBelongsToChat(m, chat));
}

/** Отступ меню «⋯» от краёв окна при проверке, влезает ли оно снизу / сверху. */
const MESSAGE_MENU_VIEWPORT_MARGIN = 12;

/**
 * Корневой компонент чата: состояние, сеть, разметка.
 *
 * @param me — пользователь из `/api/me` после входа
 * @param onLogout — очистка токена и возврат на экран логина (`App`)
 * @param onMeUpdated — вызывается после сохранения профиля, чтобы обновить `me` в родителе
 */
export default function ChatApp({
  me,
  onLogout,
  onMeUpdated,
}: {
  me: User;
  onLogout: () => void;
  onMeUpdated?: (u: User) => void;
}) {
  // --- Состояние: списки чатов, активный чат, лента, композер, UI-модалки и ref’ы ---

  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [directs, setDirects] = useState<DirectSummary[]>([]);
  const [prefs, setPrefs] = useState<ChatPref[]>([]);
  const [active, setActive] = useState<Active | null>(() => loadNavState(me.id).active);
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const [hasMoreOlderMessages, setHasMoreOlderMessages] = useState(false);
  const hasMoreOlderRef = useRef(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const loadingOlderRef = useRef(false);
  const [pins, setPins] = useState<Message[]>([]);
  const [members, setMembers] = useState<User[]>([]);
  const [toast, setToast] = useState<ToastPayload | null>(null);
  const [unread, setUnread] = useState<{ groups: Record<number, number>; directs: Record<number, number> }>({
    groups: {},
    directs: {},
  });
  const [modal, setModal] = useState<string | null>(null);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  useEffect(() => {
    if (active) setMobileMoreOpen(false);
  }, [active]);
  const [exitChatModal, setExitChatModal] = useState<
    | null
    | { kind: 'leave-group'; groupId: number; groupName: string }
    | { kind: 'hide-direct'; directId: number; peerName: string }
  >(null);
  const [exitDeleteMyMessages, setExitDeleteMyMessages] = useState(false);
  const [text, setText] = useState('');
  const [composerCaret, setComposerCaret] = useState(0);
  const [mentionPickIdx, setMentionPickIdx] = useState(0);
  /** Выбор из списка @: точная вставка в текст и id (для фильтрации перед отправкой). */
  const [composerMentionPicks, setComposerMentionPicks] = useState<ComposerMentionPick[]>([]);
  const [mentionSuppressKey, setMentionSuppressKey] = useState<string | null>(null);
  const [hashPickerTab, setHashPickerTab] = useState<'task' | 'document'>('task');
  const [hashPickIdx, setHashPickIdx] = useState(0);
  const [hashSuppressKey, setHashSuppressKey] = useState<string | null>(null);
  const [composerWorkspaceLinks, setComposerWorkspaceLinks] = useState<
    { kind: 'task' | 'collab_document'; entityId: number; title: string }[]
  >([]);
  const [hashPickerSuppressAfterPick, setHashPickerSuppressAfterPick] = useState(false);
  const [collabJumpFromChat, setCollabJumpFromChat] = useState<{
    docId: number;
    folderId: number | null;
    docPassword: string;
    folderPassword: string;
    docFingerprint: string | null;
    folderFingerprint: string | null;
  } | null>(null);
  const [pickerTasks, setPickerTasks] = useState<
    { id: number; title: string; boardId: number; boardName: string; boardHasPassword?: boolean }[]
  >([]);
  const [pickerDocs, setPickerDocs] = useState<
    {
      id: number;
      name: string;
      docType: string;
      hasPassword?: boolean;
      previewImageUrl?: string | null;
      imageDocument?: boolean;
    }[]
  >([]);
  const [wsLinkPickModal, setWsLinkPickModal] = useState<
    null | { message: Message; tab: 'task' | 'document' }
  >(null);
  const [wsLinkPickFilter, setWsLinkPickFilter] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const composerFileInputId = useId();
  const [messageUploadProgress, setMessageUploadProgress] = useState<number | null>(null);
  const messageUploadAbortRef = useRef<AbortController | null>(null);
  const sendInFlightRef = useRef(false);
  const forwardInFlightRef = useRef(false);
  const [imageLightbox, setImageLightbox] = useState<{
    items: ChatImageLightboxItem[];
    index: number;
  } | null>(null);
  const [photoAnnotator, setPhotoAnnotator] = useState<{
    src: string;
    fileName: string;
    composerIndex?: number;
    fromLightbox?: boolean;
    revokeOnClose?: boolean;
  } | null>(null);
  const [composerDropFiles, setComposerDropFiles] = useState<File[]>([]);
  /** После выбора файла без нового input повторный change часто не срабатывает (тот же путь и т.д.). */
  const [composerFileInputKey, setComposerFileInputKey] = useState(0);
  const composerFileListenerCleanupRef = useRef<(() => void) | null>(null);
  const bindComposerFileInputRef = useCallback((el: HTMLInputElement | null) => {
    composerFileListenerCleanupRef.current?.();
    composerFileListenerCleanupRef.current = null;
    fileRef.current = el;
    if (!el) return;
    const onPick = () => {
      const list = el.files;
      if (!list?.length) return;
      setComposerDropFiles((prev) =>
        capComposerPhotoFiles(prev, Array.from(list), () =>
          showToast(`Можно прикрепить не больше ${MAX_MESSAGE_PHOTOS} фотографий`)
        )
      );
      setComposerFileInputKey((k) => k + 1);
    };
    el.addEventListener('change', onPick);
    composerFileListenerCleanupRef.current = () => el.removeEventListener('change', onPick);
  }, []);
  const [composerDropHover, setComposerDropHover] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const chatRoomsPrevRef = useRef<{ g: Set<number>; d: Set<number> } | null>(null);
  const activeRef = useRef<Active | null>(null);
  /** Переход из глобального поиска: при смене active подгружаем контекст вокруг этого id */
  const openAtMessageIdRef = useRef<number | null>(null);
  const groupTabRef = useRef<GroupTab>('chat');
  /** После первого успешного refreshLists можно проверять, что active ещё в списках. */
  const listsFetchedOnceRef = useRef(false);
  /** Не сбрасывать groupTab при первом монтировании (восстановление из localStorage). */
  const navHydratedRef = useRef(false);
  const prevActiveKeyRef = useRef<string>('');
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  /** Сохранённая прокрутка ленты при уходе с «Чат» на «Документы»/«Задачи» (ключ `group:id` / `direct:id`). */
  const chatScrollPositionsRef = useRef<Record<string, number>>({});
  const chatScrollLayoutPrevRef = useRef<{ inChatPane: boolean; key: string }>({
    inChatPane: false,
    key: '',
  });
  /** Автопрокрутка вниз только если пользователь уже у низа (или только что сменил чат). */
  const stickToBottomRef = useRef(true);
  /** Макс. id сообщения на момент, когда пользователь был у низа; для счётчика «новых» вне экрана. */
  const belowFoldBaselineIdRef = useRef(0);
  const [belowFoldNewCount, setBelowFoldNewCount] = useState(0);
  /** Показать кнопку «к низу», если лента длинная и пользователь прокрутил вверх (без новых сообщений). */
  const [scrollJumpVisible, setScrollJumpVisible] = useState(false);
  /** Чтобы не дергать прокрутку при каждом setMessages с тем же «хвостом» (прочтения, реакции и т.д.). */
  const messagesTailSigRef = useRef<{ len: number; tailId: number }>({ len: 0, tailId: 0 });
  const [groupTab, setGroupTab] = useState<GroupTab>(() => loadNavState(me.id).groupTab);
  /** Открыть совместный документ при переходе с доски задач */
  const [openCollabDocId, setOpenCollabDocId] = useState<number | null>(null);
  const clearOpenCollabDoc = useCallback(() => {
    setOpenCollabDocId(null);
    setCollabJumpFromChat(null);
  }, []);
  const clearCollabJumpFromChatApplied = useCallback(() => setCollabJumpFromChat(null), []);
  /** Документ открыт из «Задач» — по «Назад» вернуть на задачи, а не оставаться в документах */
  const [collabOpenedFromTasks, setCollabOpenedFromTasks] = useState(false);
  /** Задача в списке, к которой вернуть фокус после выхода из документа, открытого с доски */
  const [collabReturnFocusTaskId, setCollabReturnFocusTaskId] = useState<number | null>(null);
  const [tasksListFocusRequest, setTasksListFocusRequest] = useState<number | null>(null);
  const clearTasksListFocusRequest = useCallback(() => setTasksListFocusRequest(null), []);
  const taskRevealNonceRef = useRef(0);
  const [taskRevealFromChat, setTaskRevealFromChat] = useState<{
    taskId: number;
    boardId: number;
    nonce: number;
  } | null>(null);
  const clearTaskRevealFromChat = useCallback(() => setTaskRevealFromChat(null), []);

  const [sidebarChatTab, setSidebarChatTab] = useState<string>(() => loadNavState(me.id).sidebarChatTab);
  const [customChatTabs, setCustomChatTabs] = useState<CustomChatTab[]>(loadCustomChatTabs);
  const [chatPickForCustomTab, setChatPickForCustomTab] = useState<{
    kind: 'group' | 'direct';
    id: number;
    /** если задан — выбор вкладки переносит чат (убирает из этой вкладки) */
    moveFromTabId?: string;
  } | null>(null);
  const [ioSocket, setIoSocket] = useState<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [messageMenuOpen, setMessageMenuOpen] = useState<number | null>(null);
  /** Вертикальное положение меню «⋯»: вверх от кнопки, если снизу не хватает места во viewport. */
  const [messageMenuOpenAbove, setMessageMenuOpenAbove] = useState(false);
  const messageMenuRef = useRef<HTMLUListElement | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [reactionPickerFor, setReactionPickerFor] = useState<number | null>(null);
  const [forwardFromMessage, setForwardFromMessage] = useState<Message | null>(null);
  const [forwardSubmenuOpen, setForwardSubmenuOpen] = useState(false);
  /** Подменю «⋯» — скачать файлы / в документы (как у «Переслать»). */
  const [fileAttachSubmenu, setFileAttachSubmenu] = useState<
    null | { messageId: number; kind: 'download' | 'collab' }
  >(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Record<number, boolean>>({});
  const [selectForwardOpen, setSelectForwardOpen] = useState(false);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [chatHeaderMenuOpen, setChatHeaderMenuOpen] = useState(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [chatSearchHitIdx, setChatSearchHitIdx] = useState(0);
  const [attachmentsModalOpen, setAttachmentsModalOpen] = useState(false);
  const [attachmentGalleryTab, setAttachmentGalleryTab] = useState<AttachmentGalleryTab>('photos');
  const [attachmentIndex, setAttachmentIndex] = useState<{
    attachments: ChatAttachmentIndexItem[];
    links: ChatLinkIndexItem[];
  } | null>(null);
  const [attachmentIndexLoading, setAttachmentIndexLoading] = useState(false);
  const [ooChatEnabled, setOoChatEnabled] = useState<boolean | null>(null);
  /** Просмотр вложения в OnlyOffice: в «Документах» у группы или полноэкранно в личке. */
  const [attachmentOoViewer, setAttachmentOoViewer] = useState<{
    attachmentId: number;
    fileName: string;
    ooMode: 'view' | 'edit';
    source?: 'message' | 'announcement';
    /** Поверх модалки уведомления — без переключения на вкладку «Документы». */
    overlay?: boolean;
  } | null>(null);
  const chatHeaderMenuRef = useRef<HTMLDivElement>(null);
  const [directPeerRead, setDirectPeerRead] = useState<MemberReadCursor | null>(null);
  const [groupMemberReads, setGroupMemberReads] = useState<Record<number, MemberReadCursor>>({});
  const [dividerAfterReadId, setDividerAfterReadId] = useState<number | null>(null);
  const [chatSearchDateFrom, setChatSearchDateFrom] = useState('');
  const [chatSearchDateTo, setChatSearchDateTo] = useState('');
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQ, setGlobalSearchQ] = useState('');
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchResults, setGlobalSearchResults] = useState<
    { message: Message; chatKind: 'group' | 'direct'; chatId: number; chatLabel: string }[]
  >([]);
  const [directSearchQ, setDirectSearchQ] = useState('');
  const [pendingScrollMessageId, setPendingScrollMessageId] = useState<number | null>(null);
  const [threadPanel, setThreadPanel] = useState<{ rootId: number; messages: Message[] } | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [chatOnlineOtherIds, setChatOnlineOtherIds] = useState<number[]>([]);
  const [chatOnlineListOpen, setChatOnlineListOpen] = useState(false);
  const chatOnlineListRef = useRef<HTMLSpanElement>(null);
  const [typingPeerNames, setTypingPeerNames] = useState<string[]>([]);
  const [pendingAnnouncements, setPendingAnnouncements] = useState<GroupAnnouncement[]>([]);
  const [announcementAckOpen, setAnnouncementAckOpen] = useState(false);
  const [announcementStatsRefreshKey, setAnnouncementStatsRefreshKey] = useState(0);
  const [assignmentBadges, setAssignmentBadges] = useState<Record<number, number>>({});
  const [modUnreadProgress, setModUnreadProgress] = useState<Record<number, number>>({});
  const [myAssignmentsOpen, setMyAssignmentsOpen] = useState(false);
  const [myAssignmentsRefreshKey, setMyAssignmentsRefreshKey] = useState(0);
  const [activeAssignmentCount, setActiveAssignmentCount] = useState(0);
  const [readReceiptsModal, setReadReceiptsModal] = useState<MessageReader[] | null>(null);
  const typingPeersRef = useRef<Map<number, string>>(new Map());
  const typingClearTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const textRef = useRef(text);
  textRef.current = text;
  const prevDraftChatKeyRef = useRef<string>('');
  const typingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingEmitAtRef = useRef(0);
  const prevTypingChatRef = useRef<Active | null>(null);
  const [friendIds, setFriendIds] = useState<Record<number, true>>({});
  const [pendingFriendIn, setPendingFriendIn] = useState<Record<number, true>>({});
  const [pendingFriendOut, setPendingFriendOut] = useState<Record<number, true>>({});
  const [inviteCount, setInviteCount] = useState(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);

  // --- Эффекты: черновики, тосты, списки, наборы данных для композера, закрытие меню ---

  useLayoutEffect(() => {
    if (active?.kind !== 'group') return;
    if (groupTab !== 'collab') return;
    const s = readCollabOpenFromTasksSession(active.id);
    if (!s) return;
    setOpenCollabDocId(s.docId);
    setCollabOpenedFromTasks(true);
    setCollabReturnFocusTaskId(s.taskId);
  }, [active?.kind, active?.id, groupTab]);

  // Таймер скрытия тоста: без ref каждый новый тост «наслаивал» setTimeout-ы,
  // а при unmount они срабатывали на уже размонтированном компоненте.
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((m: ToastPayload) => {
    setToast(m);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 5200);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    []
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await api<{ enabled?: boolean }>('/api/onlyoffice/enabled');
        if (!alive) return;
        setOoChatEnabled(!!r?.enabled);
      } catch {
        if (!alive) return;
        setOoChatEnabled(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [me.id]);

  const openChatAttachmentOnlyOffice = useCallback(
    (attId: number, fileName: string, messageSenderId: number) => {
      setAttachmentsModalOpen(false);
      clearOpenCollabDoc();
      const ooMode: 'view' | 'edit' = +messageSenderId === +me.id ? 'edit' : 'view';
      if (active?.kind === 'group') {
        setGroupTab('collab');
        setAttachmentOoViewer({ attachmentId: attId, fileName, ooMode, source: 'message' });
        return;
      }
      if (active?.kind === 'direct') {
        setAttachmentOoViewer({ attachmentId: attId, fileName, ooMode, source: 'message' });
      }
    },
    [active?.kind, clearOpenCollabDoc, me.id]
  );

  const openAnnouncementAttachmentOnlyOffice = useCallback(
    (attId: number, fileName: string) => {
      if (active?.kind !== 'group') return;
      setAttachmentOoViewer({
        attachmentId: attId,
        fileName,
        ooMode: 'view',
        source: 'announcement',
        overlay: true,
      });
    },
    [active?.kind]
  );

  const closeAttachmentOoViewer = useCallback(() => {
    setAttachmentOoViewer((prev) => {
      if (prev && !prev.overlay && active?.kind === 'group') {
        setGroupTab('chat');
      }
      return null;
    });
  }, [active?.kind]);

  const closeAnnouncementAttachmentOoOverlay = useCallback(() => {
    setAttachmentOoViewer((prev) => (prev?.overlay ? null : prev));
  }, []);

  useEffect(() => {
    setAttachmentOoViewer(null);
  }, [active?.kind, active?.id]);

  useEffect(() => {
    if (active?.kind === 'group' && groupTab !== 'collab') {
      setAttachmentOoViewer((prev) => (prev?.overlay ? prev : null));
    }
  }, [active?.kind, groupTab]);

  const saveChatAttachmentToCollab = useCallback(
    async (groupId: number, attId: number) => {
      try {
        await api<{ documentId: number }>(
          `/api/groups/${groupId}/message-attachments/${attId}/save-to-collab`,
          { method: 'POST', json: {} }
        );
        showToast('Сохранено в документы');
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Не удалось сохранить в документы');
      }
    },
    [showToast]
  );

  const refreshUnread = useCallback(async () => {
    try {
      const r = await api<{ groups?: unknown; directs?: unknown }>('/api/chats/unread');
      const gRaw = r?.groups;
      const dRaw = r?.directs;
      const gObj =
        gRaw && typeof gRaw === 'object' && !Array.isArray(gRaw) ? (gRaw as Record<string, number>) : {};
      const dObj =
        dRaw && typeof dRaw === 'object' && !Array.isArray(dRaw) ? (dRaw as Record<string, number>) : {};
      setUnread({
        groups: Object.fromEntries(Object.entries(gObj).map(([k, v]) => [Number(k), v])),
        directs: Object.fromEntries(Object.entries(dObj).map(([k, v]) => [Number(k), v])),
      });
    } catch {
      /* ignore */
    }
  }, []);

  const refreshAssignmentBadges = useCallback(async () => {
    try {
      const r = await api<{ groups?: unknown; modUnread?: unknown }>('/api/chats/assignment-badges');
      const gRaw = r?.groups;
      const gObj =
        gRaw && typeof gRaw === 'object' && !Array.isArray(gRaw) ? (gRaw as Record<string, number>) : {};
      setAssignmentBadges(Object.fromEntries(Object.entries(gObj).map(([k, v]) => [Number(k), v])));
      const mRaw = r?.modUnread;
      const mObj =
        mRaw && typeof mRaw === 'object' && !Array.isArray(mRaw) ? (mRaw as Record<string, number>) : {};
      setModUnreadProgress(Object.fromEntries(Object.entries(mObj).map(([k, v]) => [Number(k), v])));
    } catch {
      /* ignore */
    }
  }, []);

  const markModAssignmentsSeen = useCallback(
    async (groupId: number) => {
      try {
        await api(`/api/groups/${groupId}/assignments/mod-seen`, { method: 'POST', json: {} });
        setModUnreadProgress((prev) => {
          if (!prev[groupId]) return prev;
          const next = { ...prev };
          delete next[groupId];
          return next;
        });
      } catch {
        /* ignore */
      }
    },
    []
  );

  const openThreadForMessage = useCallback(
    async (m: Message) => {
      if (m.chatEvent) return;
      setThreadLoading(true);
      setThreadPanel(null);
      setMessageMenuOpen(null);
      try {
        const r = await api<{ rootId: number; messages: Message[] }>(`/api/messages/${m.id}/thread`);
        setThreadPanel({
          rootId: r.rootId,
          messages: r.messages.map(normalizeLoadedMessage),
        });
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Не удалось загрузить тред');
      } finally {
        setThreadLoading(false);
      }
    },
    [showToast]
  );

  const refreshLists = useCallback(async () => {
    const [g, d, p] = await Promise.all([
      api<GroupSummary[]>('/api/groups'),
      api<DirectSummary[]>('/api/direct'),
      api<ChatPref[]>('/api/chats/prefs'),
    ]);
    setGroups(Array.isArray(g) ? g : []);
    setDirects(Array.isArray(d) ? d : []);
    setPrefs(Array.isArray(p) ? p : []);
    listsFetchedOnceRef.current = true;
    await Promise.all([refreshUnread(), refreshAssignmentBadges()]);
  }, [refreshUnread, refreshAssignmentBadges]);

  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_CHAT_TABS_KEY, JSON.stringify(customChatTabs));
    } catch {
      /* ignore */
    }
  }, [customChatTabs]);

  const openMessageImageLightbox = useCallback((attachments: Attachment[], attachmentId: number) => {
    const imgs = attachments.filter((a) => a.kind === 'image');
    const index = imgs.findIndex((a) => a.id === attachmentId);
    if (index < 0) return;
    setImageLightbox({
      items: imgs.map((a) => ({ url: resolveUrl(a.url), alt: a.fileName })),
      index,
    });
  }, []);

  const openAnnouncementImageLightbox = useCallback(
    (attachments: AnnouncementAttachment[], attachmentId: number) => {
      const imgs = attachments.filter((a) => a.kind === 'image');
      const index = imgs.findIndex((a) => a.id === attachmentId);
      if (index < 0) return;
      setImageLightbox({
        items: imgs.map((a) => ({ url: resolveUrl(a.url), alt: a.fileName })),
        index,
      });
    },
    []
  );

  const openSingleImageLightbox = useCallback((url: string, alt?: string) => {
    setImageLightbox({ items: [{ url, alt }], index: 0 });
  }, []);

  const openAttachmentGalleryLightbox = useCallback(
    (items: ChatAttachmentIndexItem[], attachmentId: number) => {
      const index = items.findIndex((a) => a.id === attachmentId);
      if (index < 0) return;
      setImageLightbox({
        items: items.map((a) => ({ url: resolveUrl(a.url), alt: a.fileName })),
        index,
      });
    },
    []
  );

  const closePhotoAnnotator = useCallback(() => {
    setPhotoAnnotator((prev) => {
      if (prev?.revokeOnClose && prev.src.startsWith('blob:')) URL.revokeObjectURL(prev.src);
      return null;
    });
  }, []);

  const openComposerPhotoAnnotator = useCallback((file: File, index: number) => {
    setPhotoAnnotator({
      src: URL.createObjectURL(file),
      fileName: file.name,
      composerIndex: index,
      revokeOnClose: true,
    });
  }, []);

  const refreshFriendState = useCallback(async () => {
    try {
      const [f, pend] = await Promise.all([
        api<User[]>('/api/friends'),
        api<{ incoming: User[]; outgoing: User[] }>('/api/friends/pending'),
      ]);
      const friends = Array.isArray(f) ? f : [];
      const inc = Array.isArray(pend?.incoming) ? pend.incoming : [];
      const out = Array.isArray(pend?.outgoing) ? pend.outgoing : [];
      setFriendIds(Object.fromEntries(friends.map((u) => [u.id, true as const])));
      setPendingFriendIn(Object.fromEntries(inc.map((u) => [u.id, true as const])));
      setPendingFriendOut(Object.fromEntries(out.map((u) => [u.id, true as const])));
    } catch {
      /* ignore */
    }
  }, []);

  const refreshInvites = useCallback(async () => {
    try {
      const rows = await api<{ id: number }[]>('/api/groups/invites/incoming');
      setInviteCount(Array.isArray(rows) ? rows.length : 0);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshGroupMembersAndLists = useCallback(async () => {
    await refreshLists();
    if (active?.kind === 'group') {
      const mem = await api<User[]>(`/api/groups/${active.id}/members`);
      setMembers(Array.isArray(mem) ? mem : []);
    }
  }, [refreshLists, active?.kind, active?.id]);

  const patchMessageWorkspaceLinks = useCallback((messageId: number, links: MessageWorkspaceLink[]) => {
    setMessages((prev) => prev.map((x) => (x.id === messageId ? { ...x, workspaceLinks: links } : x)));
    setThreadPanel((tp) =>
      tp?.messages.some((m) => m.id === messageId)
        ? {
            ...tp,
            messages: tp.messages.map((m) => (m.id === messageId ? { ...m, workspaceLinks: links } : m)),
          }
        : tp
    );
  }, []);

  const postWorkspaceLink = useCallback(
    async (m: Message, kind: 'task' | 'collab_document', entityId: number) => {
      try {
        const r = await api<{ workspaceLinks: MessageWorkspaceLink[] }>(
          `/api/messages/${m.id}/workspace-links`,
          {
            method: 'POST',
            json: { kind, entityId },
          }
        );
        patchMessageWorkspaceLinks(m.id, r.workspaceLinks ?? []);
        setMessageMenuOpen(null);
        setForwardSubmenuOpen(false);
        showToast('Связь добавлена');
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Не удалось добавить связь');
      }
    },
    [showToast, patchMessageWorkspaceLinks]
  );

  const removeWorkspaceLink = useCallback(
    async (messageId: number, linkId: number) => {
      try {
        const r = await api<{ workspaceLinks: MessageWorkspaceLink[] }>(
          `/api/messages/${messageId}/workspace-links/${linkId}`,
          { method: 'DELETE' }
        );
        patchMessageWorkspaceLinks(messageId, r.workspaceLinks ?? []);
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Не удалось убрать связь');
      }
    },
    [showToast, patchMessageWorkspaceLinks]
  );

  useEffect(() => {
    // Явно глотаем возможный reject, чтобы не триггерить глобальный unhandledrejection handler:
    // ошибки уже показываются через toast внутри refreshLists.
    void refreshLists().catch(() => {});
  }, [refreshLists]);

  useEffect(() => {
    void refreshFriendState().catch(() => {});
  }, [refreshFriendState]);

  useEffect(() => {
    void refreshInvites().catch(() => {});
  }, [refreshInvites]);

  const friendRequestCount = Object.keys(pendingFriendIn).length;

  useEffect(() => {
    const key = active ? `${active.kind}:${active.id}` : '';
    if (!navHydratedRef.current) {
      navHydratedRef.current = true;
      prevActiveKeyRef.current = key;
      return;
    }
    if (prevActiveKeyRef.current !== key) {
      prevActiveKeyRef.current = key;
      setGroupTab('chat');
    }
  }, [active?.kind, active?.id]);

  useEffect(() => {
    saveNavState(me.id, { active, groupTab, sidebarChatTab });
  }, [me.id, active, groupTab, sidebarChatTab]);

  useEffect(() => {
    if (!listsFetchedOnceRef.current || !active) return;
    if (active.kind === 'group' && !groups.some((g) => g.id === active.id)) {
      setActive(null);
      return;
    }
    if (active.kind === 'direct' && !directs.some((d) => d.id === active.id)) {
      setActive(null);
    }
  }, [groups, directs, active]);

  useEffect(() => {
    setReplyingTo(null);
    setEditingMessage(null);
    setMessageMenuOpen(null);
    setEmojiOpen(false);
    setReactionPickerFor(null);
    setForwardFromMessage(null);
    setForwardSubmenuOpen(false);
    setSelectMode(false);
    setSelectedMessageIds({});
    setSelectForwardOpen(false);
    setChatHeaderMenuOpen(false);
    setChatSearchOpen(false);
    setChatSearchQuery('');
    setChatSearchDateFrom('');
    setChatSearchDateTo('');
    setChatSearchHitIdx(0);
    setAttachmentsModalOpen(false);
    setAttachmentIndex(null);
    setDirectPeerRead(null);
    setGroupMemberReads({});
    setThreadPanel(null);
    setThreadLoading(false);
    setChatOnlineOtherIds([]);
    for (const t of typingClearTimersRef.current.values()) clearTimeout(t);
    typingClearTimersRef.current.clear();
    typingPeersRef.current.clear();
    setTypingPeerNames([]);
    setComposerMentionPicks([]);
    setComposerDropFiles([]);
    setComposerFileInputKey((k) => k + 1);
  }, [active?.kind, active?.id]);

  useEffect(() => {
    const key = active ? `${active.kind}:${active.id}` : '';
    const prevKey = prevDraftChatKeyRef.current;
    if (prevKey && prevKey !== key) {
      try {
        localStorage.setItem(
          `localchat_draft_v1_u${me.id}_${prevKey}`,
          JSON.stringify({ v: 1, text: textRef.current })
        );
      } catch {
        /* ignore */
      }
    }
    prevDraftChatKeyRef.current = key;
    if (key) {
      try {
        const raw = localStorage.getItem(`localchat_draft_v1_u${me.id}_${key}`);
        const o = raw ? JSON.parse(raw) : null;
        setText(typeof o?.text === 'string' ? o.text : '');
      } catch {
        setText('');
      }
    } else {
      setText('');
    }
  }, [active?.kind, active?.id, me.id]);

  useEffect(() => {
    const key = active ? `${active.kind}:${active.id}` : '';
    if (!key) return;
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(`localchat_draft_v1_u${me.id}_${key}`, JSON.stringify({ v: 1, text }));
      } catch {
        /* ignore */
      }
    }, 480);
    return () => clearTimeout(t);
  }, [text, active?.kind, active?.id, me.id]);

  useEffect(() => {
    const cur = active;
    const s = socketRef.current;
    if (!cur || !s?.connected) return;
    if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    if (!text.trim()) {
      s.emit('chat:typing', { chatKind: cur.kind, chatId: cur.id, active: false });
      return;
    }
    const now = Date.now();
    if (now - lastTypingEmitAtRef.current > 850) {
      lastTypingEmitAtRef.current = now;
      s.emit('chat:typing', { chatKind: cur.kind, chatId: cur.id, active: true });
    }
    typingStopTimerRef.current = setTimeout(() => {
      s.emit('chat:typing', { chatKind: cur.kind, chatId: cur.id, active: false });
      typingStopTimerRef.current = null;
    }, 2000);
    return () => {
      if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    };
  }, [text, active?.kind, active?.id]);

  useEffect(() => {
    const s = socketRef.current;
    const prev = prevTypingChatRef.current;
    prevTypingChatRef.current = active;
    if (s?.connected && prev && (!active || prev.kind !== active.kind || prev.id !== active.id)) {
      s.emit('chat:typing', { chatKind: prev.kind, chatId: prev.id, active: false });
    }
  }, [active]);

  useEffect(() => {
    setDividerAfterReadId(null);
  }, [active?.kind, active?.id]);

  useEffect(() => {
    if (!active || messages.length === 0) return;
    setDividerAfterReadId((prev) => {
      if (prev !== null) return prev;
      const pr = prefs.find((x) => x.chat_kind === active.kind && x.chat_id === active.id);
      const raw = pr?.last_read_message_id;
      const maxId = Math.max(...messages.map((m) => m.id));
      /** Без курсора в prefs `0` трактовалось как «всё непрочитано» — линия «Новые» уезжала в начало истории. */
      if (raw != null && raw > 0) return raw;
      return maxId;
    });
  }, [active, messages, prefs]);

  useLayoutEffect(() => {
    const a = active;
    if (!a) {
      chatScrollLayoutPrevRef.current = { inChatPane: false, key: '' };
      return;
    }
    const inChatPane = a.kind === 'direct' || (a.kind === 'group' && groupTab === 'chat');
    const key = `${a.kind}:${a.id}`;
    const el = messagesScrollRef.current;
    const prev = chatScrollLayoutPrevRef.current;

    if (inChatPane && el && messages.length > 0) {
      const enteredChatPane = !prev.inChatPane && inChatPane;
      const switchedChat = inChatPane && prev.inChatPane && prev.key !== key;
      if (enteredChatPane || switchedChat) {
        const saved = chatScrollPositionsRef.current[key];
        if (saved != null) {
          el.scrollTop = saved;
        }
      }
    }

    chatScrollLayoutPrevRef.current = {
      inChatPane,
      key: inChatPane ? key : prev.key,
    };
  }, [active?.kind, active?.id, groupTab, messages.length]);

  /** Пока лента смонтирована — фиксируем scrollTop (при уходе на Документы ref уже null, cleanup часто не сработает). */
  useLayoutEffect(() => {
    if (!active) return;
    const inChatPane = active.kind === 'direct' || (active.kind === 'group' && groupTab === 'chat');
    if (!inChatPane) return;
    const key = `${active.kind}:${active.id}`;
    const persist = () => {
      const el = messagesScrollRef.current;
      if (el) chatScrollPositionsRef.current[key] = el.scrollTop;
    };
    persist();
    return () => {
      persist();
    };
  }, [active?.kind, active?.id, groupTab, messages.length]);

  useEffect(() => {
    if (messageMenuOpen == null) {
      setFileAttachSubmenu(null);
      return;
    }
    const close = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (
        el.closest('.lc-msg-toolbar') ||
        el.closest('.lc-msg-forward-flyout') ||
        el.closest('.lc-msg-attach-flyout')
      )
        return;
      setMessageMenuOpen(null);
      setForwardSubmenuOpen(false);
      setFileAttachSubmenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [messageMenuOpen]);

  useLayoutEffect(() => {
    if (messageMenuOpen == null) {
      flushSync(() => setMessageMenuOpenAbove(false));
      const el = messageMenuRef.current;
      if (el) {
        el.style.maxHeight = '';
        el.style.overflowY = '';
      }
      return;
    }
    const el = messageMenuRef.current;
    if (el) {
      el.style.maxHeight = '';
      el.style.overflowY = '';
    }
    flushSync(() => setMessageMenuOpenAbove(false));
    if (!el) return;
    const r = el.getBoundingClientRect();
    const needAbove = r.bottom > window.innerHeight - MESSAGE_MENU_VIEWPORT_MARGIN;
    setMessageMenuOpenAbove(needAbove);
  }, [messageMenuOpen]);

  useLayoutEffect(() => {
    if (messageMenuOpen == null) return;
    const el = messageMenuRef.current;
    if (!el) return;
    if (!messageMenuOpenAbove) {
      el.style.maxHeight = '';
      el.style.overflowY = '';
      return;
    }
    const margin = MESSAGE_MENU_VIEWPORT_MARGIN;
    const r = el.getBoundingClientRect();
    if (r.top < margin) {
      const cap = Math.max(120, window.innerHeight - 2 * margin);
      el.style.maxHeight = `${cap}px`;
      el.style.overflowY = 'auto';
    } else {
      el.style.maxHeight = '';
      el.style.overflowY = '';
    }
  }, [messageMenuOpen, messageMenuOpenAbove]);

  useLayoutEffect(() => {
    const el = messageMenuRef.current;
    if (!el) return;
    if (messageMenuOpen == null) {
      el.style.transform = '';
      return;
    }
    const margin = MESSAGE_MENU_VIEWPORT_MARGIN;
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    // Границы — область ленты сообщений (уже, чем окно), с запасом. Иначе меню у левых
    // сообщений вылезает за пределы чата.
    const pane =
      (el.closest('.lc-messages-pane') as HTMLElement | null) ||
      (el.closest('.messages') as HTMLElement | null);
    const paneRect = pane?.getBoundingClientRect();
    const leftBound = Math.max(margin, (paneRect?.left ?? 0) + margin);
    const rightBound = Math.min(
      window.innerWidth - margin,
      (paneRect?.right ?? window.innerWidth) - margin
    );
    let shift = 0;
    if (r.left < leftBound) {
      shift = leftBound - r.left;
    } else if (r.right > rightBound) {
      shift = rightBound - r.right;
    }
    el.style.transform = shift !== 0 ? `translateX(${Math.round(shift)}px)` : '';
  }, [messageMenuOpen, messageMenuOpenAbove]);

  useEffect(() => {
    if (messageMenuOpen == null) return;
    const remeasure = () => {
      const el = messageMenuRef.current;
      if (!el) return;
      el.style.maxHeight = '';
      el.style.overflowY = '';
      el.style.transform = '';
      flushSync(() => setMessageMenuOpenAbove(false));
      const r = el.getBoundingClientRect();
      setMessageMenuOpenAbove(r.bottom > window.innerHeight - MESSAGE_MENU_VIEWPORT_MARGIN);
    };
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
  }, [messageMenuOpen]);

  // --- Ref-зеркала для сокета/таймеров (всегда актуальные groups, active, prefs…) ---

  activeRef.current = active;
  groupTabRef.current = groupTab;
  const meRef = useRef(me);
  meRef.current = me;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const directsRef = useRef(directs);
  directsRef.current = directs;
  const refreshUnreadRef = useRef(refreshUnread);
  refreshUnreadRef.current = refreshUnread;
  const refreshListsRef = useRef(refreshLists);
  refreshListsRef.current = refreshLists;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // --- Загрузка и пагинация ленты (последняя страница / контекст / «старее») ---

  const reloadActiveMessages = useCallback(async () => {
    const a = activeRef.current;
    if (!a) return;
    try {
      const curMsgs = messagesRef.current;
      const curMsgsMatchChat =
        curMsgs.length === 0 ||
        curMsgs.every((m) =>
          a.kind === 'group' ? m.groupId === a.id : m.directId === a.id
        );
      const maxId =
        curMsgsMatchChat && curMsgs.length > 0 ? curMsgs[curMsgs.length - 1]!.id : null;
      const base =
        a.kind === 'group'
          ? `/api/groups/${a.id}/messages`
          : `/api/direct/${a.id}/messages`;
      const msgs =
        maxId != null
          ? await api<Message[]>(`${base}?since=${maxId}&limit=200`)
          : await api<Message[]>(`${base}?limit=${MESSAGES_PAGE_SIZE}`);
      if (activeRef.current?.kind !== a.kind || activeRef.current?.id !== a.id) return;
      if (maxId != null && msgs.length > 0) {
        setMessages((prev) => {
          const baseMsgs = prev.every((m) =>
            a.kind === 'group' ? m.groupId === a.id : m.directId === a.id
          )
            ? prev
            : [];
          const byId = new Map(baseMsgs.map((m) => [m.id, m]));
          for (const m of msgs.map(normalizeLoadedMessage)) byId.set(m.id, m);
          return [...byId.values()].sort((x, y) => x.id - y.id);
        });
      } else if (maxId == null) {
        setMessages(msgs.map(normalizeLoadedMessage));
        setHasMoreOlderMessages(msgs.length >= MESSAGES_PAGE_SIZE);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось обновить сообщения');
    }
  }, [showToast]);

  const reloadActiveMessagesRef = useRef(reloadActiveMessages);
  reloadActiveMessagesRef.current = reloadActiveMessages;

  const loadChatAtMessageId = useCallback(
    async (messageId: number) => {
      const cur = activeRef.current;
      if (!cur) return;
      try {
        const r = await api<{ focusMessageId: number; messages: Message[] }>(
          `/api/messages/${messageId}/context?before=60&after=60`
        );
        const sample = r.messages[0];
        const ok =
          sample &&
          ((cur.kind === 'group' && sample.groupId === cur.id) ||
            (cur.kind === 'direct' && sample.directId === cur.id));
        if (!ok || !r.messages.length) {
          await reloadActiveMessages();
          return;
        }
        setMessages(r.messages.map(normalizeLoadedMessage));
        setHasMoreOlderMessages(r.messages.length >= 100);
        setPendingScrollMessageId(r.focusMessageId);
      } catch {
        await reloadActiveMessages();
      }
    },
    [reloadActiveMessages]
  );

  /** Прокрутка к сообщению в ленте; если узла нет — подгрузка контекста через API (как при «К сообщению» из треда). */
  const scrollToChatMessageOrLoad = useCallback(
    (messageId: number) => {
      const el = document.getElementById(`lc-msg-${messageId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('lc-msg-thread-jump-flash');
        window.setTimeout(() => el.classList.remove('lc-msg-thread-jump-flash'), 1200);
        return;
      }
      void loadChatAtMessageId(messageId);
    },
    [loadChatAtMessageId]
  );

  useEffect(() => {
    hasMoreOlderRef.current = hasMoreOlderMessages;
  }, [hasMoreOlderMessages]);

  const loadOlderMessages = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const a = activeRef.current;
    if (!a || !hasMoreOlderRef.current) return;
    const prevMsgs = messagesRef.current;
    if (prevMsgs.length === 0) return;
    const first = prevMsgs[0]!.id;
    loadingOlderRef.current = true;
    setLoadingOlderMessages(true);
    const el = messagesScrollRef.current;
    const prevH = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const older =
        a.kind === 'group'
          ? await api<Message[]>(
              `/api/groups/${a.id}/messages?limit=${MESSAGES_PAGE_SIZE}&before=${first}`
            )
          : await api<Message[]>(
              `/api/direct/${a.id}/messages?limit=${MESSAGES_PAGE_SIZE}&before=${first}`
            );
      if (older.length === 0) {
        setHasMoreOlderMessages(false);
        return;
      }
      const normalized = older.map(normalizeLoadedMessage);
      setMessages((prev) => {
        const existing = new Set(prev.map((m) => m.id));
        const prepend = normalized.filter((m) => !existing.has(m.id));
        return [...prepend, ...prev];
      });
      setHasMoreOlderMessages(older.length >= MESSAGES_PAGE_SIZE);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const scrollEl = messagesScrollRef.current;
          if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight - prevH + prevTop;
        });
      });
    } catch {
      showToast('Не удалось подгрузить старые сообщения');
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlderMessages(false);
    }
  }, [showToast]);

  // --- Переходы из ленты в документы/задачи (ссылки в сообщениях, хеш-пикер) ---

  const openLinkedDocumentFromChat = useCallback(
    async (docId: number) => {
      if (active?.kind !== 'group') return;
      clearCollabOpenFromTasksSession(active.id);
      setCollabOpenedFromTasks(false);
      setCollabReturnFocusTaskId(null);
      const grp = groups.find((g) => g.id === active.id);
      const isWorkspaceMod = grp && ['admin', 'moderator'].includes(grp.role);
      try {
        const meta = await api<{
          groupId: number;
          folderId: number | null;
          folderHasPassword?: boolean;
          folderName: string | null;
          folderPasswordFingerprint: string | null;
          hasPassword: boolean;
          name: string;
          passwordFingerprint: string | null;
          imageDocument?: boolean;
          previewImageUrl?: string | null;
        }>(`/api/collab-docs/${docId}/meta`);
        if (meta.groupId !== active.id) {
          showToast('Документ из другой группы');
          return;
        }
        let folderPassword = '';
        let docPassword = '';
        if (!isWorkspaceMod) {
          const needFolder = !!meta.folderHasPassword;
          const needDoc = !!meta.hasPassword;
          if (needFolder || needDoc) {
            const unlock = readCollabUnlock(active.id);
            if (
              needFolder &&
              meta.folderId != null &&
              meta.folderPasswordFingerprint
            ) {
              const fe = unlock.folders[String(meta.folderId)];
              if (fe?.fp === meta.folderPasswordFingerprint) folderPassword = fe.pw;
            }
            if (needDoc && meta.passwordFingerprint) {
              const de = unlock.docs[String(docId)];
              if (de?.fp === meta.passwordFingerprint) docPassword = de.pw;
            }

            async function tryVerify(): Promise<boolean> {
              try {
                await api(`/api/collab-docs/${docId}/verify-access`, {
                  method: 'POST',
                  json: {
                    ...(needFolder ? { folderPassword } : {}),
                    ...(needDoc ? { password: docPassword } : {}),
                  },
                });
                return true;
              } catch {
                return false;
              }
            }

            let ok = false;
            if (
              (!needFolder || folderPassword.trim()) &&
              (!needDoc || docPassword.trim())
            ) {
              ok = await tryVerify();
            }

            if (!ok) {
              if (needFolder) {
                const label = (meta.folderName && meta.folderName.trim()) || 'папки';
                folderPassword = (await uiPrompt(`Пароль папки «${label}»`, { title: 'Требуется пароль', localStorageNotice: true })) || '';
                if (!folderPassword.trim()) return;
              }
              if (needDoc) {
                docPassword = (await uiPrompt(`Пароль документа «${meta.name}»`, { title: 'Требуется пароль', localStorageNotice: true })) || '';
                if (!docPassword.trim()) return;
              }
              if (!(await tryVerify())) {
                showToast('Неверный пароль');
                return;
              }
            }

            if (needFolder && meta.folderId != null && meta.folderPasswordFingerprint) {
              rememberFolderUnlock(active.id, meta.folderId, meta.folderPasswordFingerprint, folderPassword);
            }
            if (needDoc && meta.passwordFingerprint) {
              rememberDocUnlock(active.id, docId, meta.passwordFingerprint, docPassword);
            }
          }
          setCollabJumpFromChat(
            !isWorkspaceMod && (needFolder || needDoc)
              ? {
                  docId,
                  folderId: meta.folderId ?? null,
                  docPassword,
                  folderPassword,
                  docFingerprint: meta.passwordFingerprint,
                  folderFingerprint: meta.folderPasswordFingerprint,
                }
              : null
          );
        } else {
          setCollabJumpFromChat(null);
        }
        if (meta.previewImageUrl && meta.imageDocument) {
          openSingleImageLightbox(resolveUrl(meta.previewImageUrl));
          return;
        }
        setOpenCollabDocId(docId);
        setGroupTab('collab');
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Не удалось открыть документ');
      }
    },
    [active, groups, openSingleImageLightbox, showToast]
  );

  const openLinkedTaskFromChat = useCallback(
    async (taskId: number) => {
      if (active?.kind !== 'group') return;
      const grp = groups.find((g) => g.id === active.id);
      const isWorkspaceMod = grp && ['admin', 'moderator'].includes(grp.role);
      try {
        const meta = await api<{
          taskId: number;
          boardId: number;
          groupId: number;
          boardHasPassword: boolean;
          boardPasswordFingerprint: string | null;
          boardName: string;
        }>(`/api/tasks/${taskId}/nav-meta`);
        if (meta.groupId !== active.id) {
          showToast('Задача из другой группы');
          return;
        }
        if (meta.boardHasPassword && !isWorkspaceMod) {
          let pw = getStoredTaskBoardPassword(
            active.id,
            meta.boardId,
            meta.boardPasswordFingerprint
          );
          let verified = false;
          if (pw.trim()) {
            try {
              await api(`/api/task-boards/${meta.boardId}/verify-password`, {
                method: 'POST',
                json: { password: pw },
              });
              verified = true;
            } catch {
              verified = false;
            }
          }
          if (!verified) {
            pw = (await uiPrompt(`Пароль доски «${meta.boardName}»`, { title: 'Требуется пароль', localStorageNotice: true })) || '';
            if (!pw.trim()) return;
            try {
              await api(`/api/task-boards/${meta.boardId}/verify-password`, {
                method: 'POST',
                json: { password: pw },
              });
            } catch {
              showToast('Неверный пароль');
              return;
            }
          }
          rememberTaskBoardUnlock(active.id, meta.boardId, meta.boardPasswordFingerprint, pw);
        }
        taskRevealNonceRef.current += 1;
        setTaskRevealFromChat({
          taskId: meta.taskId,
          boardId: meta.boardId,
          nonce: taskRevealNonceRef.current,
        });
        setGroupTab('tasks');
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Не удалось открыть задачу');
      }
    },
    [active, groups, showToast]
  );

  const onMessageWorkspaceLinkClick = useCallback(
    (l: MessageWorkspaceLink) => {
      if (l.kind === 'task') void openLinkedTaskFromChat(l.entityId);
      else openLinkedDocumentFromChat(l.entityId);
    },
    [openLinkedDocumentFromChat, openLinkedTaskFromChat]
  );

  // --- Прокрутка к сообщению по id; отложенный глобальный поиск; long-press по сообщению ---

  useEffect(() => {
    if (pendingScrollMessageId == null) return;
    const id = pendingScrollMessageId;
    if (!messages.some((m) => m.id === id)) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(`lc-msg-${id}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el) {
        el.classList.add('lc-msg-thread-jump-flash');
        window.setTimeout(() => el.classList.remove('lc-msg-thread-jump-flash'), 1200);
      }
      setPendingScrollMessageId(null);
    });
  }, [messages, pendingScrollMessageId]);

  useEffect(() => {
    if (!globalSearchOpen) return;
    const q = globalSearchQ.trim();
    if (q.length < 2) {
      setGlobalSearchResults([]);
      setGlobalSearchLoading(false);
      return;
    }
    setGlobalSearchLoading(true);
    // Гасим устаревшие ответы при быстром наборе: без этого «моргали» старые результаты после свежего.
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await api<{
            results: { message: Message; chatKind: 'group' | 'direct'; chatId: number; chatLabel: string }[];
          }>(`/api/search/messages?q=${encodeURIComponent(q)}&limit=35`);
          if (cancelled) return;
          setGlobalSearchResults(Array.isArray(r.results) ? r.results : []);
        } catch {
          if (cancelled) return;
          setGlobalSearchResults([]);
        } finally {
          if (!cancelled) setGlobalSearchLoading(false);
        }
      })();
    }, 360);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [globalSearchQ, globalSearchOpen]);

  const cancelMessageLongPress = useCallback(() => {
    if (longPressTimerRef.current != null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  }, []);

  const MSG_LONG_PRESS_MS = 520;
  const MSG_LONG_PRESS_MOVE_PX2 = 14 * 14;

  const onMessagePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, msgId: number) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (
        t.closest(
          'button, a, input, textarea, label, select, [role="menuitem"], [role="listbox"], .lc-msg-toolbar, .lc-msg-menu, .lc-msg-forward-flyout, .lc-msg-attach-flyout, .lc-select-forward-flyout, .lc-msg-select-cell, .lc-reaction-picker-wrap, .lc-reaction-picker, .lc-reaction-pill, audio, video, .lc-chat-attach-img--clickable'
        )
      ) {
        return;
      }
      cancelMessageLongPress();
      longPressStartRef.current = { x: e.clientX, y: e.clientY };
      const el = e.currentTarget;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        longPressStartRef.current = null;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        setSelectMode(true);
        setSelectedMessageIds((prev) => ({ ...prev, [msgId]: true }));
        if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(35);
      }, MSG_LONG_PRESS_MS);
    },
    [cancelMessageLongPress]
  );

  const onMessagePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!longPressTimerRef.current || !longPressStartRef.current) return;
      const { x, y } = longPressStartRef.current;
      const dx = e.clientX - x;
      const dy = e.clientY - y;
      if (dx * dx + dy * dy > MSG_LONG_PRESS_MOVE_PX2) {
        cancelMessageLongPress();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    },
    [cancelMessageLongPress]
  );

  const onMessagePointerEnd = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      cancelMessageLongPress();
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [cancelMessageLongPress]
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        if (active.kind === 'direct') {
          const r = await api<{ peerLastReadMessageId: number | null; peerLastReadAt: string | null }>(
            `/api/direct/${active.id}/read-status`
          );
          if (cancelled) return;
          setDirectPeerRead({
            lastReadMessageId: r.peerLastReadMessageId,
            lastReadAt: r.peerLastReadAt,
          });
        } else {
          const r = await api<
            Record<string, { lastReadMessageId: number | null; lastReadAt: string | null }>
          >(`/api/groups/${active.id}/read-status`);
          if (cancelled) return;
          const o: Record<number, MemberReadCursor> = {};
          for (const [k, v] of Object.entries(r)) {
            o[+k] = { lastReadMessageId: v.lastReadMessageId, lastReadAt: v.lastReadAt };
          }
          setGroupMemberReads(o);
        }
      } catch {
        if (cancelled) return;
        setDirectPeerRead(null);
        setGroupMemberReads({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active?.kind, active?.id]);

  // --- Socket.IO: одно соединение на вкладку, join комнат, обработчики realtime ---

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const s = io(getApiOrigin(), {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = s;
    setIoSocket(s);
    s.on('connect', () => {
      setSocketConnected(true);
      chatRoomsPrevRef.current = null;
      chatRoomsPrevRef.current = syncSocketChatRooms(
        s,
        groupsRef.current,
        directsRef.current,
        null
      );
      void reloadActiveMessagesRef.current();
      void refreshListsRef.current?.();
      void refreshUnreadRef.current?.();
    });
    s.on('disconnect', () => {
      setSocketConnected(false);
      chatRoomsPrevRef.current = null;
    });
    s.on('connect_error', () => {
      setSocketConnected(false);
    });
    s.on('message:new', (msg: Message) => {
      const previewLine = previewMessageLine(msg);
      if (msg.groupId != null) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === msg.groupId
              ? { ...g, lastMessagePreview: previewLine, lastMessageAt: msg.createdAt }
              : g
          )
        );
      } else if (msg.directId != null) {
        setDirects((prev) => {
          const idx = prev.findIndex((d) => d.id === msg.directId);
          if (idx === -1) {
            return [
              ...prev,
              {
                id: msg.directId!,
                peer: msg.sender,
                createdAt: msg.createdAt,
                lastMessagePreview: previewLine,
                lastMessageAt: msg.createdAt,
              },
            ];
          }
          return prev.map((d) =>
            d.id === msg.directId
              ? { ...d, lastMessagePreview: previewLine, lastMessageAt: msg.createdAt }
              : d
          );
        });
      }

      const cur = activeRef.current;
      const isSameGroup = cur?.kind === 'group' && msg.groupId === cur.id;
      const isSameDirect = cur?.kind === 'direct' && msg.directId === cur.id;
      const isSameChat = isSameGroup || isSameDirect;
      /** Сообщения этой группы/диалога подгружаем, пока чат выбран в сайдбаре (в т.ч. документы/задачи). */
      if (isSameChat && cur && messageBelongsToChat(msg, cur)) {
        setMessages((prev) => {
          if (prev.length > 0 && !prev.every((m) => messageBelongsToChat(m, cur))) {
            return [normalizeLoadedMessage(msg)];
          }
          return [
            ...prev.filter((x) => x.id !== msg.id),
            normalizeLoadedMessage(msg),
          ];
        });
      }
      if (msg.sender.id === meRef.current.id) return;
      /** Уведомления и счётчик «непрочитано» только если пользователь не на ленте этого чата. */
      const isViewingChatPane =
        (isSameGroup && groupTabRef.current === 'chat') || isSameDirect;
      if (!isViewingChatPane) {
        const chatKind = msg.groupId != null ? 'group' : 'direct';
        const chatId = (msg.groupId ?? msg.directId) as number;
        const muted = isChatMutedPrefs(prefsRef.current, chatKind, chatId);
        if (!muted) {
          if (msg.groupId != null) {
            setUnread((u) => ({
              ...u,
              groups: { ...u.groups, [msg.groupId!]: (u.groups[msg.groupId!] ?? 0) + 1 },
            }));
          } else if (msg.directId != null) {
            setUnread((u) => ({
              ...u,
              directs: { ...u.directs, [msg.directId!]: (u.directs[msg.directId!] ?? 0) + 1 },
            }));
          }
          const imMentioned =
            Array.isArray(msg.mentionUserIds) && msg.mentionUserIds.includes(meRef.current.id);
          /** @упоминание шлёт отдельно mention:notify (текст + ОС), здесь не дублируем */
          if (!imMentioned) {
            const g = msg.groupId != null ? groupsRef.current.find((x) => x.id === msg.groupId) : null;
            const d =
              msg.directId != null ? directsRef.current.find((x) => x.id === msg.directId) : null;
            const chatLabel = g != null ? g.name : (d?.peer.displayName ?? 'Личный чат');
            const preview = previewMessageLine(msg);
            playChatNotifySound('message');
            showToast({
              kind: 'message-card',
              chatLabel,
              senderLabel: msg.sender.displayName,
              preview,
            });
            tryOsMessageNotification({
              chatLabel,
              senderLabel: msg.sender.displayName,
              preview,
              tag: `lc-${chatKind}-${chatId}`,
            });
          }
        }
      } else {
        void refreshUnreadRef.current();
      }
    });
    s.on(
      'message:reactions',
      (p: {
        messageId: number;
        groupId?: number | null;
        directId?: number | null;
        reactions: MessageReactionGroup[];
      }) => {
        const cur = activeRef.current;
        if (
          (cur?.kind === 'group' && p.groupId === cur.id) ||
          (cur?.kind === 'direct' && p.directId === cur.id)
        ) {
          setMessages((prev) =>
            prev.map((x) => (x.id === p.messageId ? { ...x, reactions: p.reactions } : x))
          );
        }
      }
    );
    s.on('message:pinned', (msg: Message) => {
      const cur = activeRef.current;
      if (
        (cur?.kind === 'group' && msg.groupId === cur.id) ||
        (cur?.kind === 'direct' && msg.directId === cur.id)
      ) {
        setMessages((prev) => prev.map((x) => (x.id === msg.id ? msg : x)));
        setPins((prev) => {
          const rest = prev.filter((x) => x.id !== msg.id);
          return [msg, ...rest];
        });
      }
    });
    s.on('message:unpinned', ({ id }: { id: number }) => {
      setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, pinnedAt: null } : x)));
      setPins((prev) => prev.filter((x) => x.id !== id));
    });
    s.on(
      'message:deleted',
      (payload: { id: number; groupId?: number | null; directId?: number | null }) => {
        const cur = activeRef.current;
        if (
          (cur?.kind === 'group' && payload.groupId === cur.id) ||
          (cur?.kind === 'direct' && payload.directId === cur.id)
        ) {
          setMessages((prev) => prev.filter((x) => x.id !== payload.id));
          setPins((prev) => prev.filter((x) => x.id !== payload.id));
        }
      }
    );
    s.on(
      'chat:messages-cleared',
      (p: {
        chatKind: 'group' | 'direct';
        chatId: number;
        scope?: 'all' | 'sender';
        clearedSenderId?: number;
      }) => {
        const cur = activeRef.current;
        const full = p.scope !== 'sender';
        if (cur?.kind === p.chatKind && cur.id === p.chatId) {
          if (full) {
            setMessages([]);
            setPins([]);
          } else if (p.clearedSenderId != null) {
            const sid = p.clearedSenderId;
            setMessages((prev) => prev.filter((x) => x.sender.id !== sid));
            setPins((prev) => prev.filter((x) => x.sender.id !== sid));
          }
        }
        if (full) {
          if (p.chatKind === 'group') {
            setGroups((prev) =>
              prev.map((g) =>
                g.id === p.chatId ? { ...g, lastMessagePreview: null, lastMessageAt: null } : g
              )
            );
          } else {
            setDirects((prev) =>
              prev.map((d) =>
                d.id === p.chatId ? { ...d, lastMessagePreview: null, lastMessageAt: null } : d
              )
            );
          }
        } else {
          void refreshListsRef.current();
        }
        void refreshUnreadRef.current();
      }
    );
    s.on('message:updated', (msg: Message) => {
      const cur = activeRef.current;
      if (
        (cur?.kind === 'group' && msg.groupId === cur.id) ||
        (cur?.kind === 'direct' && msg.directId === cur.id)
      ) {
        setMessages((prev) =>
          prev.map((x) =>
            x.id === msg.id
              ? {
                  ...msg,
                  importantForMe: x.importantForMe,
                  reactions: msg.reactions ?? x.reactions ?? [],
                }
              : x
          )
        );
        setPins((prev) =>
          prev.map((x) =>
            x.id === msg.id
              ? {
                  ...msg,
                  importantForMe: x.importantForMe,
                  reactions: msg.reactions ?? x.reactions ?? [],
                }
              : x
          )
        );
      }
    });
    s.on('mention:notify', (payload: Message & { groupId?: number; directId?: number }) => {
      const gid = payload.groupId;
      const did = payload.directId;
      if (gid != null && isChatMutedPrefs(prefsRef.current, 'group', gid)) return;
      if (did != null && isChatMutedPrefs(prefsRef.current, 'direct', did)) return;
      const g = gid != null ? groupsRef.current.find((x) => x.id === gid) : null;
      const d = did != null ? directsRef.current.find((x) => x.id === did) : null;
      const chatLabel = g?.name ?? d?.peer.displayName ?? 'Чат';
      const preview =
        payload.body?.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Вложение';
      if (typeof navigator !== 'undefined' && document.hidden && navigator.vibrate) {
        try {
          navigator.vibrate([55, 35, 55]);
        } catch {
          /* ignore */
        }
      }
      playChatNotifySound('mention');
      showToast({
        kind: 'message-card',
        chatLabel,
        senderLabel: payload.sender.displayName,
        preview: `Упоминание · ${preview}`,
      });
      tryOsMessageNotification({
        chatLabel,
        senderLabel: payload.sender.displayName,
        preview: `Упоминание · ${preview}`,
        tag:
          gid != null
            ? `lc-mention-g-${gid}-${payload.id}`
            : `lc-mention-d-${did ?? 0}-${payload.id}`,
      });
    });
    s.on('friend:request', () => {
      showToast('Новая заявка к коллегам');
      refreshFriendState();
    });
    s.on('friend:accepted', () => {
      showToast('Ваша заявка к коллегам принята');
      refreshFriendState();
    });
    s.on('group:invite', () => {
      showToast('Приглашение в группу');
      refreshLists();
      void refreshInvites();
    });
    s.on(
      'group:settings',
      (p: {
        groupId: number;
        forwardLocked: boolean;
        invitePolicy: InvitePolicy;
      }) => {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === p.groupId
              ? {
                  ...g,
                  forwardLocked: p.forwardLocked,
                  invitePolicy: p.invitePolicy,
                }
              : g
          )
        );
      }
    );
    s.on(
      'group:yourRole',
      (p: { groupId: number; role: string; joinCode?: string | null }) => {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === p.groupId
              ? {
                  ...g,
                  role: p.role,
                  joinCode: p.role === 'admin' ? (p.joinCode ?? null) : null,
                }
              : g
          )
        );
      }
    );
    s.on('group:memberRole', (p: { groupId: number; userId: number; role: string }) => {
      const cur = activeRef.current;
      if (cur?.kind === 'group' && cur.id === p.groupId) {
        setMembers((prev) =>
          prev.map((u) => (u.id === p.userId ? { ...u, role: p.role } : u))
        );
      }
    });
    s.on('group:memberLeft', (p: { groupId: number; userId: number }) => {
      const cur = activeRef.current;
      if (cur?.kind === 'group' && cur.id === p.groupId) {
        setMembers((prev) => prev.filter((u) => u.id !== p.userId));
      }
    });
    // Меня забанили/исключили из группы: убираем группу из списка (эффект сам закроет активный чат).
    s.on('group:banned', () => {
      showToast('Вас забанили в группе');
      void refreshLists();
    });
    s.on('group:kicked', () => {
      showToast('Вас исключили из группы');
      void refreshLists();
    });
    s.on('group:deleted', (p: { groupId: number; name?: string }) => {
      const name = p.name?.trim() || 'группа';
      showToast(`Группа «${name}» удалена`);
      setActive((cur) => (cur?.kind === 'group' && cur.id === p.groupId ? null : cur));
      setModal((m) => (m === 'groupAdmin' || m === 'groupMod' || m === 'groupAudit' ? null : m));
      setMyAssignmentsOpen(false);
      setAttachmentsModalOpen(false);
      void refreshLists();
    });
    s.on('group:unbanned', () => {
      void refreshLists();
    });
    s.on(
      'group:memberJoined',
      (p: { groupId: number; member: User & { role: string; banned?: boolean } }) => {
        const cur = activeRef.current;
        if (cur?.kind === 'group' && cur.id === p.groupId) {
          setMembers((prev) =>
            prev.some((u) => u.id === p.member.id) ? prev : [...prev, p.member]
          );
        }
      }
    );
    s.on(
      'chat:read',
      (p: {
        chatKind: 'group' | 'direct';
        chatId: number;
        userId: number;
        lastReadMessageId: number;
        lastReadAt: string;
      }) => {
        const cur = activeRef.current;
        if (!cur || p.chatKind !== cur.kind || p.chatId !== cur.id) return;
        if (p.chatKind === 'direct') {
          setDirectPeerRead({
            lastReadMessageId: p.lastReadMessageId,
            lastReadAt: p.lastReadAt,
          });
        } else {
          setGroupMemberReads((prev) => ({
            ...prev,
            [p.userId]: {
              lastReadMessageId: p.lastReadMessageId,
              lastReadAt: p.lastReadAt,
            },
          }));
        }
        void reloadActiveMessages();
      }
    );
    function applyTypingSocket(userId: number, displayName: string, on: boolean) {
      const prevTimer = typingClearTimersRef.current.get(userId);
      if (prevTimer) clearTimeout(prevTimer);
      if (!on) {
        typingPeersRef.current.delete(userId);
        typingClearTimersRef.current.delete(userId);
        setTypingPeerNames([...typingPeersRef.current.values()]);
        return;
      }
      typingPeersRef.current.set(userId, displayName);
      setTypingPeerNames([...typingPeersRef.current.values()]);
      const to = setTimeout(() => {
        typingPeersRef.current.delete(userId);
        typingClearTimersRef.current.delete(userId);
        setTypingPeerNames([...typingPeersRef.current.values()]);
      }, 3200);
      typingClearTimersRef.current.set(userId, to);
    }
    s.on('chat:presence', (p: { chatKind: 'group' | 'direct'; chatId: number; onlineUserIds: number[] }) => {
      const cur = activeRef.current;
      if (!cur || p.chatKind !== cur.kind || p.chatId !== cur.id) return;
      const ids = (p.onlineUserIds || []).filter((x) => x !== meRef.current.id);
      setChatOnlineOtherIds(ids);
    });
    s.on(
      'chat:typing',
      (p: {
        chatKind: 'group' | 'direct';
        chatId: number;
        userId: number;
        displayName: string;
        active: boolean;
      }) => {
        const cur = activeRef.current;
        if (!cur || p.chatKind !== cur.kind || p.chatId !== cur.id) return;
        if (p.userId === meRef.current.id) return;
        applyTypingSocket(p.userId, p.displayName, p.active);
      }
    );
    s.on(
      'message:workspaceLinks',
      (p: {
        messageId: number;
        groupId?: number | null;
        directId?: number | null;
        workspaceLinks: MessageWorkspaceLink[];
      }) => {
        const cur = activeRef.current;
        if (!cur) return;
        const match =
          (p.groupId != null && cur.kind === 'group' && p.groupId === cur.id) ||
          (p.directId != null && cur.kind === 'direct' && p.directId === cur.id);
        if (!match) return;
        patchMessageWorkspaceLinks(p.messageId, p.workspaceLinks ?? []);
      }
    );
    return () => {
      s.disconnect();
      socketRef.current = null;
      setIoSocket(null);
    };
  }, [refreshLists, refreshFriendState, refreshInvites, showToast, reloadActiveMessages, patchMessageWorkspaceLinks]);

  useEffect(() => {
    const s = socketRef.current;
    if (!s?.connected) return;
    chatRoomsPrevRef.current = syncSocketChatRooms(s, groups, directs, chatRoomsPrevRef.current);
  }, [groups, directs]);

  useEffect(() => {
    if (!active) {
      setMessages([]);
      setPins([]);
      setMembers([]);
      setHasMoreOlderMessages(false);
      loadingOlderRef.current = false;
      setLoadingOlderMessages(false);
      return;
    }
    setMessages([]);
    setHasMoreOlderMessages(false);
    loadingOlderRef.current = false;
    setLoadingOlderMessages(false);
    // Гард от гонки при быстром переключении чатов: пины/участники для *предыдущего* чата не должны
    // затирать состояние нового active. Без этого «прилипал» список участников прошлой группы.
    let cancelled = false;
    void (async () => {
      const jumpId = openAtMessageIdRef.current;
      openAtMessageIdRef.current = null;
      if (jumpId != null) {
        await loadChatAtMessageId(jumpId);
      } else {
        await reloadActiveMessages();
      }
      if (cancelled) return;
      const pl =
        active.kind === 'group'
          ? await api<Message[]>(`/api/groups/${active.id}/pins`).catch(() => [])
          : await api<Message[]>(`/api/direct/${active.id}/pins`).catch(() => []);
      if (cancelled) return;
      setPins((Array.isArray(pl) ? pl : []).map(normalizeLoadedMessage));
      if (active.kind === 'group') {
        try {
          const mem = await api<User[]>(`/api/groups/${active.id}/members`);
          if (!cancelled) setMembers(Array.isArray(mem) ? mem : []);
        } catch {
          if (!cancelled) setMembers([]);
        }
        try {
          const pending = await api<GroupAnnouncement[]>(
            `/api/groups/${active.id}/announcements/pending`
          );
          if (!cancelled) {
            const list = Array.isArray(pending) ? pending : [];
            setPendingAnnouncements(list);
            setAnnouncementAckOpen(list.length > 0);
          }
        } catch {
          if (!cancelled) {
            setPendingAnnouncements([]);
            setAnnouncementAckOpen(false);
          }
        }
        try {
          const open = await api<GroupAnnouncement[]>(
            `/api/groups/${active.id}/announcements/my-assignments`
          );
          if (!cancelled) {
            const list = Array.isArray(open) ? open : [];
            setActiveAssignmentCount(list.length);
          }
        } catch {
          if (!cancelled) setActiveAssignmentCount(0);
        }
        void refreshAssignmentBadges();
      } else {
        setMembers([]);
        setPendingAnnouncements([]);
        setAnnouncementAckOpen(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, reloadActiveMessages, loadChatAtMessageId, refreshAssignmentBadges]);

  useEffect(() => {
    setMentionSuppressKey(null);
    setMentionPickIdx(0);
    setHashSuppressKey(null);
    setHashPickIdx(0);
    setHashPickerTab('task');
    setHashPickerSuppressAfterPick(false);
    setComposerWorkspaceLinks([]);
    setCollabJumpFromChat(null);
  }, [active?.kind, active?.id]);

  useEffect(() => {
    if (active?.kind !== 'group') {
      setPickerTasks([]);
      setPickerDocs([]);
      return;
    }
    const gid = active.id;
    let cancelled = false;
    void api<
      {
        id: number;
        title: string;
        boardId: number;
        boardName: string;
        boardHasPassword?: boolean;
      }[]
    >(`/api/groups/${gid}/tasks-for-chat-picker`)
      .then((t) => {
        if (!cancelled) setPickerTasks(Array.isArray(t) ? t : []);
      })
      .catch(() => {
        if (!cancelled) setPickerTasks([]);
      });
    void api<
      {
        id: number;
        name: string;
        docType: string;
        hasPassword?: boolean;
        previewImageUrl?: string | null;
        imageDocument?: boolean;
      }[]
    >(`/api/groups/${gid}/collab-docs-flat`)
      .then((d) => {
        if (!cancelled) setPickerDocs(Array.isArray(d) ? d : []);
      })
      .catch(() => {
        if (!cancelled) setPickerDocs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active?.kind, active?.id]);

  /** Новый документ во вкладке «Документы» — сразу в списке # без перезагрузки страницы */
  useEffect(() => {
    const s = ioSocket;
    if (!s) return;
    const onCollabTreeRefresh = (p: { groupId: number }) => {
      const cur = activeRef.current;
      if (cur?.kind !== 'group' || cur.id !== p.groupId) return;
      const gid = p.groupId;
      void api<
        {
          id: number;
          name: string;
          docType: string;
          hasPassword?: boolean;
          previewImageUrl?: string | null;
          imageDocument?: boolean;
        }[]
      >(`/api/groups/${gid}/collab-docs-flat`)
        .then((d) => setPickerDocs(Array.isArray(d) ? d : []))
        .catch(() => setPickerDocs([]));
    };
    s.on('collab:tree-refresh', onCollabTreeRefresh);
    return () => {
      s.off('collab:tree-refresh', onCollabTreeRefresh);
    };
  }, [ioSocket]);

  useEffect(() => {
    const s = ioSocket;
    if (!s) return;
    const onAnnouncementNew = (p: GroupAnnouncement) => {
      const cur = activeRef.current;
      if (cur?.kind !== 'group' || cur.id !== p.groupId) return;
      if (
        p.audience === 'selected' &&
        Array.isArray(p.recipients) &&
        !p.recipients.some((r) => r.id === me.id)
      ) {
        return;
      }
      setPendingAnnouncements((prev) => {
        if (prev.some((x) => x.id === p.id)) return prev;
        return [...prev, p];
      });
      setAnnouncementAckOpen(true);
      void refreshAssignmentBadges();
    };
    const onAnnouncementResponded = (p: { announcementId: number; groupId: number }) => {
      const cur = activeRef.current;
      if (cur?.kind !== 'group' || cur.id !== p.groupId) return;
      setAnnouncementStatsRefreshKey((k) => k + 1);
      setMyAssignmentsRefreshKey((k) => k + 1);
      void refreshAssignmentBadges();
    };
    const onAnnouncementProgress = (p: { groupId: number }) => {
      const cur = activeRef.current;
      if (cur?.kind !== 'group' || cur.id !== p.groupId) return;
      setAnnouncementStatsRefreshKey((k) => k + 1);
      setMyAssignmentsRefreshKey((k) => k + 1);
      void refreshAssignmentBadges();
    };
    const onAnnouncementDeleted = (p: { announcementId: number; groupId: number }) => {
      const cur = activeRef.current;
      if (cur?.kind !== 'group' || cur.id !== p.groupId) return;
      setPendingAnnouncements((prev) => {
        const next = prev.filter((a) => a.id !== p.announcementId);
        if (next.length === 0) setAnnouncementAckOpen(false);
        return next;
      });
      setAnnouncementStatsRefreshKey((k) => k + 1);
      setMyAssignmentsRefreshKey((k) => k + 1);
      void refreshAssignmentBadges();
      void api<GroupAnnouncement[]>(`/api/groups/${p.groupId}/announcements/my-assignments`)
        .then((rows) => setActiveAssignmentCount(Array.isArray(rows) ? rows.length : 0))
        .catch(() => setActiveAssignmentCount(0));
    };
    s.on('announcement:new', onAnnouncementNew);
    s.on('announcement:responded', onAnnouncementResponded);
    s.on('announcement:progress', onAnnouncementProgress);
    s.on('announcement:deleted', onAnnouncementDeleted);
    return () => {
      s.off('announcement:new', onAnnouncementNew);
      s.off('announcement:responded', onAnnouncementResponded);
      s.off('announcement:progress', onAnnouncementProgress);
      s.off('announcement:deleted', onAnnouncementDeleted);
    };
  }, [ioSocket, me.id, refreshAssignmentBadges]);

  useEffect(() => {
    if (!active || messages.length === 0) return;
    if (active.kind === 'group' && groupTab !== 'chat') return;
    if (!messagesBelongToChat(messages, active)) return;
    const chatKind = active.kind;
    const chatId = active.id;
    const maxId = Math.max(...messages.map((m) => m.id));
    const maxMsg = messages.find((m) => m.id === maxId);
    if (!maxMsg || !messageBelongsToChat(maxMsg, active)) return;
    const t = setTimeout(() => {
      void (async () => {
        const cur = activeRef.current;
        if (!cur || cur.kind !== chatKind || cur.id !== chatId) return;
        try {
          await api('/api/chats/read', {
            method: 'POST',
            json: { chatKind, chatId, upToMessageId: maxId },
          });
          await refreshUnread();
        } catch (e) {
          showToast(e instanceof Error ? e.message : 'Не удалось отметить прочитанным');
        }
      })();
    }, 320);
    return () => clearTimeout(t);
  }, [active, messages, groupTab, refreshUnread, showToast]);

  useEffect(() => {
    stickToBottomRef.current = true;
    belowFoldBaselineIdRef.current = 0;
    setBelowFoldNewCount(0);
    setScrollJumpVisible(false);
    messagesTailSigRef.current = { len: 0, tailId: 0 };
  }, [active?.kind, active?.id]);

  function scrollMessagesPaneToBottom(behavior: ScrollBehavior = 'smooth') {
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }

  function updateStickToBottomFromScroll() {
    const el = messagesScrollRef.current;
    if (!el) return;
    const ak = activeRef.current;
    if (ak && (ak.kind !== 'group' || groupTabRef.current === 'chat')) {
      chatScrollPositionsRef.current[`${ak.kind}:${ak.id}`] = el.scrollTop;
    }
    const thresholdPx = 100;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
    stickToBottomRef.current = near;
    const canScroll = el.scrollHeight > el.clientHeight + 32;
    setScrollJumpVisible(canScroll && !near);
    if (near && messages.length > 0) {
      belowFoldBaselineIdRef.current = Math.max(...messages.map((m) => m.id));
      setBelowFoldNewCount(0);
    }
    if (el.scrollTop < 72 && hasMoreOlderRef.current && !loadingOlderRef.current) {
      void loadOlderMessages();
    }
  }

  function scrollChatToBottom() {
    stickToBottomRef.current = true;
    setScrollJumpVisible(false);
    if (messages.length > 0) {
      belowFoldBaselineIdRef.current = Math.max(...messages.map((m) => m.id));
    }
    setBelowFoldNewCount(0);
    scrollMessagesPaneToBottom('smooth');
  }

  /** Прокрутка к самому раннему новому сообщению от других (свои не считаются «новыми» для отправителя). */
  function scrollToFirstNewMessage() {
    const baseline = belowFoldBaselineIdRef.current;
    if (!baseline || messages.length === 0) {
      scrollChatToBottom();
      return;
    }
    const news = messages.filter(
      (m) => m.id > baseline && m.sender.id !== me.id && !groupMemberChatEventKind(m)
    );
    if (news.length === 0) {
      scrollChatToBottom();
      return;
    }
    const firstNew = news.reduce((min, m) => (m.id < min.id ? m : min));
    belowFoldBaselineIdRef.current = firstNew.id;
    setBelowFoldNewCount(
      messages.filter(
        (m) => m.id > firstNew.id && m.sender.id !== me.id && !groupMemberChatEventKind(m)
      ).length
    );
    stickToBottomRef.current = false;

    const el = document.getElementById(`lc-msg-${firstNew.id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      scrollMessagesPaneToBottom('smooth');
    }
  }

  useEffect(() => {
    if (messages.length === 0) {
      belowFoldBaselineIdRef.current = 0;
      setBelowFoldNewCount(0);
      setScrollJumpVisible(false);
      messagesTailSigRef.current = { len: 0, tailId: 0 };
      return;
    }
    const maxId = Math.max(...messages.map((m) => m.id));
    const len = messages.length;
    const tailId = messages[len - 1]!.id;
    const prevSig = messagesTailSigRef.current;
    const tailChanged = prevSig.len !== len || prevSig.tailId !== tailId;
    messagesTailSigRef.current = { len, tailId };

    if (stickToBottomRef.current) {
      belowFoldBaselineIdRef.current = maxId;
      setBelowFoldNewCount(0);
      setScrollJumpVisible(false);
      if (tailChanged) {
        scrollMessagesPaneToBottom('smooth');
      }
      return;
    }
    const baseline = belowFoldBaselineIdRef.current;
    const n = baseline
      ? messages.filter(
          (m) => m.id > baseline && m.sender.id !== me.id && !groupMemberChatEventKind(m)
        ).length
      : 0;
    setBelowFoldNewCount(n);
  }, [messages, me.id]);

  // --- Производные для сайдбара: сортировка, непрочитанные, заголовок `document.title` ---

  // O(1) lookup вместо `prefs.find(...)` на каждый rankFor() (а он вызывался внутри sort/reduce
  // на каждый рендер — деградация заметна при десятках чатов).
  const prefsIndex = useMemo(() => {
    const m = new Map<string, (typeof prefs)[number]>();
    for (const p of prefs) m.set(`${p.chat_kind}:${p.chat_id}`, p);
    return m;
  }, [prefs]);
  const rankFor = useCallback(
    (kind: 'group' | 'direct', id: number) => {
      const pr = prefsIndex.get(`${kind}:${id}`);
      const pin = pr?.pinned_list ? 100 : 0;
      const fav = pr?.favorite ? 10 : 0;
      return pin + fav;
    },
    [prefsIndex]
  );

  const sortedGroups = useMemo(
    () =>
      [...groups].sort(
        (a, b) => rankFor('group', b.id) - rankFor('group', a.id) || a.name.localeCompare(b.name)
      ),
    [groups, rankFor]
  );
  const sortedDirects = useMemo(
    () => [...directs].sort((a, b) => rankFor('direct', b.id) - rankFor('direct', a.id)),
    [directs, rankFor]
  );
  const filteredDirects = useMemo(() => {
    const q = directSearchQ.trim().replace(/^@+/, '').toLowerCase();
    if (!q) return sortedDirects;
    return sortedDirects.filter(
      (d) =>
        d.peer.displayName.toLowerCase().includes(q) || d.peer.tag.toLowerCase().includes(q)
    );
  }, [sortedDirects, directSearchQ]);

  function unreadForGroup(id: number) {
    if (isChatMutedPrefs(prefs, 'group', id)) return 0;
    if (active?.kind === 'group' && active.id === id && groupTab === 'chat') return 0;
    return unread.groups[id] ?? 0;
  }
  function assignmentBadgeForGroup(id: number) {
    if (active?.kind === 'group' && active.id === id) return 0;
    return assignmentBadges[id] ?? 0;
  }
  function unreadForDirect(id: number) {
    if (isChatMutedPrefs(prefs, 'direct', id)) return 0;
    if (active?.kind === 'direct' && active.id === id) return 0;
    return unread.directs[id] ?? 0;
  }

  const totalUnread =
    Object.keys(unread.groups).reduce((sum, k) => sum + unreadForGroup(+k), 0) +
    Object.keys(unread.directs).reduce((sum, k) => sum + unreadForDirect(+k), 0);

  useEffect(() => {
    const base = 'LocalChat';
    document.title = totalUnread > 0 ? `(${totalUnread}) ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [totalUnread]);

  useEffect(() => {
    if (
      sidebarChatTab !== 'groups' &&
      sidebarChatTab !== 'directs' &&
      !customChatTabs.some((t) => t.id === sidebarChatTab)
    ) {
      setSidebarChatTab('groups');
    }
  }, [customChatTabs, sidebarChatTab]);

  /** Только при смене открытого чата подстраиваем вкладку; не трогаем сайдбар при ручном переключении «Группы / Личные». */
  useEffect(() => {
    if (!active) return;
    setSidebarChatTab((tab) => {
      const onCurrentCustom =
        tab !== 'groups' &&
        tab !== 'directs' &&
        customChatTabs.some(
          (t) =>
            t.id === tab &&
            t.entries.some((e) => e.kind === active.kind && e.id === active.id)
        );
      if (onCurrentCustom) return tab;
      return active.kind === 'group' ? 'groups' : 'directs';
    });
  }, [active?.kind, active?.id, customChatTabs]);

  const sidebarGroupsUnread = sortedGroups.reduce((s, g) => s + unreadForGroup(g.id), 0);
  const sidebarDirectsUnread = sortedDirects.reduce((s, d) => s + unreadForDirect(d.id), 0);

  function sumUnreadCustomTab(tab: CustomChatTab) {
    return tab.entries.reduce(
      (s, e) => s + (e.kind === 'group' ? unreadForGroup(e.id) : unreadForDirect(e.id)),
      0
    );
  }

  const activeCustomTab =
    sidebarChatTab !== 'groups' && sidebarChatTab !== 'directs'
      ? customChatTabs.find((t) => t.id === sidebarChatTab)
      : undefined;

  async function createCustomChatTab() {
    const name = (await uiPrompt('Название вкладки', { title: 'Новая вкладка' }))?.trim();
    if (!name) return;
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setCustomChatTabs((prev) => [...prev, { id, name, entries: [] }]);
    setSidebarChatTab(id);
  }

  async function deleteCustomChatTab(tabId: string) {
    if (
      !(await uiConfirm('Удалить эту вкладку? Чаты останутся в списках «Группы» и «Личные».', {
        title: 'Удаление вкладки',
        danger: true,
        okText: 'Удалить',
      }))
    )
      return;
    setCustomChatTabs((prev) => prev.filter((t) => t.id !== tabId));
    if (sidebarChatTab === tabId) setSidebarChatTab('groups');
  }

  async function renameCustomChatTab(tabId: string, currentName: string) {
    const name = (await uiPrompt('Новое название вкладки', { title: 'Переименование вкладки', defaultValue: currentName }))?.trim();
    if (!name) return;
    setCustomChatTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, name } : t)));
  }

  function addChatToCustomTab(tabId: string, kind: 'group' | 'direct', id: number) {
    setCustomChatTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        if (t.entries.some((e) => e.kind === kind && e.id === id)) return t;
        return { ...t, entries: [...t.entries, { kind, id }] };
      })
    );
  }

  function removeChatFromCustomTab(tabId: string, kind: 'group' | 'direct', id: number) {
    setCustomChatTabs((prev) =>
      prev.map((t) =>
        t.id !== tabId
          ? t
          : { ...t, entries: t.entries.filter((e) => !(e.kind === kind && e.id === id)) }
      )
    );
  }

  function removeChatFromAllCustomTabs(kind: 'group' | 'direct', id: number) {
    setCustomChatTabs((prev) =>
      prev.map((t) => ({
        ...t,
        entries: t.entries.filter((e) => !(e.kind === kind && e.id === id)),
      }))
    );
  }

  function onTabStripDragOver(e: DragEvent) {
    if ([...e.dataTransfer.types].includes(CHAT_TAB_DND_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }

  const selectedCount = Object.keys(selectedMessageIds).filter((k) => selectedMessageIds[+k]).length;
  const bulkForwardBlocked = messages.some(
    (m) =>
      selectedMessageIds[m.id] &&
      m.groupId != null &&
      !!groups.find((g) => g.id === m.groupId)?.forwardLocked
  );

  // --- Композер: эмодзи, отправка, редактирование; далее — пины, удаление, реакции, пересылка ---

  function insertEmoji(emoji: string) {
    const el = composerTextareaRef.current;
    if (!el) {
      setText((t) => t + emoji);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.selectionStart = el.selectionEnd = pos;
      setComposerCaret(pos);
    });
  }

  async function sendMessage() {
    if (sendInFlightRef.current) return;
    const sendChat = activeRef.current;
    if (!sendChat) return;
    if (editingMessage) {
      const editTrim = text.trim();
      const hasForwardBlock = !!(editingMessage.forwardFrom && editingMessage.forwardFrom.length > 0);
      if (!editTrim && !(editingMessage.attachments?.length ?? 0) && !hasForwardBlock) {
        showToast('Нельзя сохранить пустое сообщение');
        return;
      }
      sendInFlightRef.current = true;
      try {
        const editJson: { body: string; mentionUserIds?: number[] } = { body: text };
        const mentionIdsForEdit =
          sendChat.kind === 'group'
            ? mentionUserIdsMatchingBody(composerMentionPicks, text.trim())
            : [];
        if (mentionIdsForEdit.length > 0) {
          editJson.mentionUserIds = mentionIdsForEdit;
        }
        const updated = await api<Message>(`/api/messages/${editingMessage.id}/edit`, {
          method: 'POST',
          json: editJson,
        });
        setMessages((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
        setPins((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
        setEditingMessage(null);
        setText('');
        setComposerCaret(0);
        setComposerMentionPicks([]);
        setMentionSuppressKey(null);
        setHashSuppressKey(null);
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Не удалось сохранить');
      } finally {
        sendInFlightRef.current = false;
      }
      return;
    }
    const trimmed = text.trim();
    const filesSnapshot = [...composerDropFiles];
    const mentionPicksSnapshot = [...composerMentionPicks];
    const replySnapshot = replyingTo;
    const workspaceLinksSnapshot =
      sendChat.kind === 'group' ? [...composerWorkspaceLinks] : [];
    sendInFlightRef.current = true;
    let allFiles: File[];
    try {
      allFiles = await compressImageFilesForUpload(filesSnapshot);
    } catch (e) {
      sendInFlightRef.current = false;
      showToast(e instanceof Error ? e.message : 'Не удалось подготовить файлы');
      return;
    }
    const photoCount = allFiles.filter((f) => f.type.startsWith('image/')).length;
    if (photoCount > MAX_MESSAGE_PHOTOS) {
      sendInFlightRef.current = false;
      showToast(`Можно прикрепить не больше ${MAX_MESSAGE_PHOTOS} фотографий`);
      return;
    }
    if (!trimmed && allFiles.length === 0 && workspaceLinksSnapshot.length === 0) {
      sendInFlightRef.current = false;
      showToast('Введите текст, прикрепите файл или привяжите задачу/документ (#)');
      return;
    }
    const fd = new FormData();
    fd.append('body', trimmed);
    const mentionIdsForSend =
      sendChat.kind === 'group'
        ? mentionUserIdsMatchingBody(mentionPicksSnapshot, trimmed)
        : [];
    if (mentionIdsForSend.length > 0) {
      fd.append('mentionUserIds', JSON.stringify(mentionIdsForSend));
    }
    if (workspaceLinksSnapshot.length > 0) {
      fd.append(
        'workspaceLinks',
        JSON.stringify(
          workspaceLinksSnapshot.map((l) => ({ kind: l.kind, entityId: l.entityId }))
        )
      );
    }
    if (replySnapshot) fd.append('replyToId', String(replySnapshot.id));
    for (const f of allFiles) {
      fd.append('files', f);
    }
    const url =
      sendChat.kind === 'group'
        ? `/api/groups/${sendChat.id}/messages`
        : `/api/direct/${sendChat.id}/messages`;
    let created: Message;
    try {
      if (allFiles.length > 0) {
        const ac = new AbortController();
        messageUploadAbortRef.current = ac;
        setMessageUploadProgress(0);
        try {
          created = await apiFormWithProgress<Message>(url, fd, {
            signal: ac.signal,
            onProgress: (r) => setMessageUploadProgress(r),
          });
        } finally {
          messageUploadAbortRef.current = null;
          setMessageUploadProgress(null);
        }
      } else {
        created = await apiForm<Message>(url, fd);
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'Отменено') return;
      showToast(e instanceof Error ? e.message : 'Не удалось отправить');
      return;
    } finally {
      sendInFlightRef.current = false;
    }
    const line = previewMessageLine(created);
    if (sendChat.kind === 'group') {
      setGroups((prev) =>
        prev.map((g) =>
          g.id === sendChat.id
            ? { ...g, lastMessagePreview: line, lastMessageAt: created.createdAt }
            : g
        )
      );
    } else {
      setDirects((prev) =>
        prev.map((d) =>
          d.id === sendChat.id
            ? { ...d, lastMessagePreview: line, lastMessageAt: created.createdAt }
            : d
        )
      );
    }
    if (sendChat.kind === 'group' && workspaceLinksSnapshot.length > 0) {
      const mergedWs = normalizeLoadedMessage(created).workspaceLinks ?? [];
      if (mergedWs.length < workspaceLinksSnapshot.length) {
        let cur = mergedWs;
        for (const link of workspaceLinksSnapshot) {
          try {
            const r = await api<{ workspaceLinks: MessageWorkspaceLink[] }>(
              `/api/messages/${created.id}/workspace-links`,
              { method: 'POST', json: { kind: link.kind, entityId: link.entityId } }
            );
            cur = r.workspaceLinks ?? cur;
          } catch (e) {
            const errText = e instanceof Error ? e.message : String(e);
            if (!errText.includes('409') && !errText.includes('Связь уже') && !errText.includes('уже есть')) {
              showToast(errText || 'Не удалось привязать задачу или документ');
            }
          }
        }
        patchMessageWorkspaceLinks(created.id, cur);
      } else {
        patchMessageWorkspaceLinks(created.id, mergedWs);
      }
    }
    const stillOnSendChat =
      activeRef.current?.kind === sendChat.kind && activeRef.current?.id === sendChat.id;
    if (stillOnSendChat) {
      setText('');
      setComposerCaret(0);
      setComposerMentionPicks([]);
      setMentionSuppressKey(null);
      setHashSuppressKey(null);
      setHashPickerSuppressAfterPick(false);
      setComposerWorkspaceLinks([]);
      setReplyingTo(null);
      setEmojiOpen(false);
      setComposerDropFiles([]);
      setComposerFileInputKey((k) => k + 1);
    }
  }

  async function toggleMessagePin(m: Message) {
    if (m.pinnedAt) {
      await api<{ ok: boolean }>(`/api/messages/${m.id}/unpin`, { method: 'POST' });
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, pinnedAt: null } : x)));
      setPins((prev) => prev.filter((x) => x.id !== m.id));
    } else {
      const updated = await api<Message>(`/api/messages/${m.id}/pin`, { method: 'POST' });
      setMessages((prev) =>
        prev.map((x) =>
          x.id === m.id ? { ...updated, importantForMe: x.importantForMe } : x
        )
      );
      setPins((prev) => {
        const oldImp = prev.find((p) => p.id === m.id)?.importantForMe;
        return [{ ...updated, importantForMe: oldImp }, ...prev.filter((x) => x.id !== m.id)];
      });
    }
  }

  async function deleteMessage(m: Message) {
    if (!(await uiConfirm('Удалить это сообщение?', { title: 'Удаление сообщения', danger: true, okText: 'Удалить' }))) return;
    try {
      await api(`/api/messages/${m.id}/delete`, { method: 'POST' });
      setMessages((prev) => prev.filter((x) => x.id !== m.id));
      setPins((prev) => prev.filter((x) => x.id !== m.id));
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось удалить');
    }
  }

  const fetchMessageReaders = useCallback(async (messageId: number): Promise<MessageReader[]> => {
    try {
      const r = await api<{ kind: string; readers: MessageReader[] }>(
        `/api/messages/${messageId}/read-receipts`
      );
      return Array.isArray(r?.readers) ? r.readers : [];
    } catch {
      return [];
    }
  }, []);

  async function postMessageReaction(messageId: number, emoji: string) {
    try {
      const r = await api<{ messageId: number; reactions: MessageReactionGroup[] }>(
        `/api/messages/${messageId}/reaction`,
        { method: 'POST', json: { emoji } }
      );
      setMessages((prev) =>
        prev.map((x) => (x.id === r.messageId ? { ...x, reactions: r.reactions } : x))
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось');
    }
  }

  async function toggleMessageImportant(m: Message) {
    try {
      const r = await api<{ important: boolean }>(`/api/messages/${m.id}/important`, {
        method: 'POST',
      });
      setMessages((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, importantForMe: r.important } : x))
      );
      setPins((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, importantForMe: r.important } : x))
      );
      setMessageMenuOpen(null);
      showToast(r.important ? 'Отмечено как важное' : 'Снята метка важного');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Ошибка');
    }
  }

  function applyForwardToChat(created: Message, target: Active) {
    const normalized = normalizeLoadedMessage(created);
    const line = previewMessageLine(normalized);
    if (target.kind === 'group') {
      setGroups((prev) =>
        prev.map((g) =>
          g.id === target.id
            ? { ...g, lastMessagePreview: line, lastMessageAt: normalized.createdAt }
            : g
        )
      );
    } else {
      setDirects((prev) =>
        prev.map((d) =>
          d.id === target.id
            ? { ...d, lastMessagePreview: line, lastMessageAt: normalized.createdAt }
            : d
        )
      );
    }
    const cur = activeRef.current;
    if (
      cur &&
      cur.kind === target.kind &&
      cur.id === target.id &&
      messageBelongsToChat(normalized, cur)
    ) {
      setMessages((prev) => {
        const base = prev.every((m) => messageBelongsToChat(m, cur)) ? prev : [];
        return [
          ...base.filter((x) => x.id !== normalized.id),
          normalized,
        ];
      });
    }
  }

  function closeForwardUi() {
    setForwardFromMessage(null);
    setForwardSubmenuOpen(false);
    setSelectForwardOpen(false);
    setFileAttachSubmenu(null);
    setMessageMenuOpen(null);
  }

  async function forwardTo(messageId: number, targetKind: 'group' | 'direct', targetId: number) {
    if (forwardInFlightRef.current) return;
    const target: Active = { kind: targetKind, id: targetId };
    forwardInFlightRef.current = true;
    try {
      const created = await api<Message>(`/api/messages/${messageId}/forward`, {
        method: 'POST',
        json: { targetKind, targetId },
      });
      applyForwardToChat(created, target);
      closeForwardUi();
      showToast('Сообщение переслано');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось переслать');
    } finally {
      forwardInFlightRef.current = false;
    }
  }

  async function forwardBatchTo(targetKind: 'group' | 'direct', targetId: number) {
    if (forwardInFlightRef.current) return;
    const target: Active = { kind: targetKind, id: targetId };
    const sourceChat = activeRef.current;
    const ids = Object.keys(selectedMessageIds)
      .filter((k) => selectedMessageIds[+k])
      .map(Number)
      .sort((a, b) => a - b);
    if (!ids.length) return;
    if (sourceChat) {
      const msgMap = new Map(messagesRef.current.map((m) => [m.id, m]));
      const allFromSource = ids.every((id) => {
        const m = msgMap.get(id);
        return m && messageBelongsToChat(m, sourceChat);
      });
      if (!allFromSource) {
        showToast('Выберите сообщения только из текущего чата');
        return;
      }
    }
    forwardInFlightRef.current = true;
    try {
      const created = await api<Message>('/api/messages/forward-batch', {
        method: 'POST',
        json: { messageIds: ids, targetKind, targetId },
      });
      applyForwardToChat(created, target);
      closeForwardUi();
      setSelectMode(false);
      setSelectedMessageIds({});
      showToast(ids.length > 1 ? `Переслано сообщений: ${ids.length}` : 'Сообщение переслано');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось переслать');
    } finally {
      forwardInFlightRef.current = false;
    }
  }

  async function setPref(
    kind: 'group' | 'direct',
    id: number,
    patch: { pinned?: boolean; favorite?: boolean; muted?: boolean; hidden?: boolean }
  ) {
    await api('/api/chats/prefs', { method: 'PATCH', json: { chatKind: kind, chatId: id, ...patch } });
    await refreshLists();
  }

  async function confirmExitChat() {
    if (!exitChatModal) return;
    try {
      if (exitChatModal.kind === 'leave-group') {
        await api(`/api/groups/${exitChatModal.groupId}/leave`, { method: 'POST' });
        setActive((cur) =>
          cur?.kind === 'group' && cur.id === exitChatModal.groupId ? null : cur
        );
        showToast('Вы вышли из группы');
      } else {
        await api('/api/chats/prefs', {
          method: 'PATCH',
          json: {
            chatKind: 'direct',
            chatId: exitChatModal.directId,
            hidden: true,
            deleteMyMessages: exitDeleteMyMessages,
          },
        });
        setActive((cur) =>
          cur?.kind === 'direct' && cur.id === exitChatModal.directId ? null : cur
        );
        showToast('Чат убран из списка');
      }
      setExitChatModal(null);
      setExitDeleteMyMessages(false);
      setChatHeaderMenuOpen(false);
      await refreshLists();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Не удалось выполнить действие');
    }
  }

  const activeGroup = active?.kind === 'group' ? groups.find((g) => g.id === active.id) : null;

  /** Какой автокомплит ближе к каретке — @ или # (оба не активны одновременно). */
  const composerTrigger = useMemo(() => {
    const m = mentionQueryAtCursor(text, composerCaret);
    const h = hashQueryAtCursor(text, composerCaret);
    if (!m && !h) return null;
    if (!m) return { kind: 'hash' as const, anchor: h! };
    if (!h) return { kind: 'mention' as const, anchor: m };
    return h.start >= m.start ? { kind: 'hash', anchor: h } : { kind: 'mention', anchor: m };
  }, [text, composerCaret]);

  const mentionAnchorForPicker =
    active?.kind === 'group' && composerTrigger?.kind === 'mention' ? composerTrigger.anchor : null;
  const hashAnchorForPicker =
    active?.kind === 'group' && composerTrigger?.kind === 'hash' ? composerTrigger.anchor : null;

  const mentionCandidates = useMemo(() => {
    if (!mentionAnchorForPicker) return [];
    const q = mentionAnchorForPicker.query.toLowerCase();
    return members
      .filter((u) => !u.banned && u.id !== me.id)
      .filter((u) => {
        if (!q) return true;
        return (
          u.tag.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)
        );
      })
      .slice(0, 10);
  }, [mentionAnchorForPicker, members, me.id]);

  const mentionAllInPicker = useMemo(() => {
    if (!mentionAnchorForPicker) return false;
    return mentionAllMatchesAutocompleteQuery(mentionAnchorForPicker.query);
  }, [mentionAnchorForPicker]);

  const mentionPickerItems = useMemo((): MentionPickerItem[] => {
    const items: MentionPickerItem[] = [];
    if (mentionAllInPicker) items.push({ kind: 'all' });
    for (const u of mentionCandidates) items.push({ kind: 'user', user: u });
    return items;
  }, [mentionAllInPicker, mentionCandidates]);

  const hashTaskCandidates = useMemo(() => {
    if (!hashAnchorForPicker || hashPickerTab !== 'task') return [];
    const q = hashAnchorForPicker.query.toLowerCase().trim();
    return pickerTasks.filter(
      (t) =>
        !q || t.title.toLowerCase().includes(q) || t.boardName.toLowerCase().includes(q)
    );
  }, [hashAnchorForPicker, hashPickerTab, pickerTasks]);

  const hashDocCandidates = useMemo(() => {
    if (!hashAnchorForPicker || hashPickerTab !== 'document') return [];
    const q = hashAnchorForPicker.query.toLowerCase().trim();
    return pickerDocs.filter((d) => !q || d.name.toLowerCase().includes(q));
  }, [hashAnchorForPicker, hashPickerTab, pickerDocs]);

  const hashCandidates = hashPickerTab === 'task' ? hashTaskCandidates : hashDocCandidates;

  const mentionPickerVisible =
    active?.kind === 'group' &&
    mentionAnchorForPicker != null &&
    (mentionSuppressKey == null ||
      mentionSuppressKey !== `${mentionAnchorForPicker.start}\t${mentionAnchorForPicker.query}`) &&
    mentionPickerItems.length > 0;

  const hashPickerVisible =
    active?.kind === 'group' &&
    !editingMessage &&
    !hashPickerSuppressAfterPick &&
    hashAnchorForPicker != null &&
    (hashSuppressKey == null ||
      hashSuppressKey !== `${hashAnchorForPicker.start}\t${hashAnchorForPicker.query}`);

  useEffect(() => {
    if (mentionPickerItems.length === 0) {
      setMentionPickIdx(0);
      return;
    }
    setMentionPickIdx((i) => Math.min(i, mentionPickerItems.length - 1));
  }, [mentionPickerItems.length]);

  useEffect(() => {
    if (hashCandidates.length === 0) {
      setHashPickIdx(0);
      return;
    }
    setHashPickIdx((i) => Math.min(i, hashCandidates.length - 1));
  }, [hashCandidates.length]);

  const applyMentionAllChoice = useCallback(() => {
    const anchor = mentionQueryAtCursor(text, composerCaret);
    if (!anchor) return;
    const insert = '@all ';
    const next = text.slice(0, anchor.start) + insert + text.slice(composerCaret);
    setText(next);
    const pos = anchor.start + insert.length;
    setComposerCaret(pos);
    setMentionSuppressKey(null);
    requestAnimationFrame(() => {
      const ta = composerTextareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }, [text, composerCaret]);

  const applyMentionChoice = useCallback(
    (u: User) => {
      const anchor = mentionQueryAtCursor(text, composerCaret);
      if (!anchor) return;
      const label = (u.displayName || '').trim() || u.tag;
      const insert = `${label}, `;
      const next = text.slice(0, anchor.start) + insert + text.slice(composerCaret);
      setText(next);
      setComposerMentionPicks((prev) => [...prev, { userId: u.id, insert }]);
      const pos = anchor.start + insert.length;
      setComposerCaret(pos);
      setMentionSuppressKey(null);
      requestAnimationFrame(() => {
        const ta = composerTextareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      });
    },
    [text, composerCaret]
  );

  const applyHashChoice = useCallback(
    (kind: 'task' | 'collab_document', entityId: number, labelRaw: string) => {
      const anchor = hashQueryAtCursor(text, composerCaret);
      if (!anchor) return;
      const display =
        labelRaw
          .replace(/#/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120) || (kind === 'task' ? 'Задача' : 'Документ');
      /** Убираем фрагмент `#…запрос` из текста; привязка только в чипах и на сервере. */
      const next = text.slice(0, anchor.start) + text.slice(composerCaret);
      setText(next);
      const pos = anchor.start;
      setComposerCaret(pos);
      setHashSuppressKey(null);
      setComposerWorkspaceLinks((prev) => {
        const key = `${kind}:${entityId}`;
        if (prev.some((p) => `${p.kind}:${p.entityId}` === key)) return prev;
        return [...prev, { kind, entityId, title: display }];
      });
      setHashPickerSuppressAfterPick(true);
      requestAnimationFrame(() => {
        const ta = composerTextareaRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(pos, pos);
        }
      });
    },
    [text, composerCaret]
  );

  useEffect(() => {
    if (wsLinkPickModal) setWsLinkPickFilter('');
  }, [wsLinkPickModal]);

  const wsLinkPickTasksFiltered = useMemo(() => {
    if (!wsLinkPickModal) return [];
    const q = wsLinkPickFilter.toLowerCase().trim();
    return pickerTasks.filter(
      (t) =>
        !q || t.title.toLowerCase().includes(q) || t.boardName.toLowerCase().includes(q)
    );
  }, [wsLinkPickModal, wsLinkPickFilter, pickerTasks]);

  const wsLinkPickDocsFiltered = useMemo(() => {
    if (!wsLinkPickModal) return [];
    const q = wsLinkPickFilter.toLowerCase().trim();
    return pickerDocs.filter((d) => !q || d.name.toLowerCase().includes(q));
  }, [wsLinkPickModal, wsLinkPickFilter, pickerDocs]);

  const canMod =
    activeGroup && ['admin', 'moderator'].includes(activeGroup.role);

  function canDeleteMessage(m: Message) {
    if (!active) return false;
    if (active.kind === 'group')
      return !!canMod || m.sender.id === me.id;
    return m.sender.id === me.id;
  }

  /** Соответствует правам на POST /messages/:id/unpin */
  function canUnpinFromPinsModal() {
    if (!active) return false;
    if (active.kind === 'group') return !!canMod;
    return true;
  }

  const showPinInMenu =
    active && ((active.kind === 'group' && canMod) || active.kind === 'direct');

  const normalizedSearchQ = chatSearchQuery.trim().toLowerCase();
  const searchDateRange = useMemo(
    () => normalizeSearchDateRange(chatSearchDateFrom, chatSearchDateTo),
    [chatSearchDateFrom, chatSearchDateTo]
  );
  const showSearchFiltered =
    chatSearchOpen && (!!normalizedSearchQ || searchDateRange.active);
  const messagesForTimeline = useMemo(() => {
    let list = messages;
    if (showSearchFiltered) {
      if (searchDateRange.active) {
        list = list.filter((m) => {
          const ymd = isoToMoscowYmd(m.createdAt);
          if (searchDateRange.from && ymd < searchDateRange.from) return false;
          if (searchDateRange.to && ymd > searchDateRange.to) return false;
          return true;
        });
      }
      if (normalizedSearchQ) {
        list = list.filter((m) => (m.body ?? '').toLowerCase().includes(normalizedSearchQ));
      }
    }
    return list;
  }, [messages, showSearchFiltered, searchDateRange, normalizedSearchQ]);

  const timelineRows = useMemo(
    () => buildChatTimeline(messagesForTimeline, dividerAfterReadId, me.id),
    [messagesForTimeline, dividerAfterReadId, me.id]
  );

  const searchHits = useMemo(() => {
    if (!normalizedSearchQ) return [];
    let list = messages;
    if (searchDateRange.active) {
      list = list.filter((m) => {
        const ymd = isoToMoscowYmd(m.createdAt);
        if (searchDateRange.from && ymd < searchDateRange.from) return false;
        if (searchDateRange.to && ymd > searchDateRange.to) return false;
        return true;
      });
    }
    return list.filter((m) => (m.body ?? '').toLowerCase().includes(normalizedSearchQ));
  }, [messages, normalizedSearchQ, searchDateRange]);

  useEffect(() => {
    setChatSearchHitIdx((i) => {
      if (!searchHits.length) return 0;
      return Math.min(i, searchHits.length - 1);
    });
  }, [searchHits]);

  useEffect(() => {
    if (!chatSearchOpen || !searchHits.length) return;
    const id = searchHits[chatSearchHitIdx]?.id;
    if (id == null) return;
    const t = window.setTimeout(() => {
      scrollToChatMessageOrLoad(id);
    }, 50);
    return () => window.clearTimeout(t);
  }, [chatSearchHitIdx, searchHits, chatSearchOpen, scrollToChatMessageOrLoad]);

  useEffect(() => {
    if (!chatHeaderMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = chatHeaderMenuRef.current;
      if (el && !el.contains(e.target as Node)) setChatHeaderMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [chatHeaderMenuOpen]);

  useEffect(() => {
    setChatOnlineListOpen(false);
  }, [active?.kind, active?.id]);

  useEffect(() => {
    if (chatOnlineOtherIds.length === 0) setChatOnlineListOpen(false);
  }, [chatOnlineOtherIds.length]);

  useEffect(() => {
    if (!chatOnlineListOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = chatOnlineListRef.current;
      if (el && !el.contains(e.target as Node)) setChatOnlineListOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChatOnlineListOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [chatOnlineListOpen]);

  useEffect(() => {
    if (!attachmentsModalOpen || !active) return;
    let cancelled = false;
    (async () => {
      setAttachmentIndexLoading(true);
      try {
        const path =
          active.kind === 'group'
            ? `/api/groups/${active.id}/chat-attachments?limit=200&linkLimit=100`
            : `/api/direct/${active.id}/chat-attachments?limit=200&linkLimit=100`;
        const data = await api<{ attachments: ChatAttachmentIndexItem[]; links: ChatLinkIndexItem[] }>(path);
        if (!cancelled)
          setAttachmentIndex({
            attachments: data.attachments ?? [],
            links: data.links ?? [],
          });
      } catch {
        if (!cancelled) {
          setAttachmentIndex({ attachments: [], links: [] });
          showToast('Не удалось загрузить вложения');
        }
      } finally {
        if (!cancelled) setAttachmentIndexLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachmentsModalOpen, active?.kind, active?.id, showToast]);

  const activeDirect = active?.kind === 'direct' ? directs.find((d) => d.id === active.id) : null;

  const chatOnlineUsers = useMemo(() => {
    if (!chatOnlineOtherIds.length) return [];
    const fallbackUser = (id: number): User => ({
      id,
      username: '',
      displayName: `Участник #${id}`,
      tag: String(id),
      avatarUrl: null,
    });
    if (active?.kind === 'direct') {
      const peer = activeDirect?.peer;
      if (peer && chatOnlineOtherIds.includes(peer.id)) return [peer];
      return chatOnlineOtherIds.map(fallbackUser);
    }
    const byId = new Map(members.map((m) => [m.id, m]));
    return chatOnlineOtherIds.map((id) => byId.get(id) ?? fallbackUser(id));
  }, [chatOnlineOtherIds, members, active?.kind, activeDirect]);

  const chatMuted =
    !!active && isChatMutedPrefs(prefs, active.kind, active.id);

  const attachmentGalleryItems = useMemo(() => {
    if (!attachmentIndex || attachmentGalleryTab === 'links') return [];
    return attachmentIndex.attachments.filter((a) =>
      attachmentMatchesGalleryTab(attachmentGalleryTab, a)
    );
  }, [attachmentIndex, attachmentGalleryTab]);

  // --- Разметка: корневой layout, сайдбар, основная колонка, все модальные окна ---

  return (
    <div className="lc-app-root">
      {getToken() && ioSocket && !socketConnected ? (
        <div className="lc-socket-banner" role="status">
          Нет связи с сервером. Идёт переподключение…
        </div>
      ) : null}
      <div className={`app-shell${active ? ' lc-mobile-detail' : ' lc-mobile-list'}`}>
      <div className="app-shell-top">
      <aside className="sidebar">
        <div className="lc-sidebar-head">
        <h2>Чаты</h2>
        <div className="lc-sidebar-desktop-only">
          <div className="lc-sidebar-toolbar">
            <p className="lc-sidebar-toolbar-label">Группы</p>
            <div className="row-actions">
              <button type="button" className="primary" onClick={() => setModal('createGroup')}>
                + Группа
              </button>
              <button type="button" onClick={() => setModal('joinGroup')}>
                Войти в группу
              </button>
              <button type="button" className="lc-invites-btn" onClick={() => setModal('invites')}>
                Приглашения
                {inviteCount > 0 && (
                  <span className="lc-invites-badge" aria-label={`Новых приглашений: ${inviteCount}`}>
                    {inviteCount > 99 ? '99+' : inviteCount}
                  </span>
                )}
              </button>
            </div>
          </div>
          <div className="lc-sidebar-divider" aria-hidden>
            —
          </div>
          <div className="lc-sidebar-toolbar">
            <p className="lc-sidebar-toolbar-label">Коллеги</p>
            <div className="row-actions">
              <button type="button" className="lc-invites-btn" onClick={() => setModal('friends')}>
                Коллеги
                {friendRequestCount > 0 && (
                  <span
                    className="lc-invites-badge"
                    aria-label={`Новых заявок в коллеги: ${friendRequestCount}`}
                  >
                    {friendRequestCount > 99 ? '99+' : friendRequestCount}
                  </span>
                )}
              </button>
            </div>
          </div>
          <div className="lc-sidebar-divider" aria-hidden>
            —
          </div>
          <div className="lc-sidebar-toolbar">
            <p className="lc-sidebar-toolbar-label">Профиль</p>
            <div className="row-actions">
              <button type="button" onClick={() => setModal('profile')}>
                Профиль
              </button>
            </div>
          </div>
          <div className="lc-sidebar-divider" aria-hidden>
            —
          </div>
          <div className="lc-sidebar-toolbar">
            <p className="lc-sidebar-toolbar-label">Поиск</p>
            <div className="row-actions">
              <button
                type="button"
                onClick={() => {
                  setGlobalSearchOpen(true);
                  setGlobalSearchQ('');
                  setGlobalSearchResults([]);
                }}
              >
                Поиск по чатам
              </button>
            </div>
          </div>
          <div className="lc-sidebar-divider" aria-hidden>
            —
          </div>
        </div>
        </div>
        <div className="chat-list lc-chat-list--tabs">
          <div className="lc-chat-tabs lc-chat-tabs--scroll" role="tablist" aria-label="Тип чатов">
            <button
              type="button"
              role="tab"
              id="tab-sidebar-groups"
              aria-selected={sidebarChatTab === 'groups'}
              aria-controls="panel-sidebar-groups"
              tabIndex={sidebarChatTab === 'groups' ? 0 : -1}
              className={`lc-chat-tab${sidebarChatTab === 'groups' ? ' lc-chat-tab--active' : ''}`}
              aria-label={
                sidebarGroupsUnread > 0
                  ? `Группы, непрочитанных сообщений: ${sidebarGroupsUnread}`
                  : 'Группы'
              }
              onClick={() => setSidebarChatTab('groups')}
              onDragOver={onTabStripDragOver}
              onDrop={(e) => {
                e.preventDefault();
                const p = parseTabChatDrag(e.dataTransfer);
                if (!p) return;
                removeChatFromAllCustomTabs(p.kind, p.id);
                setSidebarChatTab('groups');
                showToast('Чат убран со своих вкладок');
              }}
            >
              <span className="lc-chat-tab-label">Группы</span>
              {sidebarGroupsUnread > 0 ? (
                <span className="lc-tab-unread" aria-hidden>
                  {sidebarGroupsUnread > 99 ? '99+' : sidebarGroupsUnread}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              id="tab-sidebar-directs"
              aria-selected={sidebarChatTab === 'directs'}
              aria-controls="panel-sidebar-directs"
              tabIndex={sidebarChatTab === 'directs' ? 0 : -1}
              className={`lc-chat-tab${sidebarChatTab === 'directs' ? ' lc-chat-tab--active' : ''}`}
              aria-label={
                sidebarDirectsUnread > 0
                  ? `Личные чаты, непрочитанных сообщений: ${sidebarDirectsUnread}`
                  : 'Личные чаты'
              }
              onClick={() => setSidebarChatTab('directs')}
              onDragOver={onTabStripDragOver}
              onDrop={(e) => {
                e.preventDefault();
                const p = parseTabChatDrag(e.dataTransfer);
                if (!p) return;
                removeChatFromAllCustomTabs(p.kind, p.id);
                setSidebarChatTab('directs');
                showToast('Чат убран со своих вкладок');
              }}
            >
              <span className="lc-chat-tab-label">Личные</span>
              {sidebarDirectsUnread > 0 ? (
                <span className="lc-tab-unread" aria-hidden>
                  {sidebarDirectsUnread > 99 ? '99+' : sidebarDirectsUnread}
                </span>
              ) : null}
            </button>
            {customChatTabs.map((t) => {
              const nu = sumUnreadCustomTab(t);
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`tab-sidebar-custom-${t.id}`}
                  aria-selected={sidebarChatTab === t.id}
                  aria-controls={`panel-sidebar-custom-${t.id}`}
                  tabIndex={sidebarChatTab === t.id ? 0 : -1}
                  className={`lc-chat-tab lc-chat-tab--custom${sidebarChatTab === t.id ? ' lc-chat-tab--active' : ''}`}
                  title={t.name}
                  aria-label={nu > 0 ? `${t.name}, непрочитанных: ${nu}` : t.name}
                  onClick={() => setSidebarChatTab(t.id)}
                  onDragOver={onTabStripDragOver}
                  onDrop={(e) => {
                    e.preventDefault();
                    const p = parseTabChatDrag(e.dataTransfer);
                    if (!p) return;
                    if (p.fromTabId === t.id) return;
                    if (p.fromTabId) removeChatFromCustomTab(p.fromTabId, p.kind, p.id);
                    addChatToCustomTab(t.id, p.kind, p.id);
                    setSidebarChatTab(t.id);
                    showToast(`Чат в «${t.name}»`);
                  }}
                >
                  <span className="lc-chat-tab-label lc-chat-tab-label--ellipsis">{t.name}</span>
                  {nu > 0 ? (
                    <span className="lc-tab-unread" aria-hidden>
                      {nu > 99 ? '99+' : nu}
                    </span>
                  ) : null}
                </button>
              );
            })}
            <button
              type="button"
              className="lc-chat-tab lc-chat-tab--add"
              title="Своя вкладка — объединить выбранные чаты"
              aria-label="Добавить свою вкладку"
              onClick={createCustomChatTab}
            >
              +
            </button>
          </div>
          {activeCustomTab ? (
            <div className="lc-custom-tab-toolbar">
              <button type="button" className="lc-custom-tab-toolbar-btn" onClick={() => renameCustomChatTab(activeCustomTab.id, activeCustomTab.name)}>
                Переименовать
              </button>
              <button type="button" className="lc-custom-tab-toolbar-btn danger" onClick={() => deleteCustomChatTab(activeCustomTab.id)}>
                Удалить вкладку
              </button>
            </div>
          ) : null}
          {sidebarChatTab === 'groups' ? (
            <div
              id="panel-sidebar-groups"
              role="tabpanel"
              aria-labelledby="tab-sidebar-groups"
              className="lc-chat-tab-panel"
            >
              {sortedGroups.length === 0 ? (
                <p className="lc-chat-section-empty">Вы ещё не в группах — создайте или вступите по коду.</p>
              ) : (
                sortedGroups.map((g) => (
                  <div key={`g-${g.id}`} style={{ display: 'flex', gap: 4, alignItems: 'stretch', minWidth: 0 }}>
                    <button
                      type="button"
                      className={`chat-item ${active?.kind === 'group' && active.id === g.id ? 'active' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => setActive({ kind: 'group', id: g.id })}
                    >
                      <div className="lc-chat-sidebar-row">
                        <div className="lc-chat-sidebar-row-main">
                          <div className="lc-chat-sidebar-name-row">
                            <span className="lc-chat-sidebar-name">
                              {g.name}
                              <span className="pill">{groupRoleLabel(g.role)}</span>
                              {g.hasPassword ? (
                                <span className="lc-chat-lock" title="Группа с паролем" aria-hidden>
                                  {' '}
                                  🔒
                                </span>
                              ) : null}
                            </span>
                          </div>
                          <div className="lc-chat-sidebar-preview" title={g.lastMessagePreview ?? undefined}>
                            {g.lastMessagePreview ?? 'Нет сообщений'}
                          </div>
                        </div>
                        {unreadForGroup(g.id) > 0 ? (
                          <span
                            className="lc-sidebar-unread-badge"
                            aria-label={`Непрочитано: ${unreadForGroup(g.id)}`}
                          >
                            {unreadForGroup(g.id) > 99 ? '99+' : unreadForGroup(g.id)}
                          </span>
                        ) : assignmentBadgeForGroup(g.id) > 0 ? (
                          <span
                            className="lc-sidebar-assignment-badge"
                            aria-label={`Назначения: ${assignmentBadgeForGroup(g.id)}`}
                            title="Есть уведомления или назначения"
                          >
                            {assignmentBadgeForGroup(g.id) > 99 ? '99+' : assignmentBadgeForGroup(g.id)}
                          </span>
                        ) : null}
                      </div>
                    </button>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span
                        className="lc-chat-tab-dnd-handle"
                        draggable
                        title="Перетащите на вкладку сверху"
                        aria-label="Перетащить на другую вкладку"
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            CHAT_TAB_DND_MIME,
                            JSON.stringify({ kind: 'group', id: g.id })
                          );
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                      >
                        ⠿
                      </span>
                      <button
                        type="button"
                        title="Закрепить"
                        onClick={() =>
                          setPref('group', g.id, {
                            pinned: !prefs.find((p) => p.chat_kind === 'group' && p.chat_id === g.id)?.pinned_list,
                          })
                        }
                      >
                        📌
                      </button>
                      <ChatFavStarButton
                        favorited={!!prefs.find((p) => p.chat_kind === 'group' && p.chat_id === g.id)?.favorite}
                        onClick={() =>
                          setPref('group', g.id, {
                            favorite: !prefs.find((p) => p.chat_kind === 'group' && p.chat_id === g.id)?.favorite,
                          })
                        }
                      />
                      {customChatTabs.length > 0 ? (
                        <button
                          type="button"
                          title="Добавить или перенести во вкладку"
                          onClick={() => setChatPickForCustomTab({ kind: 'group', id: g.id })}
                        >
                          📑
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : sidebarChatTab === 'directs' ? (
            <div
              id="panel-sidebar-directs"
              role="tabpanel"
              aria-labelledby="tab-sidebar-directs"
              className="lc-chat-tab-panel"
            >
              <label className="lc-chat-sidebar-search" style={{ display: 'block', marginBottom: 8 }}>
                <span className="sr-only">Поиск личных чатов</span>
                <input
                  type="search"
                  value={directSearchQ}
                  onChange={(e) => setDirectSearchQ(e.target.value)}
                  placeholder="Имя или @тег…"
                  aria-label="Поиск личных чатов по имени или тегу"
                />
              </label>
              {sortedDirects.length === 0 ? (
                <p className="lc-chat-section-empty">
                  Нет переписок — откройте профиль коллеги из списка «Коллеги».
                </p>
              ) : filteredDirects.length === 0 ? (
                <p className="lc-chat-section-empty">Ничего не найдено.</p>
              ) : (
                filteredDirects.map((d) => (
                  <div key={`d-${d.id}`} style={{ display: 'flex', gap: 4, minWidth: 0 }}>
                    <button
                      type="button"
                      className={`chat-item ${active?.kind === 'direct' && active.id === d.id ? 'active' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => setActive({ kind: 'direct', id: d.id })}
                    >
                      <div className="lc-chat-sidebar-row">
                        <div className="lc-chat-sidebar-row-main">
                          <div className="lc-chat-sidebar-name-row">
                            <span className="lc-chat-sidebar-name">{d.peer.displayName}</span>
                          </div>
                          <div
                            className="lc-chat-sidebar-preview"
                            title={d.lastMessagePreview ?? `@${d.peer.tag}`}
                          >
                            {d.lastMessagePreview ?? `@${d.peer.tag}`}
                          </div>
                        </div>
                        {unreadForDirect(d.id) > 0 ? (
                          <span
                            className="lc-sidebar-unread-badge"
                            aria-label={`Непрочитано: ${unreadForDirect(d.id)}`}
                          >
                            {unreadForDirect(d.id) > 99 ? '99+' : unreadForDirect(d.id)}
                          </span>
                        ) : null}
                      </div>
                    </button>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span
                        className="lc-chat-tab-dnd-handle"
                        draggable
                        title="Перетащите на вкладку сверху"
                        aria-label="Перетащить на другую вкладку"
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            CHAT_TAB_DND_MIME,
                            JSON.stringify({ kind: 'direct', id: d.id })
                          );
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                      >
                        ⠿
                      </span>
                      <button
                        type="button"
                        title="Закрепить"
                        onClick={() =>
                          setPref('direct', d.id, {
                            pinned: !prefs.find((p) => p.chat_kind === 'direct' && p.chat_id === d.id)?.pinned_list,
                          })
                        }
                      >
                        📌
                      </button>
                      <ChatFavStarButton
                        favorited={!!prefs.find((p) => p.chat_kind === 'direct' && p.chat_id === d.id)?.favorite}
                        onClick={() =>
                          setPref('direct', d.id, {
                            favorite: !prefs.find((p) => p.chat_kind === 'direct' && p.chat_id === d.id)?.favorite,
                          })
                        }
                      />
                      {customChatTabs.length > 0 ? (
                        <button
                          type="button"
                          title="Добавить или перенести во вкладку"
                          onClick={() => setChatPickForCustomTab({ kind: 'direct', id: d.id })}
                        >
                          📑
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : activeCustomTab ? (
            <div
              id={`panel-sidebar-custom-${activeCustomTab.id}`}
              role="tabpanel"
              aria-labelledby={`tab-sidebar-custom-${activeCustomTab.id}`}
              className="lc-chat-tab-panel"
            >
              {activeCustomTab.entries.length === 0 ? (
                <p className="lc-chat-section-empty">
                  Вкладка пустая. Откройте «Группы» или «Личные» и нажмите 📑 у чата, чтобы добавить его сюда.
                </p>
              ) : (
                activeCustomTab.entries.map((e) => {
                  if (e.kind === 'group') {
                    const g = groups.find((x) => x.id === e.id);
                    if (!g) return null;
                    return (
                      <div key={`cg-${e.id}`} style={{ display: 'flex', gap: 4, alignItems: 'stretch', minWidth: 0 }}>
                        <button
                          type="button"
                          className={`chat-item ${active?.kind === 'group' && active.id === g.id ? 'active' : ''}`}
                          style={{ flex: 1 }}
                          onClick={() => setActive({ kind: 'group', id: g.id })}
                        >
                          <div className="lc-chat-sidebar-row">
                            <div className="lc-chat-sidebar-row-main">
                              <div className="lc-chat-sidebar-name-row">
                                <span className="lc-chat-sidebar-name">
                                  {g.name}
                                  <span className="pill">{groupRoleLabel(g.role)}</span>
                                  {g.hasPassword ? (
                                    <span className="lc-chat-lock" title="Группа с паролем" aria-hidden>
                                      {' '}
                                      🔒
                                    </span>
                                  ) : null}
                                </span>
                              </div>
                              <div className="lc-chat-sidebar-preview" title={g.lastMessagePreview ?? undefined}>
                                {g.lastMessagePreview ?? 'Нет сообщений'}
                              </div>
                            </div>
                            {unreadForGroup(g.id) > 0 ? (
                              <span
                                className="lc-sidebar-unread-badge"
                                aria-label={`Непрочитано: ${unreadForGroup(g.id)}`}
                              >
                                {unreadForGroup(g.id) > 99 ? '99+' : unreadForGroup(g.id)}
                              </span>
                            ) : assignmentBadgeForGroup(g.id) > 0 ? (
                              <span
                                className="lc-sidebar-assignment-badge"
                                aria-label={`Назначения: ${assignmentBadgeForGroup(g.id)}`}
                                title="Есть уведомления или назначения"
                              >
                                {assignmentBadgeForGroup(g.id) > 99 ? '99+' : assignmentBadgeForGroup(g.id)}
                              </span>
                            ) : null}
                          </div>
                        </button>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span
                            className="lc-chat-tab-dnd-handle"
                            draggable
                            title="Перетащите на вкладку сверху"
                            aria-label="Перетащить на другую вкладку"
                            onDragStart={(ev) => {
                              ev.dataTransfer.setData(
                                CHAT_TAB_DND_MIME,
                                JSON.stringify({
                                  kind: 'group',
                                  id: g.id,
                                  fromTabId: activeCustomTab.id,
                                })
                              );
                              ev.dataTransfer.effectAllowed = 'move';
                            }}
                          >
                            ⠿
                          </span>
                          <button
                            type="button"
                            title="Переместить в другую вкладку"
                            onClick={() =>
                              setChatPickForCustomTab({
                                kind: 'group',
                                id: g.id,
                                moveFromTabId: activeCustomTab.id,
                              })
                            }
                          >
                            📑
                          </button>
                          <button
                            type="button"
                            title="Убрать с вкладки"
                            onClick={() => removeChatFromCustomTab(activeCustomTab.id, 'group', g.id)}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  }
                  const d = directs.find((x) => x.id === e.id);
                  if (!d) return null;
                  return (
                    <div key={`cd-${e.id}`} style={{ display: 'flex', gap: 4, minWidth: 0 }}>
                      <button
                        type="button"
                        className={`chat-item ${active?.kind === 'direct' && active.id === d.id ? 'active' : ''}`}
                        style={{ flex: 1 }}
                        onClick={() => setActive({ kind: 'direct', id: d.id })}
                      >
                        <div className="lc-chat-sidebar-row">
                          <div className="lc-chat-sidebar-row-main">
                            <div className="lc-chat-sidebar-name-row">
                              <span className="lc-chat-sidebar-name">{d.peer.displayName}</span>
                            </div>
                            <div
                              className="lc-chat-sidebar-preview"
                              title={d.lastMessagePreview ?? `@${d.peer.tag}`}
                            >
                              {d.lastMessagePreview ?? `@${d.peer.tag}`}
                            </div>
                          </div>
                          {unreadForDirect(d.id) > 0 ? (
                            <span
                              className="lc-sidebar-unread-badge"
                              aria-label={`Непрочитано: ${unreadForDirect(d.id)}`}
                            >
                              {unreadForDirect(d.id) > 99 ? '99+' : unreadForDirect(d.id)}
                            </span>
                          ) : null}
                        </div>
                      </button>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span
                          className="lc-chat-tab-dnd-handle"
                          draggable
                          title="Перетащите на вкладку сверху"
                          aria-label="Перетащить на другую вкладку"
                          onDragStart={(ev) => {
                            ev.dataTransfer.setData(
                              CHAT_TAB_DND_MIME,
                              JSON.stringify({
                                kind: 'direct',
                                id: d.id,
                                fromTabId: activeCustomTab.id,
                              })
                            );
                            ev.dataTransfer.effectAllowed = 'move';
                          }}
                        >
                          ⠿
                        </span>
                        <button
                          type="button"
                          title="Переместить в другую вкладку"
                          onClick={() =>
                            setChatPickForCustomTab({
                              kind: 'direct',
                              id: d.id,
                              moveFromTabId: activeCustomTab.id,
                            })
                          }
                        >
                          📑
                        </button>
                        <button
                          type="button"
                          title="Убрать с вкладки"
                          onClick={() => removeChatFromCustomTab(activeCustomTab.id, 'direct', d.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}
        </div>
        <div className="sidebar-footer">
          <div>
            <strong>{me.displayName}</strong> · @{me.tag}
            <div className="meta">Поделитесь тегом <strong>@{me.tag}</strong> — по нему вас добавят в коллеги и пригласят в группы</div>
          </div>
          <button type="button" onClick={onLogout}>
            Выйти
          </button>
        </div>
      </aside>

      {/* --- Центральная колонка: шапка; группа — вкладки чат / документы / задачи или лента; direct — мессенджер --- */}

      <main className="main">
        {!active && <div className="main-header">Выберите чат</div>}
        {active && (
          <>
            {active.kind === 'group' && groupTab !== 'chat' ? (
              <div className="main-header lc-main-header-with-back lc-main-header-workspace">
                <button
                  type="button"
                  className="lc-exit-chat"
                  title="Выйти из чата в список"
                  aria-label="Выйти из чата"
                  onClick={() => setActive(null)}
                >
                  ←
                </button>
                <div className="lc-main-header-inner">
                  <strong>{groups.find((g) => g.id === active.id)?.name || 'Группа'}</strong>
                  <button type="button" style={{ marginLeft: 8 }} onClick={() => setModal('pins')}>
                    Закреплённые ({pins.length})
                  </button>
                  {activeGroup?.role === 'admin' && (
                    <>
                      <button type="button" style={{ marginLeft: 8 }} onClick={() => setModal('groupAdmin')}>
                        Управление
                      </button>
                      <button type="button" style={{ marginLeft: 8 }} onClick={() => setModal('groupAudit')}>
                        Журнал
                      </button>
                    </>
                  )}
                  {activeGroup && (
                    <button type="button" style={{ marginLeft: 8 }} onClick={() => setModal('groupMod')}>
                      Участники
                    </button>
                  )}
                  {activeGroup &&
                    canUseInviteInGroupMod(activeGroup.role, activeGroup.invitePolicy || 'all') && (
                    <button type="button" style={{ marginLeft: 8 }} onClick={() => setModal('groupInviteMember')}>
                      Пригласить
                    </button>
                  )}
                  {activeGroup && (
                    <button
                      type="button"
                      className="lc-announcements-nav-btn"
                      style={{ marginLeft: 8 }}
                      onClick={() => {
                        setModal('groupAnnouncements');
                        if (canMod) void markModAssignmentsSeen(active.id);
                      }}
                    >
                      {canMod ? 'Уведомления' : 'История уведомлений'}
                      {canMod && (modUnreadProgress[active.id] ?? 0) > 0 && (
                        <span
                          className="lc-announcements-mod-badge"
                          aria-label={`Обновлений хода работы: ${modUnreadProgress[active.id]}`}
                        >
                          {(modUnreadProgress[active.id] ?? 0) > 99
                            ? '99+'
                            : modUnreadProgress[active.id]}
                        </span>
                      )}
                    </button>
                  )}
                  {activeGroup && (
                    <span style={{ marginLeft: 8 }}>
                      <MyAssignmentsBadgeButton
                        count={pendingAnnouncements.length + activeAssignmentCount}
                        onClick={() => setMyAssignmentsOpen(true)}
                      />
                    </span>
                  )}
                  <div className="lc-group-tabs">
                    <button
                      type="button"
                      onClick={() => {
                        clearCollabOpenFromTasksSession(active.id);
                        setGroupTab('chat');
                      }}
                    >
                      Чат
                    </button>
                    <button
                      type="button"
                      className={groupTab === 'collab' ? 'primary' : ''}
                      onClick={() => {
                        setCollabOpenedFromTasks(false);
                        setCollabReturnFocusTaskId(null);
                        clearCollabOpenFromTasksSession(active.id);
                        setGroupTab('collab');
                      }}
                    >
                      Документы
                    </button>
                    <button
                      type="button"
                      className={groupTab === 'tasks' ? 'primary' : ''}
                      onClick={() => {
                        clearCollabOpenFromTasksSession(active.id);
                        setGroupTab('tasks');
                      }}
                    >
                      Задачи
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="main-header lc-chat-messenger-header">
                  <button
                    type="button"
                    className="lc-exit-chat"
                    title="Выйти из чата в список"
                    aria-label="Выйти из чата"
                    onClick={() => setActive(null)}
                  >
                    ✕
                  </button>
                  <div className="lc-chat-messenger-avatar" aria-hidden>
                    {active.kind === 'direct' && activeDirect?.peer.avatarUrl ? (
                      <img src={resolveUrl(activeDirect.peer.avatarUrl)} alt="" />
                    ) : (
                      <span className="lc-chat-messenger-avatar-fallback">
                        {(
                          active.kind === 'direct'
                            ? activeDirect?.peer.displayName
                            : groups.find((g) => g.id === active.id)?.name
                        )
                          ?.slice(0, 1)
                          .toUpperCase() ?? '?'}
                      </span>
                    )}
                  </div>
                  <div className="lc-chat-messenger-meta">
                    <div className="lc-chat-messenger-title">
                      {active.kind === 'direct'
                        ? activeDirect?.peer.displayName ?? 'Личный чат'
                        : groups.find((g) => g.id === active.id)?.name ?? 'Группа'}
                    </div>
                    <div className="lc-chat-messenger-sub">
                      {active.kind === 'direct'
                        ? activeDirect
                          ? `@${activeDirect.peer.tag}`
                          : 'Личный чат'
                        : 'Групповой чат'}
                    </div>
                    {(chatOnlineOtherIds.length > 0 || typingPeerNames.length > 0) && (
                      <div className="lc-chat-messenger-presence">
                        {chatOnlineOtherIds.length > 0 && (
                          <span className="lc-chat-online-presence-wrap" ref={chatOnlineListRef}>
                            <button
                              type="button"
                              className="lc-chat-online-presence-btn"
                              aria-expanded={chatOnlineListOpen}
                              aria-haspopup="listbox"
                              title="Показать, кто в сети"
                              onClick={() => setChatOnlineListOpen((o) => !o)}
                            >
                              В сети: {chatOnlineOtherIds.length}
                            </button>
                            {chatOnlineListOpen && (
                              <ul className="lc-chat-online-list" role="listbox" aria-label="В сети">
                                {chatOnlineUsers.map((u) => (
                                  <li key={u.id} className="lc-chat-online-list-item" role="option">
                                    <span className="lc-chat-online-list-avatar" aria-hidden>
                                      {u.avatarUrl ? (
                                        <img src={resolveUrl(u.avatarUrl)} alt="" />
                                      ) : (
                                        <span className="lc-chat-online-list-avatar-fallback">
                                          {(u.displayName || u.tag).slice(0, 1).toUpperCase()}
                                        </span>
                                      )}
                                    </span>
                                    <span className="lc-chat-online-list-name">
                                      {(u.displayName || '').trim() || u.tag}
                                      <span className="lc-chat-online-list-tag"> @{u.tag}</span>
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </span>
                        )}
                        {typingPeerNames.length > 0 && (
                          <span>
                            {chatOnlineOtherIds.length > 0 ? ' · ' : ''}
                            {typingPeerNames.join(', ')} — печатает…
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="lc-chat-messenger-actions">
                    <button
                      type="button"
                      className={`lc-icon-btn lc-icon-btn--ghost${chatSearchOpen ? ' lc-icon-btn--active' : ''}`}
                      title="Поиск в чате"
                      aria-label="Поиск в чате"
                      aria-pressed={chatSearchOpen}
                      onClick={() => {
                        setChatSearchOpen((o) => {
                          if (o) {
                            setChatSearchQuery('');
                            setChatSearchDateFrom('');
                            setChatSearchDateTo('');
                          }
                          return !o;
                        });
                      }}
                    >
                      <IconHeaderSearch />
                    </button>
                    <div className="lc-chat-header-more-wrap" ref={chatHeaderMenuRef}>
                      <button
                        type="button"
                        className="lc-icon-btn lc-icon-btn--ghost"
                        aria-label="Меню чата"
                        aria-expanded={chatHeaderMenuOpen}
                        onClick={() => setChatHeaderMenuOpen((o) => !o)}
                      >
                        ⋯
                      </button>
                      {chatHeaderMenuOpen && (
                        <ul className="lc-chat-header-menu" role="menu">
                          <li>
                            <button
                              type="button"
                              role="menuitem"
                              className="lc-chat-header-menu-item"
                              onClick={() => {
                                setChatHeaderMenuOpen(false);
                                setModal('pins');
                              }}
                            >
                              Закреплённые ({pins.length})
                            </button>
                          </li>
                          {active.kind === 'group' && activeGroup ? (
                            <li>
                              <button
                                type="button"
                                role="menuitem"
                                className="lc-chat-header-menu-item lc-chat-header-menu-item--mobile-only"
                                onClick={() => {
                                  setChatHeaderMenuOpen(false);
                                  setModal('groupMod');
                                }}
                              >
                                Участники
                              </button>
                            </li>
                          ) : null}
                          {active.kind === 'group' &&
                          activeGroup &&
                          canUseInviteInGroupMod(activeGroup.role, activeGroup.invitePolicy || 'all') ? (
                            <li>
                              <button
                                type="button"
                                role="menuitem"
                                className="lc-chat-header-menu-item lc-chat-header-menu-item--mobile-only"
                                onClick={() => {
                                  setChatHeaderMenuOpen(false);
                                  setModal('groupInviteMember');
                                }}
                              >
                                Пригласить
                              </button>
                            </li>
                          ) : null}
                          {active.kind === 'group' && activeGroup?.role === 'admin' ? (
                            <>
                              <li>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="lc-chat-header-menu-item lc-chat-header-menu-item--mobile-only"
                                  onClick={() => {
                                    setChatHeaderMenuOpen(false);
                                    setModal('groupAdmin');
                                  }}
                                >
                                  Управление группой
                                </button>
                              </li>
                              <li>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="lc-chat-header-menu-item lc-chat-header-menu-item--mobile-only"
                                  onClick={() => {
                                    setChatHeaderMenuOpen(false);
                                    setModal('groupAudit');
                                  }}
                                >
                                  Журнал
                                </button>
                              </li>
                            </>
                          ) : null}
                          <li>
                            <button
                              type="button"
                              role="menuitem"
                              className="lc-chat-header-menu-item"
                              onClick={() => {
                                setChatHeaderMenuOpen(false);
                                void (async () => {
                                  const willUnmute = chatMuted;
                                  await setPref(active.kind, active.id, { muted: !chatMuted });
                                  if (
                                    willUnmute &&
                                    typeof Notification !== 'undefined' &&
                                    Notification.permission === 'default'
                                  ) {
                                    const r = await Notification.requestPermission();
                                    if (r === 'granted') {
                                      showToast('Уведомления на компьютере разрешены');
                                    }
                                  }
                                })();
                              }}
                            >
                              {chatMuted ? 'Включить уведомления' : 'Отключить уведомления'}
                            </button>
                          </li>
                          <li>
                            <button
                              type="button"
                              role="menuitem"
                              className="lc-chat-header-menu-item"
                              onClick={() => {
                                setChatHeaderMenuOpen(false);
                                setAttachmentGalleryTab('photos');
                                setAttachmentsModalOpen(true);
                              }}
                            >
                              Показать вложения
                            </button>
                          </li>
                          {active.kind === 'group' && !activeGroup?.isCreator && (
                            <li>
                              <button
                                type="button"
                                role="menuitem"
                                className="lc-chat-header-menu-item danger"
                                onClick={() => {
                                  setExitDeleteMyMessages(false);
                                  setExitChatModal({
                                    kind: 'leave-group',
                                    groupId: active.id,
                                    groupName:
                                      groups.find((g) => g.id === active.id)?.name ?? 'группа',
                                  });
                                }}
                              >
                                Покинуть группу…
                              </button>
                            </li>
                          )}
                          {active.kind === 'direct' && (
                            <li>
                              <button
                                type="button"
                                role="menuitem"
                                className="lc-chat-header-menu-item danger"
                                onClick={() => {
                                  setExitDeleteMyMessages(false);
                                  setExitChatModal({
                                    kind: 'hide-direct',
                                    directId: active.id,
                                    peerName:
                                      directs.find((d) => d.id === active.id)?.peer.displayName ??
                                      'собеседник',
                                  });
                                }}
                              >
                                Удалить чат из списка…
                              </button>
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
                {chatSearchOpen && (
                  <div className="lc-chat-search-bar" role="search">
                    <input
                      type="search"
                      className="lc-chat-search-input"
                      placeholder="Поиск по тексту сообщений…"
                      value={chatSearchQuery}
                      onChange={(e) => {
                        setChatSearchQuery(e.target.value);
                        setChatSearchHitIdx(0);
                      }}
                      autoFocus
                    />
                    <label className="lc-chat-search-dates">
                      <span className="lc-chat-search-dates-label">С</span>
                      <input
                        type="date"
                        className="lc-chat-search-date"
                        value={chatSearchDateFrom}
                        onChange={(e) => {
                          setChatSearchDateFrom(e.target.value);
                          setChatSearchHitIdx(0);
                        }}
                      />
                      <span className="lc-chat-search-dates-label">по</span>
                      <input
                        type="date"
                        className="lc-chat-search-date"
                        value={chatSearchDateTo}
                        onChange={(e) => {
                          setChatSearchDateTo(e.target.value);
                          setChatSearchHitIdx(0);
                        }}
                      />
                    </label>
                    <span className="lc-chat-search-meta">
                      {searchDateRange.active || normalizedSearchQ ? (
                        <>
                          {searchDateRange.active ? (
                            <span>
                              {searchDateRange.from ?? '…'} — {searchDateRange.to ?? '…'}
                            </span>
                          ) : null}
                          {normalizedSearchQ
                            ? searchHits.length
                              ? ` · ${searchHits.length} совпад.`
                              : ' · Нет совпадений'
                            : null}
                        </>
                      ) : (
                        'Фильтр по дате и/или тексту'
                      )}
                    </span>
                    <button
                      type="button"
                      className="lc-chat-search-nav"
                      disabled={searchHits.length < 2}
                      onClick={() =>
                        setChatSearchHitIdx((i) => (i - 1 + searchHits.length) % searchHits.length)
                      }
                      aria-label="Предыдущее совпадение"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="lc-chat-search-nav"
                      disabled={searchHits.length < 2}
                      onClick={() => setChatSearchHitIdx((i) => (i + 1) % searchHits.length)}
                      aria-label="Следующее совпадение"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="lc-chat-search-close"
                      aria-label="Закрыть поиск"
                      onClick={() => {
                        setChatSearchOpen(false);
                        setChatSearchQuery('');
                        setChatSearchDateFrom('');
                        setChatSearchDateTo('');
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
                {active.kind === 'group' && (
                  <div className="lc-chat-messenger-toolbar">
                    <button type="button" onClick={() => setModal('pins')}>
                      Закреплённые ({pins.length})
                    </button>
                    {activeGroup?.role === 'admin' && (
                      <>
                        <button type="button" onClick={() => setModal('groupAdmin')}>
                          Управление
                        </button>
                        <button type="button" onClick={() => setModal('groupAudit')}>
                          Журнал
                        </button>
                      </>
                    )}
                    {activeGroup && (
                      <button type="button" onClick={() => setModal('groupMod')}>
                        Участники
                      </button>
                    )}
                    {activeGroup &&
                      canUseInviteInGroupMod(activeGroup.role, activeGroup.invitePolicy || 'all') && (
                      <button type="button" onClick={() => setModal('groupInviteMember')}>
                        Пригласить
                      </button>
                    )}
                    {activeGroup && (
                      <button
                        type="button"
                        className="lc-announcements-nav-btn"
                        onClick={() => {
                          setModal('groupAnnouncements');
                          if (canMod) void markModAssignmentsSeen(active.id);
                        }}
                      >
                        {canMod ? 'Уведомления' : 'История уведомлений'}
                        {canMod && (modUnreadProgress[active.id] ?? 0) > 0 && (
                          <span
                            className="lc-announcements-mod-badge"
                            aria-label={`Обновлений хода работы: ${modUnreadProgress[active.id]}`}
                          >
                            {(modUnreadProgress[active.id] ?? 0) > 99
                              ? '99+'
                              : modUnreadProgress[active.id]}
                          </span>
                        )}
                      </button>
                    )}
                    {activeGroup && (
                      <MyAssignmentsBadgeButton
                        count={pendingAnnouncements.length + activeAssignmentCount}
                        onClick={() => setMyAssignmentsOpen(true)}
                      />
                    )}
                    <div className="lc-group-tabs lc-group-tabs--in-toolbar">
                      <button
                        type="button"
                        className={groupTab === 'chat' ? 'primary' : ''}
                        onClick={() => {
                          clearCollabOpenFromTasksSession(active.id);
                          setGroupTab('chat');
                        }}
                      >
                        Чат
                      </button>
                      <button
                        type="button"
                        className={groupTab === 'collab' ? 'primary' : ''}
                        onClick={() => {
                          setCollabOpenedFromTasks(false);
                          setCollabReturnFocusTaskId(null);
                          clearCollabOpenFromTasksSession(active.id);
                          setGroupTab('collab');
                        }}
                      >
                        Документы
                      </button>
                      <button
                        type="button"
                        className={groupTab === 'tasks' ? 'primary' : ''}
                        onClick={() => {
                          clearCollabOpenFromTasksSession(active.id);
                          setGroupTab('tasks');
                        }}
                      >
                        Задачи
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            {active.kind === 'group' && groupTab === 'collab' && ioSocket && (
              <div className="messages lc-workspace-messages">
                <Suspense fallback={<p className="meta lc-workspace-suspense">Загрузка документов…</p>}>
                  <GroupWorkspace
                    groupId={active.id}
                    socket={ioSocket}
                    me={me}
                    groupRole={activeGroup?.role || 'member'}
                    openMessageAttachment={
                      attachmentOoViewer && !attachmentOoViewer.overlay
                        ? {
                            id: attachmentOoViewer.attachmentId,
                            fileName: attachmentOoViewer.fileName,
                            ooMode: attachmentOoViewer.ooMode,
                            source: attachmentOoViewer.source ?? 'message',
                          }
                        : null
                    }
                    onCloseMessageAttachment={closeAttachmentOoViewer}
                    openDocumentId={openCollabDocId}
                    onOpenDocumentHandled={clearOpenCollabDoc}
                    returnToTasksOnClose={collabOpenedFromTasks}
                    onReturnFromDocument={() => {
                      const tid = collabReturnFocusTaskId;
                      clearCollabOpenFromTasksSession(active.id);
                      setCollabOpenedFromTasks(false);
                      setCollabReturnFocusTaskId(null);
                      setTasksListFocusRequest(tid);
                      setGroupTab('tasks');
                    }}
                    collabJumpFromChat={collabJumpFromChat}
                    onCollabJumpFromChatApplied={clearCollabJumpFromChatApplied}
                  />
                </Suspense>
              </div>
            )}
            {active.kind === 'group' && groupTab === 'tasks' && ioSocket && (
              <div className="messages lc-workspace-messages">
                <Suspense fallback={<p className="meta lc-workspace-suspense">Загрузка задач…</p>}>
                  <TasksPanel
                    groupId={active.id}
                    socket={ioSocket}
                    me={me}
                    groupRole={activeGroup?.role || 'member'}
                    onOpenCollabDocument={(docId, listCtxTaskId) => {
                      setOpenCollabDocId(docId);
                      setCollabOpenedFromTasks(true);
                      const tid = listCtxTaskId ?? null;
                      setCollabReturnFocusTaskId(tid);
                      writeCollabOpenFromTasksSession(active.id, docId, tid);
                      setGroupTab('collab');
                    }}
                    focusTaskIdRequest={tasksListFocusRequest}
                    onFocusTaskIdRequestHandled={clearTasksListFocusRequest}
                    taskRevealRequest={taskRevealFromChat}
                    onTaskRevealHandled={clearTaskRevealFromChat}
                  />
                </Suspense>
              </div>
            )}
            {(active.kind !== 'group' || groupTab === 'chat') && (
            <div
              className={`lc-chat-main-columns${
                threadLoading || threadPanel != null ? ' lc-chat-main-columns--thread' : ''
              }`}
            >
            <div className="lc-messages-pane">
            {active.kind === 'direct' && attachmentOoViewer && (
              <div className="lc-direct-attachment-oo-layer">
                <Suspense fallback={<p className="meta lc-workspace-suspense">Загрузка просмотра…</p>}>
                  <MessageAttachmentOoView
                    attachmentId={attachmentOoViewer.attachmentId}
                    fileName={attachmentOoViewer.fileName}
                    ooMode={attachmentOoViewer.ooMode}
                    attachmentSource={attachmentOoViewer.source ?? 'message'}
                    onBack={closeAttachmentOoViewer}
                  />
                </Suspense>
              </div>
            )}
            <div
              className="messages"
              ref={messagesScrollRef}
              onScroll={updateStickToBottomFromScroll}
            >
              {loadingOlderMessages ? (
                <div className="lc-load-older meta" role="status">
                  Загрузка старых сообщений…
                </div>
              ) : null}
              {timelineRows.map((row) => {
                if (row.type === 'day') {
                  return (
                    <div key={`day-${row.key}`} className="lc-chat-day-sep" role="presentation">
                      <span className="lc-chat-day-sep-line" aria-hidden />
                      <span className="lc-chat-day-sep-text">{row.label}</span>
                      <span className="lc-chat-day-sep-line" aria-hidden />
                    </div>
                  );
                }
                if (row.type === 'newMarker') {
                  return (
                    <div key="lc-new-msgs" className="lc-chat-new-marker" role="separator">
                      <span className="lc-chat-new-marker-line" aria-hidden />
                      <span className="lc-chat-new-marker-label">Новые сообщения</span>
                      <span className="lc-chat-new-marker-line" aria-hidden />
                    </div>
                  );
                }
                const m = row.m;
                const memberEvent = groupMemberChatEventKind(m);
                if (memberEvent) {
                  return (
                    <div
                      key={m.id}
                      id={`lc-msg-${m.id}`}
                      className="lc-chat-event-row"
                      role="status"
                    >
                      <div className="lc-chat-new-marker lc-chat-member-event">
                        <span className="lc-chat-new-marker-line" aria-hidden />
                        <span className="lc-chat-new-marker-label">{m.body}</span>
                        <span className="lc-chat-new-marker-line" aria-hidden />
                      </div>
                    </div>
                  );
                }
                const isSearchHit =
                  chatSearchOpen &&
                  !!normalizedSearchQ &&
                  (m.body ?? '').toLowerCase().includes(normalizedSearchQ);
                const isCurrentSearchHit = searchHits[chatSearchHitIdx]?.id === m.id;
                const outbound =
                  m.sender.id === me.id
                    ? m.outboundRead ??
                      (active?.kind === 'direct'
                        ? directOwnMessageRead(m.id, directPeerRead)
                        : groupOwnMessageRead(m.id, groupMemberReads))
                    : null;
                return (
                <div
                  key={m.id}
                  id={`lc-msg-${m.id}`}
                  className={`msg ${m.sender.id === me.id ? 'own' : ''} ${m.pinnedAt ? 'pinned' : ''} ${selectMode ? 'lc-msg-selecting' : ''}${selectMode && selectedMessageIds[m.id] ? ' lc-msg-selected' : ''}${isSearchHit ? ' lc-msg-search-hit' : ''}${isCurrentSearchHit ? ' lc-msg-search-hit--current' : ''}`}
                  onPointerDown={(e) => onMessagePointerDown(e, m.id)}
                  onPointerMove={onMessagePointerMove}
                  onPointerUp={onMessagePointerEnd}
                  onPointerCancel={onMessagePointerEnd}
                >
                  {selectMode && (
                    <label className="lc-msg-select-cell">
                      <input
                        type="checkbox"
                        checked={!!selectedMessageIds[m.id]}
                        onChange={() =>
                          setSelectedMessageIds((prev) => ({ ...prev, [m.id]: !prev[m.id] }))
                        }
                      />
                    </label>
                  )}
                  <div
                    className={`lc-msg-layout${m.sender.id === me.id ? ' lc-msg-layout--own' : ''}`}
                  >
                    {!selectMode && m.sender.id !== me.id && (
                      <div className="lc-msg-avatar" aria-hidden>
                        {m.sender.avatarUrl ? (
                          <img src={resolveUrl(m.sender.avatarUrl)} alt="" />
                        ) : (
                          <span className="lc-msg-avatar-fallback">
                            {m.sender.displayName.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="lc-msg-stack">
                      <div className="lc-msg-top-row">
                        <div className="lc-msg-top-left">
                          {m.sender.id !== me.id ? (
                            <span className="lc-msg-author">{m.sender.displayName}</span>
                          ) : null}
                        </div>
                        <div className="lc-msg-top-right">
                          {outbound ? (
                            <MsgReadTicks
                              read={outbound.read}
                              readAt={outbound.readAt}
                              messageId={m.id}
                              fetchReaders={fetchMessageReaders}
                              onShowAll={(readers) => setReadReceiptsModal(readers)}
                            />
                          ) : null}
                          <time className="lc-msg-clock" dateTime={m.createdAt}>
                            {formatMessageClock(m.createdAt)}
                          </time>
                        </div>
                      </div>
                  <div
                    className={`lc-msg-content${m.replyTo || (m.forwardFrom && m.forwardFrom.length) ? ' lc-msg-has-reply' : ''}${m.forwardFrom?.length ? ' lc-msg-has-forward' : ''}`}
                  >
                    {m.forwardFrom?.map((f, fi) => (
                      <div
                        key={fi}
                        className="lc-msg-reply-quote lc-msg-forward-line"
                        role="figure"
                        aria-label={`Переслано от ${f.sender.displayName}: ${f.bodyPreview}${f.hasAttachments ? ' (вложение)' : ''}`}
                      >
                        <span className="lc-msg-reply-bar" aria-hidden />
                        <span className="lc-msg-reply-col">
                          <span className="lc-msg-reply-name">{f.sender.displayName}</span>
                          <span className="lc-msg-reply-snippet">
                            {f.bodyPreview}
                            {f.hasAttachments ? (
                              <span className="lc-msg-reply-attach-mark"> · 📎</span>
                            ) : null}
                          </span>
                        </span>
                      </div>
                    ))}
                    {m.replyTo && (
                      <button
                        type="button"
                        className="lc-msg-reply-quote"
                        aria-label={`Ответ на сообщение ${m.replyTo.sender.displayName}: ${m.replyTo.bodyPreview}${m.replyTo.hasAttachments ? ' (вложение)' : ''}`}
                        onClick={() => scrollToChatMessageOrLoad(m.replyTo!.id)}
                      >
                        <span className="lc-msg-reply-bar" aria-hidden />
                        <span className="lc-msg-reply-col">
                          <span className="lc-msg-reply-name">{m.replyTo.sender.displayName}</span>
                          <span className="lc-msg-reply-snippet">
                            {m.replyTo.bodyPreview}
                            {m.replyTo.hasAttachments ? (
                              <span className="lc-msg-reply-attach-mark"> · 📎</span>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    )}
                    {!selectMode && (
                      <div className="lc-msg-head">
                        <div className="who">
                          {m.sender.id === me.id ? (
                            <>
                              {m.sender.displayName} · @{m.sender.tag}
                            </>
                          ) : null}
                          {m.importantForMe && <span className="pill lc-msg-star-pill" title="Важное">★</span>}
                          {m.pinnedAt && <span className="pill">закреплено</span>}
                          {m.editedAt && <span className="pill lc-msg-edited-pill">изменено</span>}
                        </div>
                        <div className="lc-msg-toolbar">
                          <div className="lc-msg-toolbar-pill">
                            <button
                              type="button"
                              className="lc-msg-tool lc-msg-reply-btn"
                              title="Ответить"
                              aria-label="Ответить"
                              onClick={() => {
                                setReplyingTo(m);
                                setEditingMessage(null);
                                setMessageMenuOpen(null);
                                setForwardSubmenuOpen(false);
                                setTimeout(() => composerTextareaRef.current?.focus(), 0);
                              }}
                            >
                              <IconReplyQuick />
                            </button>
                            <button
                              type="button"
                              className="lc-msg-tool lc-msg-more-btn"
                              title="Ещё"
                              aria-label="Меню сообщения"
                              aria-expanded={messageMenuOpen === m.id}
                              onClick={() => {
                                setForwardSubmenuOpen(false);
                                setFileAttachSubmenu(null);
                                setMessageMenuOpen((open) => (open === m.id ? null : m.id));
                              }}
                            >
                              ⋯
                            </button>
                          </div>
                          {messageMenuOpen === m.id && (
                            <ul
                              ref={messageMenuRef}
                              className={`lc-msg-menu${messageMenuOpenAbove ? ' lc-msg-menu--above' : ''}`}
                              role="menu"
                            >
                              <li>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="lc-msg-menu-item"
                                  onClick={() => {
                                    setReplyingTo(m);
                                    setEditingMessage(null);
                                    setMessageMenuOpen(null);
                                    setForwardSubmenuOpen(false);
                                    setTimeout(() => composerTextareaRef.current?.focus(), 0);
                                  }}
                                >
                                  <IconMenuReply className="lc-msg-menu-icon" />
                                  <span>Ответить</span>
                                </button>
                              </li>
                              {!m.chatEvent && (
                                <li>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="lc-msg-menu-item"
                                    onClick={() => {
                                      setMessageMenuOpen(null);
                                      setForwardSubmenuOpen(false);
                                      void openThreadForMessage(m);
                                    }}
                                  >
                                    <span>Тред</span>
                                  </button>
                                </li>
                              )}
                              {active?.kind === 'group' && !m.chatEvent && (
                                <li>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="lc-msg-menu-item"
                                    onClick={() => {
                                      setForwardSubmenuOpen(false);
                                      setWsLinkPickModal({ message: m, tab: 'task' });
                                      setMessageMenuOpen(null);
                                    }}
                                  >
                                    <span>Связать с…</span>
                                  </button>
                                </li>
                              )}
                              {m.sender.id !== me.id &&
                                (friendIds[m.sender.id] ? (
                                  <li>
                                    <div className="lc-msg-menu-item" style={{ opacity: 0.7, cursor: 'default' }}>
                                      <IconMenuFriend className="lc-msg-menu-icon" />
                                      <span>В коллегах</span>
                                    </div>
                                  </li>
                                ) : pendingFriendIn[m.sender.id] ? (
                                  <li>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="lc-msg-menu-item lc-msg-menu-friend-accept"
                                      onClick={async () => {
                                        try {
                                          await api('/api/friends/accept', {
                                            method: 'POST',
                                            json: { userId: m.sender.id },
                                          });
                                          await refreshFriendState();
                                          setMessageMenuOpen(null);
                                          setForwardSubmenuOpen(false);
                                          showToast('Пользователь добавлен в коллеги');
                                        } catch (e) {
                                          showToast(
                                            e instanceof Error ? e.message : 'Не удалось принять заявку'
                                          );
                                        }
                                      }}
                                    >
                                      <IconMenuFriend className="lc-msg-menu-icon" />
                                      <span>Принять заявку к коллегам</span>
                                    </button>
                                  </li>
                                ) : pendingFriendOut[m.sender.id] ? (
                                  <li>
                                    <div className="lc-msg-menu-item" style={{ opacity: 0.65, cursor: 'default' }}>
                                      <IconMenuFriend className="lc-msg-menu-icon" />
                                      <span>Заявка отправлена</span>
                                    </div>
                                  </li>
                                ) : (
                                  <li>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="lc-msg-menu-item"
                                      onClick={async () => {
                                        try {
                                          await api('/api/friends/request', {
                                            method: 'POST',
                                            json: { userId: m.sender.id },
                                          });
                                          await refreshFriendState();
                                          setMessageMenuOpen(null);
                                          setForwardSubmenuOpen(false);
                                          showToast('Заявка к коллегам отправлена');
                                        } catch (e) {
                                          showToast(
                                            e instanceof Error ? e.message : 'Не удалось отправить заявку'
                                          );
                                        }
                                      }}
                                    >
                                      <IconMenuFriend className="lc-msg-menu-icon" />
                                      <span>Добавить в коллеги</span>
                                    </button>
                                  </li>
                                ))}
                              {!(
                                m.groupId != null &&
                                groups.find((g) => g.id === m.groupId)?.forwardLocked
                              ) && (
                                <li className="lc-msg-menu-forward-wrap">
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="lc-msg-menu-item"
                                    onClick={() => {
                                      setFileAttachSubmenu(null);
                                      setForwardFromMessage(m);
                                      setForwardSubmenuOpen(true);
                                    }}
                                  >
                                    <IconMenuForward className="lc-msg-menu-icon" />
                                    <span>Переслать</span>
                                    <IconMenuChevron className="lc-msg-menu-chevron" />
                                  </button>
                                  {forwardSubmenuOpen && forwardFromMessage?.id === m.id && (
                                    <div className="lc-msg-forward-flyout" role="menu">
                                      <div className="lc-msg-forward-flyout-title">Куда переслать</div>
                                      {sortedGroups.map((g) => (
                                        <button
                                          key={`fw-g-${g.id}`}
                                          type="button"
                                          className="lc-msg-forward-opt"
                                          onClick={() => void forwardTo(m.id, 'group', g.id)}
                                        >
                                          {g.name}
                                        </button>
                                      ))}
                                      {sortedDirects.map((d) => (
                                        <button
                                          key={`fw-d-${d.id}`}
                                          type="button"
                                          className="lc-msg-forward-opt"
                                          onClick={() => void forwardTo(m.id, 'direct', d.id)}
                                        >
                                          {d.peer.displayName}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </li>
                              )}
                              <li>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="lc-msg-menu-item"
                                  onClick={() => void toggleMessageImportant(m)}
                                >
                                  <IconMenuStar className="lc-msg-menu-icon" />
                                  <span>
                                    {m.importantForMe ? 'Снять важное' : 'Отметить как важное'}
                                  </span>
                                </button>
                              </li>
                              {active?.kind !== 'group' && (
                                <li>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="lc-msg-menu-item"
                                    onClick={() => {
                                      const t = m.body?.trim() || '';
                                      void navigator.clipboard.writeText(t);
                                      setMessageMenuOpen(null);
                                      setForwardSubmenuOpen(false);
                                      showToast(t ? 'Текст скопирован' : 'Нет текста');
                                    }}
                                  >
                                    <IconMenuCopy className="lc-msg-menu-icon" />
                                    <span>Копировать текст</span>
                                  </button>
                                </li>
                              )}
                              {m.attachments.some((x) => x.kind === 'file') && (
                                <li className="lc-msg-menu-forward-wrap">
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="lc-msg-menu-item"
                                    onClick={() => {
                                      setForwardSubmenuOpen(false);
                                      setFileAttachSubmenu((s) =>
                                        s?.messageId === m.id && s.kind === 'download'
                                          ? null
                                          : { messageId: m.id, kind: 'download' }
                                      );
                                    }}
                                  >
                                    <span>Скачать файлы</span>
                                    <IconMenuChevron className="lc-msg-menu-chevron" />
                                  </button>
                                  {fileAttachSubmenu?.messageId === m.id &&
                                    fileAttachSubmenu.kind === 'download' && (
                                      <div className="lc-msg-forward-flyout lc-msg-attach-flyout" role="menu">
                                        <div className="lc-msg-forward-flyout-title">Скачать</div>
                                        {m.attachments
                                          .filter((x) => x.kind === 'file')
                                          .map((a) => (
                                            <a
                                              key={a.id}
                                              href={resolveUrl(a.url)}
                                              download={a.fileName}
                                              className="lc-msg-forward-opt"
                                              onClick={() => {
                                                setMessageMenuOpen(null);
                                                setFileAttachSubmenu(null);
                                                setForwardSubmenuOpen(false);
                                              }}
                                            >
                                              {a.fileName}
                                            </a>
                                          ))}
                                      </div>
                                    )}
                                </li>
                              )}
                              {active?.kind === 'group' &&
                                ooChatEnabled &&
                                m.attachments.some(
                                  (x) =>
                                    x.kind === 'file' &&
                                    chatAttachmentSupportsOnlyOffice(x.fileName, x.mimeType)
                                ) && (
                                  <li className="lc-msg-menu-forward-wrap">
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="lc-msg-menu-item"
                                      onClick={() => {
                                        setForwardSubmenuOpen(false);
                                        setFileAttachSubmenu((s) =>
                                          s?.messageId === m.id && s.kind === 'collab'
                                            ? null
                                            : { messageId: m.id, kind: 'collab' }
                                        );
                                      }}
                                    >
                                      <span>В документы</span>
                                      <IconMenuChevron className="lc-msg-menu-chevron" />
                                    </button>
                                    {fileAttachSubmenu?.messageId === m.id &&
                                      fileAttachSubmenu.kind === 'collab' && (
                                        <div className="lc-msg-forward-flyout lc-msg-attach-flyout" role="menu">
                                          <div className="lc-msg-forward-flyout-title">
                                            Сохранить в документы
                                          </div>
                                          {m.attachments
                                            .filter(
                                              (x) =>
                                                x.kind === 'file' &&
                                                chatAttachmentSupportsOnlyOffice(x.fileName, x.mimeType)
                                            )
                                            .map((a) => (
                                              <button
                                                key={a.id}
                                                type="button"
                                                className="lc-msg-forward-opt"
                                                onClick={() => {
                                                  setMessageMenuOpen(null);
                                                  setFileAttachSubmenu(null);
                                                  setForwardSubmenuOpen(false);
                                                  void saveChatAttachmentToCollab(active.id, a.id);
                                                }}
                                              >
                                                {a.fileName}
                                              </button>
                                            ))}
                                        </div>
                                      )}
                                  </li>
                                )}
                              {active?.kind !== 'group' && m.sender.id === me.id && (
                                <li>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="lc-msg-menu-item"
                                    onClick={() => {
                                      setEditingMessage(m);
                                      setText(m.body || '');
                                      setComposerMentionPicks(
                                        mentionPicksFromStoredIds(
                                          Array.isArray(m.mentionUserIds) ? m.mentionUserIds : [],
                                          members
                                        )
                                      );
                                      setReplyingTo(null);
                                      setMessageMenuOpen(null);
                                      setForwardSubmenuOpen(false);
                                      setTimeout(() => composerTextareaRef.current?.focus(), 0);
                                    }}
                                  >
                                    <IconMenuEdit />
                                    <span>Изменить</span>
                                  </button>
                                </li>
                              )}
                              {showPinInMenu && (
                                <li>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="lc-msg-menu-item"
                                    onClick={() => {
                                      void toggleMessagePin(m);
                                      setMessageMenuOpen(null);
                                      setForwardSubmenuOpen(false);
                                    }}
                                  >
                                    <IconMenuPin pinned={!!m.pinnedAt} />
                                    <span>{m.pinnedAt ? 'Открепить' : 'Закрепить'}</span>
                                  </button>
                                </li>
                              )}
                              {active?.kind !== 'group' && canDeleteMessage(m) && (
                                <li>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="lc-msg-menu-item danger"
                                    onClick={() => {
                                      setMessageMenuOpen(null);
                                      setForwardSubmenuOpen(false);
                                      void deleteMessage(m);
                                    }}
                                  >
                                    <IconMenuTrash className="lc-msg-menu-icon" />
                                    <span>Удалить</span>
                                  </button>
                                </li>
                              )}
                              <li>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="lc-msg-menu-item"
                                  onClick={() => {
                                    setMessageMenuOpen(null);
                                    setForwardSubmenuOpen(false);
                                    setSelectMode(true);
                                    setSelectedMessageIds({ [m.id]: true });
                                  }}
                                >
                                  <IconMenuSelect className="lc-msg-menu-icon" />
                                  <span>Выбрать</span>
                                </button>
                              </li>
                            </ul>
                          )}
                        </div>
                      </div>
                    )}
                  {m.body && (
                    <div className="body">
                      {chatSearchOpen && normalizedSearchQ
                        ? messageBodyWithSearchMarks(m.body, chatSearchQuery)
                        : m.body}
                    </div>
                  )}
                  {m.attachments.some((a) => a.kind === 'image') && (
                    <MessageImageGrid
                      images={m.attachments.filter((a) => a.kind === 'image')}
                      allAttachments={m.attachments}
                      resolveUrl={resolveUrl}
                      resolveImageUrl={resolveAttachmentThumbUrl}
                      onOpenImage={openMessageImageLightbox}
                    />
                  )}
                  {m.attachments
                    .filter((a) => a.kind !== 'image')
                    .map((a) => (
                    <div key={a.id}>
                      {a.kind === 'video' && <video src={resolveUrl(a.url)} controls />}
                      {(a.kind === 'audio' || a.kind === 'voice') && (
                        <audio src={resolveUrl(a.url)} controls />
                      )}
                      {a.kind === 'file' && (
                        <a
                          className="lc-chat-attach-link"
                          href={resolveUrl(a.url)}
                          {...(!(ooChatEnabled && chatAttachmentSupportsOnlyOffice(a.fileName, a.mimeType))
                            ? { download: a.fileName }
                            : {})}
                          onClick={(e) => {
                            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                            if (ooChatEnabled && chatAttachmentSupportsOnlyOffice(a.fileName, a.mimeType)) {
                              e.preventDefault();
                              openChatAttachmentOnlyOffice(a.id, a.fileName, m.sender.id);
                            }
                          }}
                        >
                          📎 {a.fileName}
                        </a>
                      )}
                    </div>
                  ))}
                  {active?.kind === 'group' && (m.workspaceLinks ?? []).length > 0 && (
                    <div className="lc-msg-workspace-links">
                      {(m.workspaceLinks ?? []).map((l) => (
                        <span key={l.id} className="pill lc-msg-ws-link" title={l.title}>
                          <button
                            type="button"
                            className="lc-msg-ws-link-main"
                            onClick={() => onMessageWorkspaceLinkClick(l)}
                          >
                            <span aria-hidden>{l.kind === 'task' ? '📋' : '📄'}</span>
                            {l.title}
                          </button>
                          <button
                            type="button"
                            className="lc-msg-ws-link-remove"
                            aria-label="Убрать связь"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              void removeWorkspaceLink(m.id, l.id);
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="lc-msg-reactions">
                    {(m.reactions ?? []).map((g) => (
                      <button
                        key={g.emoji}
                        type="button"
                        className="lc-reaction-pill"
                        title={g.users.map((u) => u.displayName).join(', ')}
                        onClick={() => void postMessageReaction(m.id, g.emoji)}
                      >
                        <span className="lc-reaction-emoji">{g.emoji}</span>
                        <span className="lc-reaction-avatars">
                          {g.users.slice(0, 4).map((u) =>
                            u.avatarUrl ? (
                              <img
                                key={u.id}
                                className="lc-reaction-avatar"
                                src={resolveUrl(u.avatarUrl)}
                                alt=""
                              />
                            ) : (
                              <span key={u.id} className="lc-reaction-avatar lc-reaction-avatar-fallback">
                                {u.displayName.slice(0, 1).toUpperCase()}
                              </span>
                            )
                          )}
                        </span>
                        {g.users.length > 4 && (
                          <span className="lc-reaction-more">+{g.users.length - 4}</span>
                        )}
                      </button>
                    ))}
                    {!selectMode && (
                      <div
                        className="lc-reaction-picker-wrap"
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="lc-reaction-add"
                          aria-label="Добавить реакцию"
                          onClick={() =>
                            setReactionPickerFor((id) => (id === m.id ? null : m.id))
                          }
                        >
                          +
                        </button>
                        {reactionPickerFor === m.id && (
                          <div className="lc-reaction-picker" role="listbox">
                            {REACTION_QUICK.map((em) => (
                              <button
                                key={em}
                                type="button"
                                className="lc-reaction-pick"
                                onClick={() => {
                                  void postMessageReaction(m.id, em);
                                  setReactionPickerFor(null);
                                }}
                              >
                                {em}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                    </div>
                  </div>
              </div>
              );
              })}
              <div className="lc-messages-end-anchor" aria-hidden />
            </div>
            {(scrollJumpVisible || belowFoldNewCount > 0) && !selectMode && (
              <button
                type="button"
                className="lc-new-messages-btn"
                aria-label={
                  belowFoldNewCount > 0
                    ? `К первому новому сообщению (${belowFoldNewCount} нов.)`
                    : 'Прокрутить чат к последним сообщениям'
                }
                onClick={() => {
                  if (belowFoldNewCount > 0) scrollToFirstNewMessage();
                  else scrollChatToBottom();
                }}
              >
                <span className="lc-new-messages-btn-icon" aria-hidden>
                  ↓
                </span>
                {belowFoldNewCount > 0
                  ? belowFoldNewCount === 1
                    ? 'Новое сообщение'
                    : `Новые сообщения · ${belowFoldNewCount}`
                  : 'К последним'}
              </button>
            )}
            </div>
            {(threadLoading || threadPanel != null) && (
              <aside className="lc-thread-panel" aria-label="Тред сообщений">
                <div className="lc-thread-panel-head">
                  <span>Тред</span>
                  <button
                    type="button"
                    aria-label="Закрыть панель треда"
                    onClick={() => {
                      setThreadPanel(null);
                      setThreadLoading(false);
                    }}
                  >
                    ×
                  </button>
                </div>
                <div className="lc-thread-panel-body">
                  {threadLoading && <p className="meta">Загрузка…</p>}
                  {!threadLoading &&
                    threadPanel &&
                    threadPanel.messages.map((tm) => (
                      <div key={tm.id} className="lc-thread-panel-msg">
                        <div className="lc-thread-panel-msg-head">
                          <div className="meta lc-thread-panel-msg-author">
                            <strong>{tm.sender.displayName}</strong>
                          </div>
                          <button
                            type="button"
                            className="lc-text-btn lc-thread-panel-jump"
                            onClick={() => scrollToChatMessageOrLoad(tm.id)}
                          >
                            К сообщению
                          </button>
                        </div>
                        {tm.body ? <div className="body">{tm.body}</div> : null}
                        {(tm.attachments ?? []).some((a) => a.kind === 'image') && (
                          <MessageImageGrid
                            images={(tm.attachments ?? []).filter((a) => a.kind === 'image')}
                            allAttachments={tm.attachments ?? []}
                            resolveUrl={resolveUrl}
                            resolveImageUrl={resolveAttachmentThumbUrl}
                            onOpenImage={openMessageImageLightbox}
                          />
                        )}
                        {(tm.attachments ?? [])
                          .filter((a) => a.kind !== 'image')
                          .map((a) => (
                          <div key={a.id}>
                            {a.kind === 'video' && <video src={resolveUrl(a.url)} controls />}
                            {(a.kind === 'audio' || a.kind === 'voice') && (
                              <audio src={resolveUrl(a.url)} controls />
                            )}
                            {a.kind === 'file' && (
                              <a
                                className="lc-chat-attach-link"
                                href={resolveUrl(a.url)}
                                {...(!(ooChatEnabled && chatAttachmentSupportsOnlyOffice(a.fileName, a.mimeType))
                                  ? { download: a.fileName }
                                  : {})}
                                onClick={(e) => {
                                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                                  if (
                                    ooChatEnabled &&
                                    chatAttachmentSupportsOnlyOffice(a.fileName, a.mimeType)
                                  ) {
                                    e.preventDefault();
                                    openChatAttachmentOnlyOffice(a.id, a.fileName, tm.sender.id);
                                  }
                                }}
                              >
                                📎 {a.fileName}
                              </a>
                            )}
                          </div>
                        ))}
                        {(tm.workspaceLinks ?? []).length > 0 && (
                          <div className="lc-msg-workspace-links lc-thread-panel-ws">
                            {(tm.workspaceLinks ?? []).map((l) => (
                              <span key={l.id} className="pill lc-msg-ws-link" title={l.title}>
                                <button
                                  type="button"
                                  className="lc-msg-ws-link-main"
                                  onClick={() => onMessageWorkspaceLinkClick(l)}
                                >
                                  <span aria-hidden>{l.kind === 'task' ? '📋' : '📄'}</span>
                                  {l.title}
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </aside>
            )}
            </div>
            )}
            {(active.kind !== 'group' || groupTab === 'chat') && selectMode && (
              <div className="lc-select-bar">
                <span>Выбрано: {selectedCount}</span>
                <div className="lc-select-bar-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectMode(false);
                      setSelectedMessageIds({});
                      setSelectForwardOpen(false);
                    }}
                  >
                    Отмена
                  </button>
                  <div className="lc-select-forward-wrap">
                    <button
                      type="button"
                      disabled={selectedCount === 0 || bulkForwardBlocked}
                      title={
                        bulkForwardBlocked
                          ? 'В выборе есть сообщения из чата с запретом пересылки'
                          : undefined
                      }
                      onClick={() => setSelectForwardOpen((o) => !o)}
                    >
                      Переслать
                    </button>
                    {selectForwardOpen && selectedCount > 0 && !bulkForwardBlocked && (
                      <div className="lc-msg-forward-flyout lc-select-forward-flyout" role="menu">
                        <div className="lc-msg-forward-flyout-title">Куда переслать</div>
                        {sortedGroups.map((g) => (
                          <button
                            key={`sfw-g-${g.id}`}
                            type="button"
                            className="lc-msg-forward-opt"
                            onClick={() => void forwardBatchTo('group', g.id)}
                          >
                            {g.name}
                          </button>
                        ))}
                        {sortedDirects.map((d) => (
                          <button
                            key={`sfw-d-${d.id}`}
                            type="button"
                            className="lc-msg-forward-opt"
                            onClick={() => void forwardBatchTo('direct', d.id)}
                          >
                            {d.peer.displayName}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            {(active.kind !== 'group' || groupTab === 'chat') && (
            <div className="composer">
              {editingMessage && (
                <div className="lc-composer-banner lc-composer-edit">
                  <span>Редактирование сообщения</span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingMessage(null);
                      setText('');
                      setComposerMentionPicks([]);
                    }}
                  >
                    Отмена
                  </button>
                </div>
              )}
              {replyingTo && !editingMessage && (
                <div className="lc-composer-banner lc-composer-reply">
                  <div className="lc-composer-reply-bar" aria-hidden />
                  <div className="lc-composer-reply-main">
                    <div className="lc-composer-reply-title">Ответ на сообщение</div>
                    <div className="lc-composer-reply-author">
                      <strong>{replyingTo.sender.displayName}</strong>
                      <span className="lc-composer-reply-tag"> @{replyingTo.sender.tag}</span>
                    </div>
                    <div className="lc-composer-reply-snippet">
                      {replyingTo.body?.trim() ||
                        (replyingTo.attachments?.length
                          ? '📎 Вложение'
                          : 'Сообщение без текста')}
                    </div>
                    <button
                      type="button"
                      className="lc-composer-reply-jump"
                      onClick={() => scrollToChatMessageOrLoad(replyingTo.id)}
                    >
                      Показать в чате
                    </button>
                  </div>
                  <div className="lc-composer-reply-actions">
                    <button type="button" aria-label="Отменить ответ" onClick={() => setReplyingTo(null)}>
                      ×
                    </button>
                  </div>
                </div>
              )}
              {typeof Notification !== 'undefined' && Notification.permission === 'default' && (
                <div className="lc-composer-notify-hint">
                  <button
                    type="button"
                    className="lc-text-btn"
                    onClick={async () => {
                      const r = await Notification.requestPermission();
                      if (r === 'granted') showToast('Уведомления на рабочем столе включены');
                      else if (r === 'denied')
                        showToast('Браузер запретил уведомления — снимите блокировку в настройках сайта');
                    }}
                  >
                    Включить уведомления на рабочем столе
                  </button>
                  <span className="lc-composer-notify-hint-rest">
                    — чтобы приходили оповещения об упоминаниях @, когда вкладка в фоне
                  </span>
                </div>
              )}
              <div
                className={`lc-composer-dropzone${composerDropHover ? ' lc-composer-dropzone--active' : ''}`}
                onDragOver={(e) => {
                  if (editingMessage) return;
                  if (![...e.dataTransfer.types].includes('Files')) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  setComposerDropHover(true);
                }}
                onDragLeave={(e) => {
                  const rel = e.relatedTarget as Node | null;
                  if (rel && e.currentTarget.contains(rel)) return;
                  setComposerDropHover(false);
                }}
                onDrop={(e) => {
                  setComposerDropHover(false);
                  if (editingMessage) return;
                  if (![...e.dataTransfer.types].includes('Files')) return;
                  e.preventDefault();
                  const fl = [...(e.dataTransfer.files || [])];
                  if (fl.length) {
                    setComposerDropFiles((prev) =>
                      capComposerPhotoFiles(prev, fl, () =>
                        showToast(`Можно прикрепить не больше ${MAX_MESSAGE_PHOTOS} фотографий`)
                      )
                    );
                  }
                }}
              >
              <div className="lc-composer-field-wrap">
                {active.kind === 'group' && !editingMessage && composerWorkspaceLinks.length > 0 && (
                  <div className="lc-composer-ws-pending" aria-label="Привязки к сообщению">
                    <span className="lc-composer-ws-pending-label">К сообщению:</span>
                    {composerWorkspaceLinks.map((l) => (
                      <span key={`${l.kind}:${l.entityId}`} className="pill lc-composer-ws-pending-pill">
                        {l.kind === 'task' ? '📋' : '📄'} {l.title}
                        <button
                          type="button"
                          className="lc-msg-ws-link-remove"
                          aria-label="Убрать привязку"
                          onClick={() =>
                            setComposerWorkspaceLinks((prev) =>
                              prev.filter((x) => !(x.kind === l.kind && x.entityId === l.entityId))
                            )
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {hashPickerVisible && (
                  <div
                    className="lc-mention-picker lc-hash-picker"
                    role="listbox"
                    aria-label="Задача или документ"
                  >
                    <div className="lc-hash-picker-tabs" role="tablist" aria-label="Тип объекта">
                      <button
                        type="button"
                        role="tab"
                        className={hashPickerTab === 'task' ? 'lc-hash-picker-tab lc-hash-picker-tab--active' : 'lc-hash-picker-tab'}
                        aria-selected={hashPickerTab === 'task'}
                        onMouseDown={(ev) => ev.preventDefault()}
                        onClick={() => {
                          setHashPickerTab('task');
                          setHashPickIdx(0);
                        }}
                      >
                        Задачи
                      </button>
                      <button
                        type="button"
                        role="tab"
                        className={
                          hashPickerTab === 'document'
                            ? 'lc-hash-picker-tab lc-hash-picker-tab--active'
                            : 'lc-hash-picker-tab'
                        }
                        aria-selected={hashPickerTab === 'document'}
                        onMouseDown={(ev) => ev.preventDefault()}
                        onClick={() => {
                          setHashPickerTab('document');
                          setHashPickIdx(0);
                        }}
                      >
                        Документы
                      </button>
                    </div>
                    {hashCandidates.length === 0 ? (
                      <div className="lc-mention-picker-empty">
                        {hashPickerTab === 'task'
                          ? pickerTasks.length === 0
                            ? 'Нет задач в группе'
                            : 'Нет совпадений'
                          : pickerDocs.length === 0
                            ? 'Нет документов'
                            : 'Нет совпадений'}
                      </div>
                    ) : (
                      hashPickerTab === 'task'
                        ? hashTaskCandidates.map((t, idx) => (
                            <button
                              key={t.id}
                              type="button"
                              role="option"
                              aria-selected={idx === hashPickIdx}
                              className={`lc-mention-picker-row lc-hash-picker-row${idx === hashPickIdx ? ' lc-mention-picker-row--active' : ''}`}
                              onMouseDown={(ev) => ev.preventDefault()}
                              onMouseEnter={() => setHashPickIdx(idx)}
                              onClick={() => applyHashChoice('task', t.id, t.title)}
                            >
                              <div className="lc-mention-picker-text">
                                <div className="lc-mention-picker-name">
                                  {t.boardHasPassword ? '🔒 ' : ''}
                                  {t.title}
                                </div>
                                <div className="lc-mention-picker-tag">Доска: {t.boardName}</div>
                              </div>
                            </button>
                          ))
                        : hashDocCandidates.map((d, idx) => (
                            <button
                              key={d.id}
                              type="button"
                              role="option"
                              aria-selected={idx === hashPickIdx}
                              className={`lc-mention-picker-row lc-hash-picker-row lc-hash-picker-row--doc${idx === hashPickIdx ? ' lc-mention-picker-row--active' : ''}`}
                              onMouseDown={(ev) => ev.preventDefault()}
                              onMouseEnter={() => setHashPickIdx(idx)}
                              onClick={() => applyHashChoice('collab_document', d.id, d.name)}
                              onDoubleClick={(ev) => {
                                ev.preventDefault();
                                if (d.previewImageUrl)
                                  openSingleImageLightbox(resolveUrl(d.previewImageUrl));
                              }}
                            >
                              {d.previewImageUrl ? (
                                <img
                                  className="lc-hash-doc-thumb"
                                  src={resolveUrl(d.previewImageUrl)}
                                  alt=""
                                  aria-hidden
                                />
                              ) : null}
                              <div className="lc-mention-picker-text">
                                <div className="lc-mention-picker-name">
                                  {d.hasPassword ? '🔒 ' : ''}
                                  {d.name}
                                </div>
                                <div className="lc-mention-picker-tag">
                                  {d.docType === 'spreadsheet' ? 'Таблица' : d.imageDocument ? 'Фото' : 'Документ'}
                                  {d.previewImageUrl ? ' · двойной щелчок — фото' : ''}
                                </div>
                              </div>
                            </button>
                          ))
                    )}
                  </div>
                )}
                {mentionPickerVisible && (
                  <div
                    className="lc-mention-picker"
                    role="listbox"
                    aria-label="Упомянуть участника"
                  >
                    {mentionPickerItems.length === 0 ? (
                      <div className="lc-mention-picker-empty">Нет совпадений</div>
                    ) : (
                      mentionPickerItems.map((item, idx) =>
                        item.kind === 'all' ? (
                          <button
                            key="all"
                            type="button"
                            role="option"
                            aria-selected={idx === mentionPickIdx}
                            className={`lc-mention-picker-row lc-mention-picker-row--all${idx === mentionPickIdx ? ' lc-mention-picker-row--active' : ''}`}
                            onMouseDown={(ev) => ev.preventDefault()}
                            onMouseEnter={() => setMentionPickIdx(idx)}
                            onClick={() => applyMentionAllChoice()}
                          >
                            <div className="lc-mention-picker-avatar lc-mention-picker-avatar--all" aria-hidden>
                              <span>∀</span>
                            </div>
                            <div className="lc-mention-picker-text">
                              <div className="lc-mention-picker-name">Все участники</div>
                              <div className="lc-mention-picker-tag">@all — уведомление всем</div>
                            </div>
                          </button>
                        ) : (
                          <button
                            key={item.user.id}
                            type="button"
                            role="option"
                            aria-selected={idx === mentionPickIdx}
                            className={`lc-mention-picker-row${idx === mentionPickIdx ? ' lc-mention-picker-row--active' : ''}`}
                            onMouseDown={(ev) => ev.preventDefault()}
                            onMouseEnter={() => setMentionPickIdx(idx)}
                            onClick={() => applyMentionChoice(item.user)}
                          >
                            <div className="lc-mention-picker-avatar" aria-hidden>
                              {item.user.avatarUrl ? (
                                <img src={resolveUrl(item.user.avatarUrl)} alt="" />
                              ) : (
                                <span>{item.user.displayName.slice(0, 1).toUpperCase()}</span>
                              )}
                            </div>
                            <div className="lc-mention-picker-text">
                              <div className="lc-mention-picker-name">{item.user.displayName}</div>
                              <div className="lc-mention-picker-tag">@{item.user.tag}</div>
                            </div>
                          </button>
                        )
                      )
                    )}
                  </div>
                )}
                {!editingMessage && composerDropFiles.length > 0 ? (
                  <div className="lc-composer-attached-strip" aria-label="Файлы к отправке">
                    {composerDropFiles.map((f, i) => (
                      <span
                        key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
                        className="pill lc-composer-dropped-file-pill"
                      >
                        {f.name}
                        {f.type.startsWith('image/') && (
                          <button
                            type="button"
                            className="lc-composer-file-annotate"
                            aria-label="Рисовать на фото"
                            title="Рисовать на фото"
                            onClick={() => openComposerPhotoAnnotator(f, i)}
                          >
                            ✏️
                          </button>
                        )}
                        <button
                          type="button"
                          className="lc-msg-ws-link-remove"
                          aria-label="Убрать файл"
                          onClick={() =>
                            setComposerDropFiles((prev) => prev.filter((_, j) => j !== i))
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="lc-composer-input-bar">
                  <div
                    className={`lc-composer-attach-slot${editingMessage ? ' lc-composer-attach-slot--disabled' : ''}`}
                  >
                    <label
                      htmlFor={composerFileInputId}
                      className="lc-composer-bar-icon-btn lc-composer-attach-faux"
                      aria-hidden
                    >
                      <svg
                        className="lc-composer-bar-svg"
                        viewBox="0 0 24 24"
                        width="22"
                        height="22"
                        aria-hidden
                      >
                        <path
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                        />
                      </svg>
                      {composerDropFiles.length > 0 ? (
                        <span className="lc-composer-attach-badge" aria-hidden>
                          {composerDropFiles.length > MAX_MESSAGE_PHOTOS
                            ? `${MAX_MESSAGE_PHOTOS}+`
                            : composerDropFiles.length}
                        </span>
                      ) : null}
                    </label>
                    <input
                      key={composerFileInputKey}
                      id={composerFileInputId}
                      ref={bindComposerFileInputRef}
                      type="file"
                      multiple
                      disabled={!!editingMessage}
                      className="lc-composer-file-hidden"
                      tabIndex={-1}
                      aria-label="Прикрепить файл"
                    />
                  </div>
                  <textarea
                    ref={composerTextareaRef}
                    className="lc-composer-bar-textarea"
                    value={text}
                    onChange={(e) => {
                      const v = e.target.value;
                      const prevHashCount = (text.match(/#/g) || []).length;
                      const nextHashCount = (v.match(/#/g) || []).length;
                      if (nextHashCount > prevHashCount) setHashPickerSuppressAfterPick(false);
                      setText(v);
                      setComposerCaret(e.target.selectionStart ?? v.length);
                    }}
                    onSelect={(e) =>
                      setComposerCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)
                    }
                    onClick={(e) =>
                      setComposerCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)
                    }
                    onKeyUp={(e) =>
                      setComposerCaret((e.target as HTMLTextAreaElement).selectionStart ?? text.length)
                    }
                    placeholder={
                      editingMessage
                        ? 'Отредактируйте текст…'
                        : replyingTo
                          ? 'Ваш ответ… (Shift+Enter — новая строка)'
                            : active.kind === 'group'
                            ? 'Сообщение… @ — участник или @all, # — задача или документ; перетащите файлы сюда'
                            : 'Сообщение… @ник — упоминание; перетащите файлы сюда'
                    }
                    rows={1}
                    onKeyDown={(e) => {
                      const hashNavOpen = hashPickerVisible && hashCandidates.length > 0;
                      const mentionNavOpen = mentionPickerVisible && mentionPickerItems.length > 0;
                      if (hashNavOpen) {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setHashPickIdx((i) => Math.min(hashCandidates.length - 1, i + 1));
                          return;
                        }
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setHashPickIdx((i) => Math.max(0, i - 1));
                          return;
                        }
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (hashPickerTab === 'task') {
                            const t = hashTaskCandidates[hashPickIdx];
                            if (t) applyHashChoice('task', t.id, t.title);
                          } else {
                            const d = hashDocCandidates[hashPickIdx];
                            if (d) applyHashChoice('collab_document', d.id, d.name);
                          }
                          return;
                        }
                        if (e.key === 'Tab' && !e.shiftKey) {
                          e.preventDefault();
                          if (hashPickerTab === 'task') {
                            const t = hashTaskCandidates[hashPickIdx];
                            if (t) applyHashChoice('task', t.id, t.title);
                          } else {
                            const d = hashDocCandidates[hashPickIdx];
                            if (d) applyHashChoice('collab_document', d.id, d.name);
                          }
                          return;
                        }
                      }
                      if (mentionNavOpen) {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setMentionPickIdx((i) =>
                            Math.min(mentionPickerItems.length - 1, i + 1)
                          );
                          return;
                        }
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setMentionPickIdx((i) => Math.max(0, i - 1));
                          return;
                        }
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          const pick = mentionPickerItems[mentionPickIdx];
                          if (pick?.kind === 'all') applyMentionAllChoice();
                          else if (pick?.kind === 'user') applyMentionChoice(pick.user);
                          return;
                        }
                        if (e.key === 'Tab' && !e.shiftKey) {
                          e.preventDefault();
                          const pick = mentionPickerItems[mentionPickIdx];
                          if (pick?.kind === 'all') applyMentionAllChoice();
                          else if (pick?.kind === 'user') applyMentionChoice(pick.user);
                          return;
                        }
                      }
                      if (e.key === 'Escape') {
                        if (hashPickerVisible && hashAnchorForPicker) {
                          e.preventDefault();
                          setHashSuppressKey(
                            `${hashAnchorForPicker.start}\t${hashAnchorForPicker.query}`
                          );
                          return;
                        }
                        if (mentionPickerVisible && mentionAnchorForPicker) {
                          e.preventDefault();
                          setMentionSuppressKey(
                            `${mentionAnchorForPicker.start}\t${mentionAnchorForPicker.query}`
                          );
                          return;
                        }
                        if (editingMessage) {
                          setEditingMessage(null);
                          setText('');
                          setComposerMentionPicks([]);
                        } else if (replyingTo) setReplyingTo(null);
                        return;
                      }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void sendMessage();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={`lc-composer-bar-icon-btn lc-composer-emoji-toggle${emojiOpen ? ' lc-composer-emoji-toggle--open' : ''}`}
                    onClick={() => setEmojiOpen((v) => !v)}
                    title="Смайлики"
                    aria-label="Смайлики"
                    aria-expanded={emojiOpen}
                  >
                    <span className="lc-composer-emoji-face" aria-hidden>
                      ☺
                    </span>
                  </button>
                  <button
                    type="button"
                    className="lc-composer-send-btn"
                    aria-label={editingMessage ? 'Сохранить' : 'Отправить'}
                    title={editingMessage ? 'Сохранить' : 'Отправить'}
                    onClick={() => void sendMessage()}
                  >
                    {editingMessage ? (
                      <svg
                        className="lc-composer-send-svg"
                        viewBox="0 0 24 24"
                        width="20"
                        height="20"
                        aria-hidden
                      >
                        <path
                          fill="currentColor"
                          d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"
                        />
                      </svg>
                    ) : (
                      <svg
                        className="lc-composer-send-svg"
                        viewBox="0 0 24 24"
                        width="22"
                        height="22"
                        aria-hidden
                      >
                        <path
                          fill="currentColor"
                          d="M12 4l-1.41 1.41L18.17 11H4v2h12.76l-5.58 5.59L12 20l8-8-8-8z"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              {messageUploadProgress != null && !editingMessage ? (
                <div className="lc-composer-upload-row composer-row">
                  <div className="lc-upload-progress-wrap" aria-hidden>
                    <div
                      className="lc-upload-progress-bar"
                      style={{ width: `${Math.round(messageUploadProgress * 100)}%` }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => messageUploadAbortRef.current?.abort()}
                    title="Отменить отправку"
                  >
                    Отмена
                  </button>
                </div>
              ) : null}
              {emojiOpen && (
                <div className="lc-emoji-panel" role="listbox" aria-label="Смайлики">
                  {CHAT_EMOJIS.map((em) => (
                    <button
                      key={em}
                      type="button"
                      className="lc-emoji-cell"
                      onClick={() => insertEmoji(em)}
                    >
                      {em}
                    </button>
                  ))}
                </div>
              )}
              </div>
            </div>
            )}
            {active.kind === 'group' && (
              <nav className="lc-mobile-group-dock" role="tablist" aria-label="Раздел группы">
                <button
                  type="button"
                  role="tab"
                  aria-selected={groupTab === 'chat'}
                  className={`lc-mobile-group-dock-btn${groupTab === 'chat' ? ' lc-mobile-group-dock-btn--active' : ''}`}
                  onClick={() => {
                    clearCollabOpenFromTasksSession(active.id);
                    setGroupTab('chat');
                  }}
                >
                  Чат
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={groupTab === 'collab'}
                  className={`lc-mobile-group-dock-btn${groupTab === 'collab' ? ' lc-mobile-group-dock-btn--active' : ''}`}
                  onClick={() => {
                    setCollabOpenedFromTasks(false);
                    setCollabReturnFocusTaskId(null);
                    clearCollabOpenFromTasksSession(active.id);
                    setGroupTab('collab');
                  }}
                >
                  Документы
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={groupTab === 'tasks'}
                  className={`lc-mobile-group-dock-btn${groupTab === 'tasks' ? ' lc-mobile-group-dock-btn--active' : ''}`}
                  onClick={() => {
                    clearCollabOpenFromTasksSession(active.id);
                    setGroupTab('tasks');
                  }}
                >
                  Задачи
                </button>
              </nav>
            )}
          </>
        )}
      </main>
      </div>

      <nav className="lc-mobile-bottom-nav" aria-label="Основные разделы">
        <button
          type="button"
          className={`lc-mobile-nav-item${!active ? ' lc-mobile-nav-item--active' : ''}`}
          onClick={() => {
            setActive(null);
            setMobileMoreOpen(false);
          }}
        >
          <span className="lc-mobile-nav-icon" aria-hidden>
            💬
          </span>
          <span className="lc-mobile-nav-label">Чаты</span>
        </button>
        <button
          type="button"
          className="lc-mobile-nav-item"
          onClick={() => {
            setModal('friends');
            setMobileMoreOpen(false);
          }}
        >
          <span className="lc-mobile-nav-icon lc-mobile-nav-icon--badged" aria-hidden>
            👥
            {friendRequestCount > 0 && (
              <span className="lc-mobile-nav-badge">
                {friendRequestCount > 9 ? '9+' : friendRequestCount}
              </span>
            )}
          </span>
          <span className="lc-mobile-nav-label">Коллеги</span>
        </button>
        <button
          type="button"
          className="lc-mobile-nav-item"
          onClick={() => {
            setModal('profile');
            setMobileMoreOpen(false);
          }}
        >
          <span className="lc-mobile-nav-icon" aria-hidden>
            👤
          </span>
          <span className="lc-mobile-nav-label">Профиль</span>
        </button>
        <button
          type="button"
          className={`lc-mobile-nav-item${mobileMoreOpen ? ' lc-mobile-nav-item--active' : ''}`}
          onClick={() => setMobileMoreOpen((o) => !o)}
        >
          <span className="lc-mobile-nav-icon" aria-hidden>
            ⋯
          </span>
          <span className="lc-mobile-nav-label">Ещё</span>
        </button>
      </nav>

      {mobileMoreOpen ? (
        <div
          className="lc-mobile-more-backdrop"
          role="presentation"
          onClick={() => setMobileMoreOpen(false)}
        >
          <div
            className="lc-mobile-more-sheet"
            role="dialog"
            aria-label="Дополнительные действия"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="lc-mobile-more-sheet-title">Группы и поиск</p>
            <button
              type="button"
              className="lc-mobile-more-sheet-btn primary"
              onClick={() => {
                setModal('createGroup');
                setMobileMoreOpen(false);
              }}
            >
              + Новая группа
            </button>
            <button
              type="button"
              className="lc-mobile-more-sheet-btn"
              onClick={() => {
                setModal('joinGroup');
                setMobileMoreOpen(false);
              }}
            >
              Войти в группу
            </button>
            <button
              type="button"
              className="lc-mobile-more-sheet-btn lc-invites-btn"
              onClick={() => {
                setModal('invites');
                setMobileMoreOpen(false);
              }}
            >
              Приглашения
              {inviteCount > 0 && (
                <span className="lc-invites-badge" aria-label={`Новых приглашений: ${inviteCount}`}>
                  {inviteCount > 99 ? '99+' : inviteCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className="lc-mobile-more-sheet-btn"
              onClick={() => {
                setGlobalSearchOpen(true);
                setGlobalSearchQ('');
                setGlobalSearchResults([]);
                setMobileMoreOpen(false);
              }}
            >
              Поиск по чатам
            </button>
            <button type="button" className="lc-mobile-more-sheet-close" onClick={() => setMobileMoreOpen(false)}>
              Закрыть
            </button>
          </div>
        </div>
      ) : null}

      {photoAnnotator && (
        <PhotoAnnotator
          imageSrc={photoAnnotator.src}
          fileName={photoAnnotator.fileName}
          onClose={closePhotoAnnotator}
          saveLabel={photoAnnotator.fromLightbox ? 'Добавить к сообщению' : 'Готово'}
          onSave={(file) => {
            if (photoAnnotator.composerIndex != null) {
              const idx = photoAnnotator.composerIndex;
              setComposerDropFiles((prev) => prev.map((f, j) => (j === idx ? file : f)));
              showToast('Фото обновлено');
            } else {
              setComposerDropFiles((prev) =>
                capComposerPhotoFiles(prev, [file], () =>
                  showToast(`Можно прикрепить не больше ${MAX_MESSAGE_PHOTOS} фотографий`)
                )
              );
              showToast('Фото с рисунком добавлено к сообщению');
            }
            closePhotoAnnotator();
          }}
        />
      )}

      {toast != null && (
        <div
          className={
            typeof toast === 'string'
              ? 'toast'
              : 'kind' in toast && toast.kind === 'message-card'
                ? 'toast toast--rich toast--msg-card'
                : 'toast toast--rich'
          }
          role="status"
          aria-live="polite"
        >
          {typeof toast === 'string' ? (
            toast
          ) : 'kind' in toast && toast.kind === 'message-card' ? (
            <>
              <div className="toast__chat">{toast.chatLabel}</div>
              <div className="toast__sender">{toast.senderLabel}</div>
              <div className="toast__preview">{toast.preview}</div>
            </>
          ) : 'title' in toast ? (
            <>
              <div className="toast__title">{toast.title}</div>
              {toast.subtitle ? <div className="toast__sub">{toast.subtitle}</div> : null}
            </>
          ) : null}
        </div>
      )}

      {exitChatModal && (
        <Modal
          title={
            exitChatModal.kind === 'leave-group' ? 'Покинуть группу' : 'Убрать чат из списка'
          }
          onClose={() => {
            setExitChatModal(null);
            setExitDeleteMyMessages(false);
          }}
          footer={
            <div className="row-actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                onClick={() => {
                  setExitChatModal(null);
                  setExitDeleteMyMessages(false);
                }}
              >
                Отмена
              </button>
              <button type="button" className="danger" onClick={() => void confirmExitChat()}>
                {exitChatModal.kind === 'leave-group' ? 'Покинуть' : 'Убрать из списка'}
              </button>
            </div>
          }
        >
          <p className="meta" style={{ marginTop: 0 }}>
            {exitChatModal.kind === 'leave-group' ? (
              <>
                Вы потеряете доступ к чату и совместным документам группы «
                {exitChatModal.groupName}».
              </>
            ) : (
              <>
                Чат с «{exitChatModal.peerName}» исчезнет из вашего списка. Открыть снова можно из
                списка коллег или когда придёт новое сообщение.
              </>
            )}
          </p>
          {exitChatModal.kind !== 'leave-group' && (
            <label style={{ marginTop: 12 }}>
              <input
                type="checkbox"
                checked={exitDeleteMyMessages}
                onChange={(e) => setExitDeleteMyMessages(e.target.checked)}
              />
              <span>
                Удалить свои сообщения: они исчезнут у вас и у собеседника в этом личном чате.
              </span>
            </label>
          )}
        </Modal>
      )}

      {modal === 'createGroup' && (
        <Modal title="Новая группа" onClose={() => setModal(null)}>
          <form
            noValidate
            onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const name = String(fd.get('name') || '').trim();
              if (!name) {
                showToast('Введите название группы');
                return;
              }
              try {
                await api('/api/groups', {
                  method: 'POST',
                  json: {
                    name,
                    password: fd.get('password') || undefined,
                  },
                });
                setModal(null);
                refreshLists();
              } catch (err) {
                showToast(err instanceof Error ? err.message : 'Не удалось создать группу');
              }
            }}
          >
            <div className="field">
              <label>Название</label>
              <input name="name" />
            </div>
            <div className="field">
              <label>Пароль входа (необязательно)</label>
              <input name="password" type="password" />
            </div>
            <button type="submit" className="primary">
              Создать
            </button>
          </form>
        </Modal>
      )}

      {modal === 'joinGroup' && (
        <Modal title="Войти в группу" onClose={() => setModal(null)}>
          <form
            noValidate
            onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const codeRaw = String(fd.get('joinCode') || '').trim();
              if (!codeRaw) {
                showToast('Укажите код присоединения');
                return;
              }
              try {
                const r = await api<{ ok: boolean; groupId: number }>('/api/groups/join', {
                  method: 'POST',
                  json: {
                    joinCode: codeRaw,
                    password: fd.get('password') || undefined,
                  },
                });
                setModal(null);
                await refreshLists();
                setActive({ kind: 'group', id: r.groupId });
              } catch (err) {
                showToast(err instanceof Error ? err.message : 'Не удалось войти');
              }
            }}
          >
            <div className="field">
              <label>Код присоединения</label>
              <input name="joinCode" placeholder="латиница, цифры, _ -" autoComplete="off" />
            </div>
            <div className="field">
              <label>Пароль чата (если установлен)</label>
              <input name="password" type="password" />
            </div>
            <button type="submit" className="primary">
              Войти
            </button>
          </form>
        </Modal>
      )}

      {modal === 'profile' && (
        <ProfileModal
          me={me}
          onClose={() => setModal(null)}
          onSaved={() => window.location.reload()}
          onMeUpdated={onMeUpdated}
          showToast={showToast}
        />
      )}

      {attachmentsModalOpen && active && (
        <Modal title="Вложения" onClose={() => setAttachmentsModalOpen(false)}>
          <div className="lc-attach-gallery">
            <div className="lc-attach-gallery-tabs lc-attach-gallery-tabs--row1" role="tablist" aria-label="Медиа">
              {(
                [
                  ['photos', 'Фотографии'],
                  ['video', 'Видео'],
                  ['music', 'Музыка'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={attachmentGalleryTab === id}
                  className={
                    attachmentGalleryTab === id ? 'lc-attach-tab lc-attach-tab--active' : 'lc-attach-tab'
                  }
                  onClick={() => setAttachmentGalleryTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="lc-attach-gallery-tabs lc-attach-gallery-tabs--row2" role="tablist" aria-label="Файлы и ссылки">
              {(
                [
                  ['files', 'Файлы'],
                  ['links', 'Ссылки'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={attachmentGalleryTab === id}
                  className={
                    attachmentGalleryTab === id ? 'lc-attach-tab lc-attach-tab--active' : 'lc-attach-tab'
                  }
                  onClick={() => setAttachmentGalleryTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {attachmentIndexLoading ? (
              <p className="meta lc-attach-gallery-body">Загрузка…</p>
            ) : !attachmentIndex ? (
              <p className="meta lc-attach-gallery-body">Нет данных</p>
            ) : attachmentGalleryTab === 'links' ? (
              <ul className="lc-attach-list lc-attach-gallery-body">
                {attachmentIndex.links.length === 0 ? (
                  <li className="meta">Нет ссылок в сообщениях</li>
                ) : (
                  attachmentIndex.links.map((l, i) => (
                    <li key={`${l.messageId}-${i}-${l.url.slice(0, 48)}`}>
                      <a href={l.url} target="_blank" rel="noopener noreferrer" className="lc-attach-link">
                        {l.url}
                      </a>
                      <div className="lc-attach-meta">
                        {new Date(l.messageCreatedAt).toLocaleString('ru-RU', {
                          timeZone: CHAT_TIMEZONE,
                        })}
                      </div>
                      {l.snippet ? <div className="lc-attach-snippet">{l.snippet}</div> : null}
                    </li>
                  ))
                )}
              </ul>
            ) : (
              <ul className="lc-attach-list lc-attach-gallery-body">
                {attachmentGalleryItems.length === 0 ? (
                  <li className="meta">Ничего не найдено в этой категории</li>
                ) : (
                  attachmentGalleryItems.map((a) => (
                      <li key={a.id} className="lc-attach-item">
                        {attachmentGalleryTab === 'photos' && (
                          <button
                            type="button"
                            className="lc-attach-thumb-wrap lc-chat-attach-img--clickable"
                            aria-label={a.fileName || 'Открыть фото'}
                            onClick={() =>
                              openAttachmentGalleryLightbox(attachmentGalleryItems, a.id)
                            }
                          >
                            <img src={resolveUrl(a.url)} alt="" className="lc-attach-thumb" />
                          </button>
                        )}
                        {attachmentGalleryTab === 'video' && (
                          <video src={resolveUrl(a.url)} controls className="lc-attach-video" />
                        )}
                        {attachmentGalleryTab === 'music' && (
                          <audio src={resolveUrl(a.url)} controls className="lc-attach-audio" />
                        )}
                        {attachmentGalleryTab === 'files' && (
                          <a
                            className="lc-chat-attach-link lc-attach-file-link"
                            href={resolveUrl(a.url)}
                            {...(!(ooChatEnabled && chatAttachmentSupportsOnlyOffice(a.fileName, a.mimeType))
                              ? { download: a.fileName }
                              : {})}
                            onClick={(e) => {
                              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                              if (ooChatEnabled && chatAttachmentSupportsOnlyOffice(a.fileName, a.mimeType)) {
                                e.preventDefault();
                                openChatAttachmentOnlyOffice(a.id, a.fileName, a.senderId);
                              }
                            }}
                          >
                            📎 {a.fileName}
                          </a>
                        )}
                        <div className="lc-attach-meta">
                          {new Date(a.createdAt).toLocaleString('ru-RU', {
                            timeZone: CHAT_TIMEZONE,
                          })}
                        </div>
                      </li>
                    ))
                )}
              </ul>
            )}
          </div>
        </Modal>
      )}

      {modal === 'friends' && <FriendsModal onClose={() => setModal(null)} onFriendsChanged={refreshFriendState} onOpenDm={async (peerId) => {
        const r = await api<{ id: number }>('/api/direct/open', { method: 'POST', json: { peerUserId: peerId } });
        setModal(null);
        await refreshLists();
        setActive({ kind: 'direct', id: r.id });
      }} />}

      {modal === 'invites' && (
        <InvitesModal
          onClose={() => setModal(null)}
          refresh={refreshLists}
          onInvitesChanged={setInviteCount}
        />
      )}
      {chatPickForCustomTab && (
        <Modal
          title={
            chatPickForCustomTab.moveFromTabId
              ? 'Переместить чат во вкладку'
              : 'Добавить чат во вкладку'
          }
          onClose={() => setChatPickForCustomTab(null)}
        >
          <p className="meta" style={{ marginTop: 0 }}>
            {chatPickForCustomTab.moveFromTabId ? (
              <>
                Чат будет убран из «
                {customChatTabs.find((x) => x.id === chatPickForCustomTab.moveFromTabId)?.name ??
                  'текущей вкладки'}
                » и добавлен в выбранную.
              </>
            ) : (
              <>Выберите вкладку. Если чат уже там — кнопка неактивна.</>
            )}{' '}
            Можно также перетащить чат за ⠿ на нужную вкладку; на «Группы» или «Личные» — убрать со всех своих
            вкладок.
          </p>
          <div className="lc-custom-tab-pick-list">
            {customChatTabs.map((t) => {
              const has = t.entries.some(
                (e) =>
                  e.kind === chatPickForCustomTab.kind && e.id === chatPickForCustomTab.id
              );
              const isSourceTab = chatPickForCustomTab.moveFromTabId === t.id;
              const disabled = isSourceTab || (!chatPickForCustomTab.moveFromTabId && has);
              return (
                <button
                  key={t.id}
                  type="button"
                  className="primary lc-custom-tab-pick-item"
                  disabled={disabled}
                  onClick={() => {
                    const { kind, id, moveFromTabId } = chatPickForCustomTab;
                    if (moveFromTabId && moveFromTabId !== t.id) {
                      removeChatFromCustomTab(moveFromTabId, kind, id);
                    }
                    addChatToCustomTab(t.id, kind, id);
                    setChatPickForCustomTab(null);
                    showToast(
                      moveFromTabId ? `Перемещено в «${t.name}»` : `Добавлено в «${t.name}»`
                    );
                  }}
                >
                  {t.name}
                  {isSourceTab ? ' (сейчас здесь)' : ''}
                  {!isSourceTab && has ? ' (уже есть — останется)' : ''}
                </button>
              );
            })}
          </div>
          {customChatTabs.length === 0 ? (
            <p className="error">Сначала создайте вкладку кнопкой «+» в списке чатов.</p>
          ) : null}
          <button type="button" style={{ marginTop: 12 }} onClick={() => setChatPickForCustomTab(null)}>
            Отмена
          </button>
        </Modal>
      )}

      {modal === 'pins' && active && (
        <Modal title="Закреплённые сообщения" onClose={() => setModal(null)}>
          {pins.length === 0 ? (
            <p className="meta">Нет закреплённых сообщений</p>
          ) : (
            <ul className="lc-pins-modal-list">
              {pins.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="lc-pins-modal-jump"
                    title="Перейти к сообщению"
                    onClick={() => {
                      setModal(null);
                      if (active.kind === 'group' && groupTab !== 'chat') {
                        setGroupTab('chat');
                      }
                      window.setTimeout(() => scrollToChatMessageOrLoad(p.id), 50);
                    }}
                  >
                    <span className="lc-pins-modal-jump-text">
                      <strong>{p.sender.displayName}</strong>
                      {': '}
                      {p.body?.trim() || 'вложение'}
                    </span>
                    <span className="meta lc-pins-modal-jump-hint">Перейти</span>
                  </button>
                  {canUnpinFromPinsModal() && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        void (async () => {
                          try {
                            await toggleMessagePin(p);
                          } catch (e) {
                            showToast(e instanceof Error ? e.message : 'Не удалось открепить');
                          }
                        })();
                      }}
                    >
                      Открепить
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}

      {modal === 'groupAdmin' && active?.kind === 'group' && (
        <GroupAdminModal
          groupId={active.id}
          onClose={() => setModal(null)}
          refresh={refreshLists}
          onDeleted={() => {
            setModal(null);
            setActive(null);
            void refreshLists();
          }}
          notify={showToast}
        />
      )}

      {modal === 'groupMod' && active?.kind === 'group' && (
        <GroupModModal
          groupId={active.id}
          members={members}
          me={me}
          role={activeGroup?.role || 'member'}
          createdById={activeGroup?.createdById}
          invitePolicy={(activeGroup?.invitePolicy as InvitePolicy) || 'all'}
          friendIds={friendIds}
          pendingFriendIn={pendingFriendIn}
          pendingFriendOut={pendingFriendOut}
          refreshFriends={refreshFriendState}
          onClose={() => setModal(null)}
          refresh={refreshGroupMembersAndLists}
          notify={showToast}
        />
      )}

      {modal === 'groupInviteMember' && active?.kind === 'group' && (
        <Modal title="Пригласить в группу" onClose={() => setModal(null)}>
          <InviteByTag
            groupId={active.id}
            onDone={() => {
              void refreshGroupMembersAndLists();
              setModal(null);
            }}
          />
        </Modal>
      )}

      {active?.kind === 'group' && wsLinkPickModal && (
        <Modal title="Связать сообщение" onClose={() => setWsLinkPickModal(null)}>
          <p className="meta lc-ws-link-pick-intro">
            Выберите задачу или документ для привязки к сообщению (вкладки ниже).
          </p>
          <div className="lc-hash-picker-tabs lc-ws-link-pick-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={
                wsLinkPickModal.tab === 'task'
                  ? 'lc-hash-picker-tab lc-hash-picker-tab--active'
                  : 'lc-hash-picker-tab'
              }
              onClick={() =>
                setWsLinkPickModal((cur) => (cur ? { ...cur, tab: 'task' } : cur))
              }
            >
              Задачи
            </button>
            <button
              type="button"
              role="tab"
              className={
                wsLinkPickModal.tab === 'document'
                  ? 'lc-hash-picker-tab lc-hash-picker-tab--active'
                  : 'lc-hash-picker-tab'
              }
              onClick={() =>
                setWsLinkPickModal((cur) => (cur ? { ...cur, tab: 'document' } : cur))
              }
            >
              Документы
            </button>
          </div>
          <div className="field">
            <label>Поиск по названию</label>
            <input
              value={wsLinkPickFilter}
              onChange={(e) => setWsLinkPickFilter(e.target.value)}
              placeholder="Начните вводить…"
              autoFocus
            />
          </div>
          <ul className="lc-ws-link-pick-list">
            {wsLinkPickModal.tab === 'task' ? (
              wsLinkPickTasksFiltered.length === 0 ? (
                <li className="meta">Нет подходящих задач</li>
              ) : (
                wsLinkPickTasksFiltered.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="lc-ws-link-pick-row"
                      onClick={() => {
                        void postWorkspaceLink(wsLinkPickModal.message, 'task', t.id);
                        setWsLinkPickModal(null);
                      }}
                    >
                      <div className="lc-ws-link-pick-title">
                        {t.boardHasPassword ? '🔒 ' : ''}
                        {t.title}
                      </div>
                      <div className="meta">{t.boardName}</div>
                    </button>
                  </li>
                ))
              )
            ) : wsLinkPickDocsFiltered.length === 0 ? (
              <li className="meta">Нет подходящих документов</li>
            ) : (
              wsLinkPickDocsFiltered.map((d) => (
                <li key={d.id} className="lc-ws-link-pick-doc-li">
                  <button
                    type="button"
                    className="lc-ws-link-pick-row lc-ws-link-pick-row--doc"
                    onClick={() => {
                      void postWorkspaceLink(wsLinkPickModal.message, 'collab_document', d.id);
                      setWsLinkPickModal(null);
                    }}
                  >
                    {d.previewImageUrl ? (
                      <img
                        className="lc-hash-doc-thumb"
                        src={resolveUrl(d.previewImageUrl)}
                        alt=""
                        aria-hidden
                      />
                    ) : null}
                    <div className="lc-ws-link-pick-row-text">
                      <div className="lc-ws-link-pick-title">
                        {d.hasPassword ? '🔒 ' : ''}
                        {d.name}
                      </div>
                      <div className="meta">
                        {d.docType === 'spreadsheet' ? 'Таблица' : d.imageDocument ? 'Фото' : 'Документ'}
                      </div>
                    </div>
                  </button>
                  {d.previewImageUrl ? (
                    <button
                      type="button"
                      className="lc-ws-link-pick-photo-btn"
                      title="Открыть фото"
                      aria-label="Открыть фото документа"
                      onClick={() => openSingleImageLightbox(resolveUrl(d.previewImageUrl!))}
                    >
                      🖼
                    </button>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </Modal>
      )}

      {globalSearchOpen && (
        <Modal
          title="Поиск по чатам"
          onClose={() => {
            setGlobalSearchOpen(false);
            setGlobalSearchQ('');
            setGlobalSearchResults([]);
          }}
        >
          <div className="field">
            <label>Запрос (от 2 символов)</label>
            <input
              value={globalSearchQ}
              onChange={(e) => setGlobalSearchQ(e.target.value)}
              placeholder="Текст в сообщениях…"
              autoFocus
            />
          </div>
          {globalSearchLoading && <p className="meta">Поиск…</p>}
          {!globalSearchLoading &&
            globalSearchQ.trim().length >= 2 &&
            globalSearchResults.length === 0 && <p className="meta">Ничего не найдено</p>}
          <ul
            className="lc-global-search-list"
            style={{ listStyle: 'none', padding: 0, maxHeight: '50vh', overflow: 'auto' }}
          >
            {globalSearchResults.map((row) => (
              <li
                key={row.message.id}
                style={{ borderBottom: '1px solid var(--border)', padding: '0.5rem 0' }}
              >
                <div className="meta">
                  {row.chatLabel} · {row.chatKind === 'group' ? 'группа' : 'личный'}
                </div>
                <div style={{ marginTop: 4 }}>{(row.message.body || '').slice(0, 220)}</div>
                <button
                  type="button"
                  className="primary"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    setGlobalSearchOpen(false);
                    setGlobalSearchQ('');
                    setGlobalSearchResults([]);
                    openAtMessageIdRef.current = row.message.id;
                    setActive({ kind: row.chatKind, id: row.chatId });
                    setGroupTab('chat');
                  }}
                >
                  Перейти
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {modal === 'groupAudit' && active?.kind === 'group' && (
        <GroupAuditModal groupId={active.id} onClose={() => setModal(null)} />
      )}

      {modal === 'groupAnnouncements' && active?.kind === 'group' && activeGroup && (
        <GroupAnnouncementsModal
          groupId={active.id}
          members={members}
          statsRefreshKey={announcementStatsRefreshKey}
          canCreate={!!canMod}
          canViewStats={!!canMod}
          currentUserId={me.id}
          userRole={activeGroup.role}
          onClose={() => {
            setModal(null);
            if (canMod) void markModAssignmentsSeen(active.id);
          }}
          onOpenLinkedTask={(taskId) => void openLinkedTaskFromChat(taskId)}
          onOpenImage={openAnnouncementImageLightbox}
          onOpenOnlyOffice={openAnnouncementAttachmentOnlyOffice}
          ooEnabled={!!ooChatEnabled}
        />
      )}

      {myAssignmentsOpen && active?.kind === 'group' && (
        <MyAssignmentsPanel
          groupId={active.id}
          open={myAssignmentsOpen}
          onClose={() => setMyAssignmentsOpen(false)}
          refreshKey={myAssignmentsRefreshKey}
          onOpenLinkedTask={(taskId) => {
            setMyAssignmentsOpen(false);
            void openLinkedTaskFromChat(taskId);
          }}
          onOpenImage={openAnnouncementImageLightbox}
          onOpenOnlyOffice={openAnnouncementAttachmentOnlyOffice}
          ooEnabled={!!ooChatEnabled}
          onUpdated={() => {
            setMyAssignmentsRefreshKey((k) => k + 1);
            void refreshAssignmentBadges();
            void api<GroupAnnouncement[]>(`/api/groups/${active.id}/announcements/my-assignments`)
              .then((rows) => setActiveAssignmentCount(Array.isArray(rows) ? rows.length : 0))
              .catch(() => setActiveAssignmentCount(0));
          }}
        />
      )}

      {readReceiptsModal && (
        <Modal title="Прочитано" onClose={() => setReadReceiptsModal(null)}>
          {readReceiptsModal.length === 0 ? (
            <p className="meta">Пока никто не прочитал.</p>
          ) : (
            <ul className="lc-read-receipts-list">
              {readReceiptsModal.map((rr) => (
                <li key={rr.id} className="lc-read-receipts-item">
                  <span className="lc-read-receipts-user">
                    {rr.avatarUrl ? (
                      <img className="lc-read-receipts-avatar" src={resolveUrl(rr.avatarUrl)} alt="" />
                    ) : (
                      <span className="lc-read-receipts-avatar lc-read-receipts-avatar--fallback">
                        {rr.displayName.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="lc-read-receipts-name">
                      {rr.displayName}
                      {rr.tag ? <span className="meta"> @{rr.tag}</span> : null}
                    </span>
                  </span>
                  <span className="lc-read-receipts-time">{formatReceiptWhen(rr.readAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}

      {announcementAckOpen && pendingAnnouncements.length > 0 && active?.kind === 'group' && (
        <AnnouncementAckModal
          announcements={pendingAnnouncements}
          onOpenLinkedTask={(taskId) => void openLinkedTaskFromChat(taskId)}
          onOpenImage={openAnnouncementImageLightbox}
          onOpenOnlyOffice={openAnnouncementAttachmentOnlyOffice}
          ooEnabled={!!ooChatEnabled}
          onResponded={(id) => {
            setPendingAnnouncements((prev) => {
              const next = prev.filter((a) => a.id !== id);
              if (next.length === 0) setAnnouncementAckOpen(false);
              return next;
            });
            setMyAssignmentsRefreshKey((k) => k + 1);
            void refreshAssignmentBadges();
            void api<GroupAnnouncement[]>(`/api/groups/${active.id}/announcements/my-assignments`)
              .then((rows) => setActiveAssignmentCount(Array.isArray(rows) ? rows.length : 0))
              .catch(() => setActiveAssignmentCount(0));
          }}
        />
      )}

      {imageLightbox && (
        <ChatImageLightbox
          items={imageLightbox.items}
          index={imageLightbox.index}
          onClose={() => setImageLightbox(null)}
          onIndexChange={(index) => setImageLightbox((prev) => (prev ? { ...prev, index } : null))}
          onAnnotate={() => {
            const item = imageLightbox.items[imageLightbox.index];
            if (!item) return;
            setImageLightbox(null);
            setPhotoAnnotator({
              src: item.url,
              fileName: item.alt || 'photo.png',
              fromLightbox: true,
            });
          }}
        />
      )}

      {attachmentOoViewer?.overlay && attachmentOoViewer.source === 'announcement' && (
        <div className="lc-doc-fullscreen-overlay" role="presentation">
          <Suspense fallback={<p className="meta lc-workspace-suspense">Загрузка просмотра…</p>}>
            <MessageAttachmentOoView
              attachmentId={attachmentOoViewer.attachmentId}
              fileName={attachmentOoViewer.fileName}
              ooMode={attachmentOoViewer.ooMode}
              attachmentSource="announcement"
              onBack={closeAnnouncementAttachmentOoOverlay}
            />
          </Suspense>
        </div>
      )}
      </div>
    </div>
  );
}

// =============================================================================
// Вспомогательные модалки и формы (не экспортируются; используются только в ChatApp)
// =============================================================================

/**
 * Унифицированное модальное окно: затемнение по клику, `role="dialog"`, стандартный футер «Закрыть».
 */
function Modal({
  title,
  children,
  onClose,
  footer,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
        {footer === undefined ? (
          <div className="row-actions">
            <button type="button" onClick={onClose}>
              Закрыть
            </button>
          </div>
        ) : (
          footer
        )}
      </div>
    </div>
  );
}

function ProfileModal({
  me,
  onClose,
  onSaved,
  onMeUpdated,
  showToast,
}: {
  me: User;
  onClose: () => void;
  /** Вызывается после успешного PATCH профиля (до `onSaved`). */
  onSaved: () => void;
  onMeUpdated?: (u: User) => void;
  showToast: (m: ToastPayload) => void;
}) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="Профиль" onClose={onClose}>
      <form
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setErr('');
          const fd = new FormData(e.currentTarget);
          const displayName = String(fd.get('displayName') || '').trim();
          const tag = String(fd.get('tag') || '').trim();
          const currentPassword = String(fd.get('currentPassword') || '');
          const newPassword = String(fd.get('newPassword') || '');
          const confirmPassword = String(fd.get('confirmPassword') || '');
          const wantPassword = !!(currentPassword || newPassword || confirmPassword);

          if (!displayName) {
            setErr('Введите отображаемое имя');
            return;
          }
          if (wantPassword) {
            if (!currentPassword || !newPassword) {
              setErr('Заполните текущий и новый пароль');
              return;
            }
            if (newPassword.length < 6) {
              setErr('Новый пароль должен быть не короче 6 символов');
              return;
            }
            if (newPassword !== confirmPassword) {
              setErr('Новый пароль и подтверждение не совпадают');
              return;
            }
          }

          setBusy(true);
          try {
            const out = new FormData();
            out.append('displayName', displayName);
            let updated = await apiForm<User>('/api/me', out, 'PATCH');

            const tagChanged = !!tag && tag.toLowerCase() !== (me.tag || '').toLowerCase();
            if (tagChanged) {
              updated = await api<User>('/api/me/tag', { method: 'PATCH', json: { tag } });
            }

            if (wantPassword) {
              await api('/api/me/password', {
                method: 'POST',
                json: { currentPassword, newPassword },
              });
            }

            onMeUpdated?.(updated);
            onSaved();
            showToast('Изменения профиля сохранены');
            onClose();
          } catch (er) {
            setErr(er instanceof Error ? er.message : 'Не удалось сохранить изменения');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label>Отображаемое имя</label>
          <input name="displayName" defaultValue={me.displayName} />
        </div>
        <div className="field">
          <label>
            Уникальный тег (3–32 символа: a–z, 0–9, _)
            <span className="meta" style={{ display: 'block', fontWeight: 'normal' }}>
              Один тег на всю систему — по нему вас однозначно находят среди коллег, в группах и в @упоминаниях. Регистр не важен.
            </span>
          </label>
          <input name="tag" defaultValue={me.tag} maxLength={32} />
        </div>

        <div className="lc-sidebar-divider" aria-hidden>
          —
        </div>
        <p className="meta" style={{ marginTop: 0 }}>
          Смена пароля (необязательно) — заполните поля ниже, только если хотите изменить пароль.
        </p>
        <div className="field">
          <label>Текущий пароль</label>
          <input name="currentPassword" type="password" autoComplete="current-password" />
        </div>
        <div className="field">
          <label>Новый пароль</label>
          <input name="newPassword" type="password" autoComplete="new-password" />
        </div>
        <div className="field">
          <label>Повторите новый пароль</label>
          <input name="confirmPassword" type="password" autoComplete="new-password" />
        </div>

        {err && <p className="error">{err}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Сохранение…' : 'Сохранить изменения'}
        </button>
      </form>
    </Modal>
  );
}

function FriendsModal({
  onClose,
  onOpenDm,
  onFriendsChanged,
}: {
  onClose: () => void;
  onOpenDm: (id: number) => void;
  onFriendsChanged?: () => void | Promise<void>;
}) {
  const [friendTag, setFriendTag] = useState('');
  const [friendErr, setFriendErr] = useState('');
  const [pending, setPending] = useState<{ incoming: User[]; outgoing: User[] }>({ incoming: [], outgoing: [] });
  const [friends, setFriends] = useState<User[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [f, p] = await Promise.all([
        api<User[]>('/api/friends'),
        api<{ incoming: User[]; outgoing: User[] }>('/api/friends/pending'),
      ]);
      if (!mountedRef.current) return;
      setFriends(f);
      setPending(p);
      setLoadErr('');
      void onFriendsChanged?.();
    } catch (er) {
      if (mountedRef.current) setLoadErr((er as Error).message || 'Ошибка загрузки');
    }
  }, [onFriendsChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal title="Коллеги" onClose={onClose}>
      <form
        className="field"
        onSubmit={async (e) => {
          e.preventDefault();
          setFriendErr('');
          const tag = friendTag.trim().replace(/^@+/, '');
          if (!tag) {
            setFriendErr('Введите тег');
            return;
          }
          try {
            await api('/api/friends/request', { method: 'POST', json: { tag } });
            setFriendTag('');
            void load();
          } catch (er) {
            setFriendErr((er as Error).message);
          }
        }}
      >
        <label>Добавить коллегу по тегу</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            value={friendTag}
            onChange={(e) => setFriendTag(e.target.value)}
            placeholder="@nickname или nickname"
            style={{ flex: 1, minWidth: 160 }}
          />
          <button type="submit" className="primary">
            Отправить заявку
          </button>
        </div>
        {friendErr && <p className="error">{friendErr}</p>}
        <p className="meta" style={{ marginBottom: 0 }}>
          Попросите у человека его тег (он указан в профиле). Символ @ можно не вводить.
        </p>
      </form>
      {loadErr && <p className="error">{loadErr}</p>}
      <h4>Входящие заявки</h4>
      <ul>
        {pending.incoming.map((u) => (
          <li key={u.id}>
            {u.displayName} <span className="meta">@{u.tag}</span>{' '}
            <button
              type="button"
              onClick={() =>
                api('/api/friends/accept', { method: 'POST', json: { fromTag: u.tag } })
                  .then(() => load())
                  .catch((er: Error) => setFriendErr(er.message))
              }
            >
              Принять
            </button>
            <button
              type="button"
              onClick={() =>
                api('/api/friends/reject', { method: 'POST', json: { fromTag: u.tag } })
                  .then(() => load())
                  .catch((er: Error) => setFriendErr(er.message))
              }
            >
              Отклонить
            </button>
          </li>
        ))}
      </ul>
      <h4>Исходящие заявки</h4>
      <ul>
        {pending.outgoing.map((u) => (
          <li key={u.id}>
            {u.displayName} <span className="meta">@{u.tag}</span>{' '}
            <button
              type="button"
              className="danger"
              onClick={() =>
                api('/api/friends/cancel', { method: 'POST', json: { userId: u.id } })
                  .then(() => load())
                  .catch((er: Error) => setFriendErr(er.message))
              }
            >
              Отменить
            </button>
          </li>
        ))}
      </ul>
      {pending.outgoing.length === 0 && <p className="meta">Нет исходящих заявок</p>}
      <h4>Коллеги</h4>
      <ul>
        {friends.map((u) => (
          <li key={u.id}>
            {u.displayName} @{u.tag}{' '}
            <button type="button" className="primary" onClick={() => onOpenDm(u.id)}>
              Личный чат
            </button>
            <button
              type="button"
              onClick={() =>
                api(`/api/friends/${u.id}`, { method: 'DELETE' })
                  .then(() => load())
                  .catch((er: Error) => setFriendErr(er.message))
              }
            >
              Удалить
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function InvitesModal({
  onClose,
  refresh,
  onInvitesChanged,
}: {
  onClose: () => void;
  refresh: () => void;
  onInvitesChanged?: (count: number) => void;
}) {
  type InviteRow = {
    id: number;
    group_id: number;
    group_name: string;
    has_password?: number;
  };
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<InviteRow[]>('/api/groups/invites/incoming')
      .then((r) => {
        if (!cancelled) {
          setRows(r);
          onInvitesChanged?.(Array.isArray(r) ? r.length : 0);
        }
      })
      .catch((er: Error) => {
        if (!cancelled) setErr(er.message || 'Ошибка загрузки');
      });
    return () => {
      cancelled = true;
    };
  }, [onInvitesChanged]);

  async function declineInvite(r: InviteRow) {
    setBusyId(r.id);
    setErr('');
    try {
      await api(`/api/groups/${r.group_id}/invites/decline`, { method: 'POST' });
      setRows((prev) => {
        const next = prev.filter((x) => x.id !== r.id);
        onInvitesChanged?.(next.length);
        return next;
      });
    } catch (er) {
      setErr((er as Error).message || 'Не удалось отклонить приглашение');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal title="Приглашения в группы" onClose={onClose}>
      {err && <p className="error">{err}</p>}
      <ul className="lc-invites-list">
        {rows.map((r) => (
          <li key={r.id} className="lc-invite-row">
            <span className="lc-invite-name">
              {r.group_name} {r.has_password ? '🔒' : ''}
            </span>
            <form
              className="lc-invite-actions"
              onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                setBusyId(r.id);
                setErr('');
                try {
                  await api(`/api/groups/${r.group_id}/invites/accept`, {
                    method: 'POST',
                    json: { password: fd.get('password') || undefined },
                  });
                  setRows((prev) => {
                    const next = prev.filter((x) => x.id !== r.id);
                    onInvitesChanged?.(next.length);
                    return next;
                  });
                  refresh();
                  onClose();
                } catch (er) {
                  setErr((er as Error).message || 'Не удалось принять приглашение');
                  setBusyId(null);
                }
              }}
            >
              {r.has_password ? (
                <input name="password" type="password" placeholder="пароль группы" />
              ) : null}
              <button type="submit" className="primary" disabled={busyId === r.id}>
                Принять
              </button>
              <button
                type="button"
                className="danger"
                disabled={busyId === r.id}
                onClick={() => void declineInvite(r)}
              >
                Отклонить
              </button>
            </form>
          </li>
        ))}
      </ul>
      {rows.length === 0 && !err && <p>Нет приглашений</p>}
    </Modal>
  );
}

type AuditLogRow = {
  id: number;
  createdAt: string;
  actor: User | null;
  action: string;
  meta: Record<string, unknown> | null;
};

type AuditLogFacets = {
  actors: User[];
  actions: string[];
};

async function downloadAdminExport(pathAndQuery: string, fallbackName: string) {
  const url = resolveUrl(pathAndQuery);
  const token = getToken();
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const t = await res.text();
    let msg = t;
    try {
      const j = JSON.parse(t) as { error?: string };
      msg = j.error || t;
    } catch {
      /* keep t */
    }
    throw new Error(msg || res.statusText);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition');
  let name = fallbackName;
  const m = cd?.match(/filename="([^"]+)"/);
  if (m?.[1]) name = m[1];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Человекочитаемые названия действий журнала аудита. */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  group_kick: 'Исключение участника',
  group_ban: 'Блокировка участника',
  group_unban: 'Снятие блокировки',
  group_role: 'Изменение роли',
  group_settings: 'Изменение настроек группы',
  group_delete: 'Удаление группы',
  audit_log_cleared: 'Очистка журнала аудита',
  chat_clear_all: 'Очистка истории чата у всех',
  chat_clear_own: 'Удаление своих сообщений',
  announcement_create: 'Создание объявления',
  announcement_delete: 'Удаление объявления',
  assignment_create: 'Создание назначения',
  assignment_progress: 'Обновление прогресса назначения',
  collab_folder_create: 'Создание папки документов',
  collab_folder_move: 'Перемещение папки',
  collab_folder_update: 'Изменение папки',
  collab_folder_delete: 'Удаление папки',
  collab_document_create: 'Создание документа',
  collab_document_import_yjs: 'Импорт документа',
  collab_document_move: 'Перемещение документа',
  collab_document_update: 'Изменение документа',
  collab_document_delete: 'Удаление документа',
  task_board_create: 'Создание доски задач',
  task_board_update: 'Изменение доски задач',
  task_board_delete: 'Удаление доски задач',
  task_create: 'Создание задачи',
  task_delete: 'Удаление задачи',
  task_attachment_upload: 'Загрузка вложения к задаче',
  task_board_canvas_file_upload: 'Загрузка файла на доску',
};

const GROUP_ROLE_LABELS: Record<string, string> = {
  member: 'Участник',
  moderator: 'Модератор',
  admin: 'Администратор',
};

function groupRoleLabel(role: string): string {
  return GROUP_ROLE_LABELS[role] ?? role;
}

const AUDIT_ROLE_LABELS: Record<string, string> = {
  member: 'участник',
  moderator: 'модератор',
  admin: 'администратор',
};

function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

/** Дата и время записи журнала: «ДД.ММ.ГГГГ Ч:ММ», МСК. */
function formatAuditWhen(iso: string): string {
  try {
    const parts = new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
      timeZone: CHAT_TIMEZONE,
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
  } catch {
    return iso;
  }
}

/**
 * Человекочитаемое описание записи аудита: подробности действия
 * (роль, кого коснулось, названия сущностей и т.п.).
 */
function describeAuditMeta(
  action: string,
  meta: Record<string, unknown> | null,
  nameFor: (id: number) => string
): string | null {
  if (!meta) return null;
  const target =
    typeof meta.targetUserName === 'string' && meta.targetUserName
      ? (meta.targetUserName as string)
      : typeof meta.targetUserId === 'number'
        ? nameFor(meta.targetUserId as number)
        : null;
  const name = typeof meta.name === 'string' ? (meta.name as string) : null;
  const title = typeof meta.title === 'string' ? (meta.title as string) : null;
  switch (action) {
    case 'group_role': {
      const role = typeof meta.role === 'string' ? AUDIT_ROLE_LABELS[meta.role] ?? meta.role : '';
      return `${target ?? 'Участник'} → роль: ${role}`;
    }
    case 'group_kick':
      return `Исключён: ${target ?? '—'}`;
    case 'group_unban':
      return `Разблокирован: ${target ?? '—'}`;
    case 'group_ban': {
      const until =
        typeof meta.until === 'string' && meta.until
          ? ` до ${formatAuditWhen(meta.until as string)}`
          : ' (бессрочно)';
      return `Заблокирован: ${target ?? '—'}${until}`;
    }
    case 'audit_log_cleared': {
      const n = typeof meta.deletedCount === 'number' ? meta.deletedCount : null;
      return n != null ? `Удалено записей: ${n}` : null;
    }
    case 'announcement_create':
    case 'announcement_delete':
      return null;
    case 'assignment_create': {
      const kind = typeof meta.kind === 'string' ? meta.kind : '';
      const kindRu =
        kind === 'assignment' ? 'быстрая задача' : kind === 'linked_task' ? 'задача с доски' : 'уведомление';
      const n =
        typeof meta.recipientCount === 'number' ? ` · ${meta.recipientCount} получ.` : '';
      return `${kindRu}${n}`;
    }
    case 'assignment_progress': {
      const st = typeof meta.taskStatus === 'string' ? meta.taskStatus : '';
      const pr = typeof meta.progress === 'number' ? `${meta.progress}%` : '';
      return [st, pr].filter(Boolean).join(' · ') || null;
    }
    case 'collab_folder_create':
    case 'collab_folder_update':
    case 'collab_folder_delete':
      return name ? `Папка: «${name}»` : null;
    case 'collab_document_create':
    case 'collab_document_update':
    case 'collab_document_delete':
    case 'collab_document_import_yjs':
      return name ? `Документ: «${name}»` : null;
    case 'task_board_create':
    case 'task_board_update':
    case 'task_board_delete':
      return name ? `Доска: «${name}»` : null;
    case 'task_create':
    case 'task_delete':
      return title ? `Задача: «${title}»` : null;
    default: {
      // Мягкий фолбэк: показать понятные пары ключ-значение, а не сырой JSON.
      const known = ['name', 'title', 'role', 'documentId', 'boardId', 'folderId'];
      const bits: string[] = [];
      for (const k of known) {
        if (meta[k] != null && typeof meta[k] !== 'object') bits.push(`${k}: ${String(meta[k])}`);
      }
      return bits.length ? bits.join(', ') : null;
    }
  }
}

function GroupAuditModal({ groupId, onClose }: { groupId: number; onClose: () => void }) {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [facets, setFacets] = useState<AuditLogFacets>({ actors: [], actions: [] });
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [clearBusy, setClearBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [actorId, setActorId] = useState<string>('');
  const [action, setAction] = useState<string>('');
  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(q.trim()), 320);
    return () => window.clearTimeout(t);
  }, [q]);

  const loadFacets = useCallback(() => {
    return api<AuditLogFacets>(`/api/groups/${groupId}/audit-log/facets`)
      .then((f) => {
        setFacets({
          actors: Array.isArray(f?.actors) ? f.actors : [],
          actions: Array.isArray(f?.actions) ? f.actions : [],
        });
      })
      .catch(() => {
        setFacets({ actors: [], actions: [] });
      });
  }, [groupId]);

  useEffect(() => {
    void loadFacets();
  }, [loadFacets]);

  useEffect(() => {
    setLoading(true);
    setActorId('');
    setAction('');
    setQ('');
    setQDebounced('');
  }, [groupId]);

  useEffect(() => {
    let cancelled = false;
    setErr('');
    const params = new URLSearchParams();
    params.set('limit', '500');
    if (actorId) params.set('actorUserId', actorId);
    if (action) params.set('action', action);
    if (qDebounced) params.set('q', qDebounced);
    api<AuditLogRow[]>(`/api/groups/${groupId}/audit-log?${params.toString()}`)
      .then((r) => {
        if (!cancelled) setRows(Array.isArray(r) ? r : []);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Ошибка загрузки');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, actorId, action, qDebounced]);

  const nameFor = useCallback(
    (id: number): string => {
      const fromFacet = facets.actors.find((u) => u.id === id);
      if (fromFacet) return fromFacet.displayName || fromFacet.username || `#${id}`;
      const fromRow = rows.find((r) => r.actor?.id === id)?.actor;
      if (fromRow) return fromRow.displayName || fromRow.username || `#${id}`;
      return `Пользователь #${id}`;
    },
    [facets.actors, rows]
  );

  function resetFilters() {
    setActorId('');
    setAction('');
    setQ('');
    setQDebounced('');
  }

  async function runExport(label: string, pathAndQuery: string, fallbackName: string) {
    setExportBusy(label);
    setErr('');
    try {
      await downloadAdminExport(pathAndQuery, fallbackName);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка выгрузки');
    } finally {
      setExportBusy(null);
    }
  }

  async function clearLog() {
    if (
      !(await uiConfirm(
        'Удалить все записи журнала аудита этой группы? Останется одна служебная запись о факте очистки.',
        { title: 'Очистка журнала', danger: true, okText: 'Очистить' }
      ))
    )
      return;
    setClearBusy(true);
    setErr('');
    try {
      await api<{ ok: boolean }>(`/api/groups/${groupId}/audit-log`, { method: 'DELETE' });
      resetFilters();
      await loadFacets();
      const r = await api<AuditLogRow[]>(`/api/groups/${groupId}/audit-log?limit=500`);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось очистить');
    } finally {
      setClearBusy(false);
    }
  }

  return (
    <Modal title="Журнал аудита" onClose={onClose}>
      <div className="lc-audit-toolbar" style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginBottom: '0.75rem' }}>
        <input
          type="search"
          placeholder="Поиск по типу действия и полям записи (JSON)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Поиск в журнале"
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <select
            style={{ minWidth: '10rem', flex: '1 1 8rem' }}
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            aria-label="Фильтр по пользователю"
          >
            <option value="">Все пользователи</option>
            {facets.actors.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.displayName || u.username || 'Участник'}
              </option>
            ))}
          </select>
          <select
            style={{ minWidth: '10rem', flex: '1 1 8rem' }}
            value={action}
            onChange={(e) => setAction(e.target.value)}
            aria-label="Фильтр по действию"
          >
            <option value="">Все действия</option>
            {facets.actions.map((a) => (
              <option key={a} value={a}>
                {auditActionLabel(a)}
              </option>
            ))}
          </select>
          <button type="button" onClick={resetFilters} disabled={!actorId && !action && !q}>
            Сбросить фильтры
          </button>
          <button type="button" className="danger" onClick={() => void clearLog()} disabled={clearBusy}>
            {clearBusy ? 'Очистка…' : 'Очистить журнал'}
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <span className="meta" style={{ width: '100%', marginBottom: '0.15rem' }}>
            Выгрузка для администратора
          </span>
          <button
            type="button"
            disabled={!!exportBusy}
            onClick={() =>
              void runExport(
                'json',
                `/api/groups/${groupId}/export/messages?format=json&limit=20000`,
                `group-${groupId}-messages.json`
              )
            }
          >
            {exportBusy === 'json' ? '…' : 'Сообщения (JSON)'}
          </button>
          <button
            type="button"
            disabled={!!exportBusy}
            onClick={() =>
              void runExport(
                'txt',
                `/api/groups/${groupId}/export/messages?format=txt&limit=20000`,
                `group-${groupId}-messages.txt`
              )
            }
          >
            {exportBusy === 'txt' ? '…' : 'Сообщения (текст)'}
          </button>
          <button
            type="button"
            disabled={!!exportBusy}
            onClick={() =>
              void runExport(
                'audit',
                `/api/groups/${groupId}/export/audit-log`,
                `group-${groupId}-audit.json`
              )
            }
          >
            {exportBusy === 'audit' ? '…' : 'Журнал аудита (JSON)'}
          </button>
          <button
            type="button"
            disabled={!!exportBusy}
            onClick={() =>
              void runExport(
                'bundle',
                `/api/groups/${groupId}/export/bundle?messageLimit=20000`,
                `group-${groupId}-archive.json`
              )
            }
          >
            {exportBusy === 'bundle' ? '…' : 'Архив группы (JSON)'}
          </button>
        </div>
      </div>
      {err ? <p className="error">{err}</p> : null}
      {loading ? <p className="meta">Загрузка…</p> : null}
      {!loading && !err && rows.length === 0 && <p className="meta">Записей не найдено</p>}
      <ul
        className="lc-audit-list"
        style={{ maxHeight: '50vh', overflow: 'auto', padding: 0, listStyle: 'none', margin: 0 }}
      >
        {rows.map((r) => {
          const detail = describeAuditMeta(r.action, r.meta, nameFor);
          return (
            <li key={r.id} style={{ borderBottom: '1px solid var(--border)', padding: '0.55rem 0' }}>
              <div className="lc-audit-line">
                <span className="lc-audit-action">{auditActionLabel(r.action)}</span>
                <span className="meta lc-audit-when">{formatAuditWhen(r.createdAt)}</span>
              </div>
              <div className="meta lc-audit-actor">
                {r.actor?.displayName ?? '—'}
                {r.actor?.tag ? <span> @{r.actor.tag}</span> : null}
              </div>
              {detail ? <div className="lc-audit-detail">{detail}</div> : null}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

function GroupAdminModal({
  groupId,
  onClose,
  refresh,
  onDeleted,
  notify,
}: {
  groupId: number;
  onClose: () => void;
  refresh: () => void | Promise<void>;
  onDeleted: () => void;
  notify: (msg: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<GroupSummary | null>(null);
  const [saveErr, setSaveErr] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<GroupSummary>(`/api/groups/${groupId}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  async function deleteGroup() {
    if (!detail?.isCreator || deleteBusy) return;
    const ok = await uiConfirm(
      `Удалить группу «${detail.name}» безвозвратно? Будут удалены чат, документы, доски задач и все вложения.`,
      { title: 'Удаление группы', danger: true, okText: 'Удалить группу' }
    );
    if (!ok) return;
    setDeleteBusy(true);
    setSaveErr('');
    try {
      await api(`/api/groups/${groupId}`, { method: 'DELETE' });
      notify('Группа удалена');
      onDeleted();
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : 'Не удалось удалить группу');
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <Modal title="Администрирование группы" onClose={onClose}>
      {loading && <p className="meta">Загрузка…</p>}
      {!loading && !detail && <p className="error">Не удалось загрузить настройки</p>}
      {!loading && detail && (
        <form
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setSaveErr('');
            const fd = new FormData(e.currentTarget);
            const nameVal = String(fd.get('name') || '').trim();
            try {
              await api(`/api/groups/${groupId}`, {
                method: 'PATCH',
                json: {
                  name: nameVal || undefined,
                  password: fd.get('password') || undefined,
                  clearPassword: fd.get('clearPassword') === 'on',
                  joinCode: String(fd.get('joinCode') ?? '').trim(),
                  forwardLocked: fd.get('forwardLocked') === 'on',
                  invitePolicy: String(fd.get('invitePolicy') || 'all'),
                },
              });
              await refresh();
              onClose();
            } catch (err) {
              setSaveErr(err instanceof Error ? err.message : 'Ошибка сохранения');
            }
          }}
        >
          <div className="field">
            <label>Название</label>
            <input name="name" defaultValue={detail.name} />
          </div>
          <div className="field">
            <label>Код присоединения (3–32 символа: латиница, цифры, _ -)</label>
            <input
              name="joinCode"
              defaultValue={detail.joinCode ?? ''}
              placeholder="Пусто — сбросить код"
              autoComplete="off"
            />
            <span className="meta" style={{ display: 'block', marginTop: 4 }}>
              Новые участники входят в группу только по этому коду.
            </span>
          </div>
          <div className="field">
            <label>
              <input type="checkbox" name="forwardLocked" defaultChecked={!!detail.forwardLocked} />{' '}
              Запретить пересылку сообщений из этого чата в другие
            </label>
          </div>
          <div className="field">
            <label>Кто может приглашать пользователей</label>
            <select
              name="invitePolicy"
              className="lc-select-field"
              defaultValue={detail.invitePolicy || 'all'}
            >
              <option value="admin_only">Только администратор</option>
              <option value="admin_moderator">Администратор и модератор</option>
              <option value="all">Все пользователи</option>
            </select>
          </div>
          <hr style={{ borderColor: 'var(--border)', margin: '1rem 0' }} />
          <div className="field">
            <label>Новый пароль входа в чат</label>
            <input name="password" type="password" autoComplete="new-password" />
          </div>
          <label>
            <input name="clearPassword" type="checkbox" /> Снять пароль входа
          </label>
          {saveErr && <p className="error">{saveErr}</p>}
          <button type="submit" className="primary" style={{ marginTop: 12 }}>
            Сохранить
          </button>
          {detail.isCreator && (
            <div className="lc-group-delete-zone">
              <hr style={{ borderColor: 'var(--border)', margin: '1.25rem 0 1rem' }} />
              <p className="meta" style={{ marginTop: 0 }}>
                Только создатель чата может удалить группу. Действие необратимо.
              </p>
              <button
                type="button"
                className="danger"
                disabled={deleteBusy}
                onClick={() => void deleteGroup()}
              >
                {deleteBusy ? 'Удаление…' : 'Удалить группу'}
              </button>
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}

function GroupModModal({
  groupId,
  members,
  me,
  role,
  createdById,
  invitePolicy,
  friendIds,
  pendingFriendIn,
  pendingFriendOut,
  refreshFriends,
  onClose,
  refresh,
  notify,
}: {
  groupId: number;
  members: User[];
  me: User;
  role: string;
  createdById?: number;
  invitePolicy: InvitePolicy;
  friendIds: Record<number, true>;
  pendingFriendIn: Record<number, true>;
  pendingFriendOut: Record<number, true>;
  refreshFriends: () => Promise<void>;
  onClose: () => void;
  refresh: () => Promise<void>;
  notify: (msg: string) => void;
}) {
  const [banRefresh, setBanRefresh] = useState(0);
  async function runModerationAction(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Ошибка запроса');
    }
  }

  return (
    <Modal title="Участники" onClose={onClose}>
      {canUseInviteInGroupMod(role, invitePolicy) && (
        <div className="field">
          <label>Пригласить по тегу</label>
          <InviteByTag
            groupId={groupId}
            onDone={() => refresh().catch(() => notify('Не удалось обновить список'))}
          />
        </div>
      )}
      <ul className="lc-group-mod-members">
        {members.map((u) => (
          <li key={u.id}>
            <div className="lc-group-mod-member-line">
              <span className="lc-group-mod-member-name">
                <strong>{u.displayName}</strong> @{u.tag}
                {createdById != null && u.id === createdById ? (
                  <span className="pill lc-group-creator-pill" title="Создатель чата">
                    создатель
                  </span>
                ) : null}{' '}
                ·{' '}
                {u.id !== me.id &&
                role === 'admin' &&
                !(createdById != null && u.id === createdById) ? (
                  <select
                    className="lc-group-mod-role-select"
                    value={u.role ?? 'member'}
                    aria-label={`Роль ${u.displayName}`}
                    onChange={(e) => {
                      const newRole = e.target.value;
                      if (newRole === u.role) return;
                      void runModerationAction(() =>
                        api(`/api/groups/${groupId}/role`, {
                          method: 'POST',
                          json: { userId: u.id, role: newRole },
                        })
                      );
                    }}
                  >
                    <option value="member">Участник</option>
                    <option value="moderator">Модератор</option>
                    <option value="admin">Администратор</option>
                  </select>
                ) : (
                  groupRoleLabel(u.role ?? 'member')
                )}
              </span>
              <span className="row-actions lc-group-mod-actions">
                {u.id !== me.id && friendIds[u.id] && (
                  <span className="lc-friend-badge" title="Уже в коллегах">
                    ✓ коллеги
                  </span>
                )}
                {u.id !== me.id && !friendIds[u.id] && pendingFriendIn[u.id] && (
                  <button
                    type="button"
                    className="primary lc-group-friend-btn"
                    onClick={async () => {
                      try {
                        await api('/api/friends/accept', { method: 'POST', json: { userId: u.id } });
                        await refreshFriends();
                        notify('Пользователь в коллегах');
                      } catch (e) {
                        notify(e instanceof Error ? e.message : 'Ошибка');
                      }
                    }}
                  >
                    Принять заявку
                  </button>
                )}
                {u.id !== me.id &&
                  !friendIds[u.id] &&
                  !pendingFriendIn[u.id] &&
                  pendingFriendOut[u.id] && (
                    <span className="meta lc-group-friend-pending">заявка отправлена</span>
                  )}
                {u.id !== me.id &&
                  !friendIds[u.id] &&
                  !pendingFriendIn[u.id] &&
                  !pendingFriendOut[u.id] && (
                    <button
                      type="button"
                      className="lc-group-friend-btn"
                      onClick={async () => {
                        try {
                          await api('/api/friends/request', { method: 'POST', json: { userId: u.id } });
                          await refreshFriends();
                          notify('Заявка отправлена');
                        } catch (e) {
                          notify(e instanceof Error ? e.message : 'Ошибка');
                        }
                      }}
                    >
                      В коллеги
                    </button>
                  )}
                {u.id !== me.id &&
                  role !== 'member' &&
                  !(createdById != null && u.id === createdById) &&
                  (u.role !== 'admin' || role === 'admin') && (
                  <>
                  <button
                    type="button"
                    onClick={() =>
                      runModerationAction(() =>
                        api(`/api/groups/${groupId}/kick`, { method: 'POST', json: { userId: u.id } })
                      )
                    }
                  >
                    Исключить
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={async () => {
                      const ok = await uiConfirm(
                        `Забанить ${u.displayName}? Пользователь будет исключён из группы и не сможет вернуться (по коду или приглашению), пока вы его не разбаните.`,
                        { title: 'Бан пользователя', danger: true, okText: 'Забанить' }
                      );
                      if (!ok) return;
                      await runModerationAction(() =>
                        api(`/api/groups/${groupId}/ban`, { method: 'POST', json: { userId: u.id } })
                      );
                      setBanRefresh((n) => n + 1);
                    }}
                  >
                    Бан
                  </button>
                </>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {role !== 'member' && (
        <GroupBannedSection groupId={groupId} notify={notify} refreshKey={banRefresh} />
      )}
    </Modal>
  );
}

function GroupBannedSection({
  groupId,
  notify,
  refreshKey,
}: {
  groupId: number;
  notify: (msg: string) => void;
  refreshKey: number;
}) {
  const [rows, setRows] = useState<(User & { bannedAt?: string })[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<(User & { bannedAt?: string })[]>(`/api/groups/${groupId}/bans`);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось загрузить список забаненных');
    } finally {
      setLoaded(true);
    }
  }, [groupId, notify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <div className="lc-group-banned-section">
      <h4>Забаненные пользователи</h4>
      {loaded && rows.length === 0 && <p className="meta">Нет забаненных пользователей</p>}
      <ul className="lc-group-mod-members">
        {rows.map((u) => (
          <li key={u.id}>
            <div className="lc-group-mod-member-line">
              <span>
                <strong>{u.displayName}</strong> @{u.tag}
              </span>
              <span className="row-actions lc-group-mod-actions">
                <button
                  type="button"
                  disabled={busyId === u.id}
                  onClick={async () => {
                    setBusyId(u.id);
                    try {
                      await api(`/api/groups/${groupId}/unban`, {
                        method: 'POST',
                        json: { userId: u.id },
                      });
                      setRows((prev) => prev.filter((x) => x.id !== u.id));
                      notify('Пользователь разбанен');
                    } catch (e) {
                      notify(e instanceof Error ? e.message : 'Не удалось разбанить');
                    } finally {
                      setBusyId(null);
                    }
                  }}
                >
                  Разбанить
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InviteByTag({ groupId, onDone }: { groupId: number; onDone: () => void }) {
  const [tag, setTag] = useState('');
  const [err, setErr] = useState('');
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="@nickname или nickname"
          style={{ flex: 1, minWidth: 160 }}
        />
        <button
          type="button"
          className="primary"
          onClick={async () => {
            setErr('');
            const t = tag.trim().replace(/^@+/, '');
            if (!t) {
              setErr('Введите тег');
              return;
            }
            try {
              await api(`/api/groups/${groupId}/invite`, { method: 'POST', json: { tag: t } });
              onDone();
              setTag('');
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Пригласить
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
