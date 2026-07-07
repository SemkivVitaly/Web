/**
 * @fileoverview Доменные типы ответов REST и состояния UI: пользователи, сообщения, группы, коллаб, задачи, канбан.
 * Согласованы с сериализацией в `routes.js` / `workspaceRoutes.js` и с нормализацией на клиенте (`chat/messageNormalize`, `ChatApp`).
 */

export type User = {
  id: number;
  username: string;
  displayName: string;
  tag: string;
  bio?: string;
  avatarUrl: string | null;
  createdAt?: string;
  /** В списке участников группы */
  role?: string;
  banned?: boolean;
};

export type Attachment = {
  id: number;
  url: string;
  thumbUrl?: string | null;
  fileName: string;
  mimeType: string;
  kind: string;
  transcript: string | null;
};

export type MessageReplyTo = {
  id: number;
  sender: User;
  bodyPreview: string;
  hasAttachments: boolean;
};

/** Одна строка в блоке «переслано» (без id исходного сообщения в новом чате) */
export type MessageForwardFrom = {
  sender: User;
  bodyPreview: string;
  hasAttachments: boolean;
};

export type MessageReactionGroup = {
  emoji: string;
  users: User[];
};

/** Связь сообщения группового чата с задачей или документом коллаба */
export type MessageWorkspaceLink = {
  id: number;
  kind: 'task' | 'collab_document';
  entityId: number;
  title: string;
};

export type Message = {
  id: number;
  groupId?: number | null;
  directId?: number | null;
  /** Служебная строка группы (вход/выход) — в UI не как обычное сообщение */
  chatEvent?: 'member_join' | 'member_leave';
  sender: User;
  body: string;
  pinnedAt: string | null;
  createdAt: string;
  editedAt?: string | null;
  replyTo?: MessageReplyTo | null;
  /** Пересланные фрагменты (как цитаты), порядок — хронологический */
  forwardFrom?: MessageForwardFrom[] | null;
  reactions?: MessageReactionGroup[];
  importantForMe?: boolean;
  /** Только групповой чат; приходит с API и обновляется по сокету */
  workspaceLinks?: MessageWorkspaceLink[];
  attachments: Attachment[];
  mentionUserIds: number[];
  /** Только для исходящих сообщений текущего пользователя: прочитано адресатами */
  outboundRead?: { read: boolean; readAt: string | null };
  /** Корень треда ответов (null — не в треде или корневое сообщение треда) */
  threadRootId?: number | null;
};

export type InvitePolicy = 'admin_only' | 'admin_moderator' | 'all';

export type GroupSummary = {
  id: number;
  name: string;
  hasPassword: boolean;
  role: string;
  createdAt: string;
  forwardLocked?: boolean;
  invitePolicy?: InvitePolicy;
  /** Только у администратора в ответе API */
  joinCode?: string | null;
  /** Краткий текст последнего сообщения для списка чатов */
  lastMessagePreview?: string | null;
  lastMessageAt?: string | null;
};

export type DirectSummary = {
  id: number;
  peer: User;
  createdAt: string;
  lastMessagePreview?: string | null;
  lastMessageAt?: string | null;
};

export type ChatPref = {
  user_id: number;
  chat_kind: 'group' | 'direct';
  chat_id: number;
  pinned_list: number;
  favorite: number;
  /** 1 — не показывать тосты для этого чата */
  mute_notifications?: number;
  /** 1 — личный чат скрыт из бокового списка (только у вас) */
  hidden?: number;
  last_read_message_id?: number | null;
  last_read_at?: string | null;
};

/** Ответ GET …/chat-attachments */
export type ChatAttachmentIndexItem = {
  id: number;
  messageId: number;
  /** Автор сообщения с вложением — для режима редактирования в OnlyOffice */
  senderId: number;
  createdAt: string;
  fileName: string;
  mimeType: string;
  kind: string;
  url: string;
};

export type ChatLinkIndexItem = {
  url: string;
  messageId: number;
  messageCreatedAt: string;
  snippet: string;
};

export type CollabFolderSummary = {
  id: number;
  parentId: number | null;
  name: string;
  hasPassword: boolean;
  /** Меняется при смене пароля — для сброса сохранённого пароля в браузере */
  passwordFingerprint?: string | null;
  createdById: number;
  createdAt: string;
  updatedAt: string;
};

export type CollabDocSummary = {
  id: number;
  /** Папка документа; null/отсутствует — корень группы */
  folderId?: number | null;
  name: string;
  /** Краткое описание (не тело документа) */
  description?: string;
  docType: 'richtext' | 'spreadsheet';
  hasPassword: boolean;
  passwordFingerprint?: string | null;
  updatedAt: string;
  createdById: number;
};

export type TaskBoardSummary = {
  id: number;
  name: string;
  hasPassword: boolean;
  /** Отпечаток хеша пароля — для сброса сохранённого пароля при смене */
  passwordFingerprint?: string | null;
  createdAt: string;
  createdById: number;
};

export type TaskActivityEntry = {
  id: number;
  action: string;
  payload: Record<string, unknown>;
  createdAt: string;
  author: User;
};

export type TaskNode = {
  id: number;
  boardId: number;
  parentId: number | null;
  title: string;
  description: string;
  status: string;
  /** Собственный % (слайдер или счётчик done/target) */
  progress: number;
  /** Цель по количеству (null — обычный прогресс слайдером) */
  quantityTarget: number | null;
  quantityDone: number;
  createdById: number | null;
  /** С учётом подзадач: min(свой %, минимум среди детей) */
  effectiveProgress: number;
  assigneeId: number | null;
  assignee: User | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** Вложенность при ответе API дерева задач */
  children?: TaskNode[];
};

export type TaskCanvasItem = {
  id: number;
  boardId: number;
  kind: 'folder' | 'task' | 'upload' | 'collab_doc' | 'link';
  title: string;
  taskId: number | null;
  collabDocumentId: number | null;
  fileUrl: string | null;
  fileName: string | null;
  fileMime: string | null;
  linkUrl: string | null;
  parentItemId: number | null;
  positionX: number;
  positionY: number;
  zIndex: number;
  pinned: boolean;
  width: number;
  height: number;
  createdById: number;
  updatedAt: string;
  displayTitle: string;
  previewLine: string;
  taskPreview: { description: string; status: string; progress: number } | null;
  docPreview: { description: string; docType: string } | null;
  isImage: boolean;
};

export type CollabDocPickerRow = {
  id: number;
  folderId: number | null;
  name: string;
  docType: 'richtext' | 'spreadsheet';
  hasPassword?: boolean;
  passwordFingerprint?: string | null;
};

/** Уведомления и назначения группы (re-export из chat/AnnouncementModals). */
export type {
  AnnouncementKind,
  AnnouncementAudience,
  AnnouncementAttachment,
  LinkedTaskSnapshot,
  ProgressLogEntry,
  GroupAnnouncement,
  AnnouncementStatsMember,
  AnnouncementStats,
} from './chat/AnnouncementModals';
