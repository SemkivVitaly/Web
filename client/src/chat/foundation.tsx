/**
 * @fileoverview Общая «фундаментальная» логика клиентского чата LocalChat.
 *
 * Сюда вынесено из `ChatApp` всё, что не привязано к одному экрану:
 * - персистенция навигации и кастомных вкладок в `localStorage`;
 * - сессионные флаги перехода «задачи → документ»;
 * - синхронизация комнат Socket.IO с перечнем чатов;
 * - уведомления (ОС, звук);
 * - разбор drag-and-drop чатов на вкладки;
 * - время и таймлайн ленты (МСК, разделители дней, маркер «новые»);
 * - галерея вложений, превью строки, галочки прочтения;
 * - парсинг `@` и `#` в композере;
 * - SVG-иконки меню сообщений и заголовка;
 * - мелкие UI-компоненты (звезда избранного).
 *
 * API маршрутов здесь нет — только типы из `../types` и чистые функции / презентация.
 */

import type { ReactNode, SVGProps } from 'react';
import type { Socket } from 'socket.io-client';
import type {
  Message,
  GroupSummary,
  DirectSummary,
  ChatPref,
  ChatAttachmentIndexItem,
  InvitePolicy,
} from '../types';

/** Текущий выбранный чат в сайдбаре: группа или личный диалог. */
export type Active = { kind: 'group' | 'direct'; id: number };

/** Подвкладка внутри группы: лента, совместные документы или задачи. */
export type GroupTab = 'chat' | 'collab' | 'tasks';

/** Ключ localStorage для сохранения последнего чата и вкладок (на пользователя). */
const navStateKey = (userId: number) => `localchat_nav_v1_u${userId}`;

/**
 * Снимок навигации, сериализуемый в JSON и кладущийся в `localStorage`.
 * Восстанавливается при следующем входе того же пользователя.
 */
export type NavPersist = {
  active: Active | null;
  groupTab: GroupTab;
  /** Идентификатор вкладки списка чатов: `'groups' | 'directs'` или id кастомной вкладки. */
  sidebarChatTab: string;
};

/**
 * Читает сохранённую навигацию для `userId`. При битом JSON или отсутствии ключа — безопасные значения по умолчанию.
 *
 * @param userId — id текущего пользователя (из `/api/me`)
 */
export function loadNavState(userId: number): NavPersist {
  try {
    const raw = localStorage.getItem(navStateKey(userId));
    if (!raw) return { active: null, groupTab: 'chat', sidebarChatTab: 'groups' };
    const o = JSON.parse(raw) as Record<string, unknown>;
    let active: Active | null = null;
    const ac = o?.active;
    if (ac && typeof ac === 'object') {
      const k = (ac as { kind?: unknown }).kind;
      const id = (ac as { id?: unknown }).id;
      if ((k === 'group' || k === 'direct') && typeof id === 'number' && Number.isFinite(id)) {
        active = { kind: k, id };
      }
    }
    const gt = o?.groupTab;
    const groupTab: GroupTab =
      gt === 'collab' || gt === 'tasks' || gt === 'chat' ? gt : 'chat';
    const sct = o?.sidebarChatTab;
    const sidebarChatTab = typeof sct === 'string' && sct.length > 0 ? sct : 'groups';
    return { active, groupTab, sidebarChatTab };
  } catch {
    return { active: null, groupTab: 'chat', sidebarChatTab: 'groups' };
  }
}

/**
 * Сохраняет навигацию в `localStorage`. Ошибки квоты/приватного режима глотаются.
 */
export function saveNavState(userId: number, n: NavPersist) {
  try {
    localStorage.setItem(navStateKey(userId), JSON.stringify(n));
  } catch {
    /* ignore */
  }
}

/**
 * Ключ `sessionStorage` для «открыт документ с доски задач» в рамках одной группы.
 * Нужен, чтобы после F5 или смены вкладки восстановить сценарий «назад на задачи».
 */
export function collabFromTasksSessionKey(groupId: number) {
  return `lc-collab-open-from-tasks-${groupId}`;
}

/**
 * Читает из сессии id открытого документа и опционально id задачи для фокуса в списке.
 *
 * @returns `null`, если записи нет или JSON некорректен
 */
export function readCollabOpenFromTasksSession(groupId: number): { docId: number; taskId: number | null } | null {
  try {
    const raw = sessionStorage.getItem(collabFromTasksSessionKey(groupId));
    if (!raw) return null;
    const o = JSON.parse(raw) as { docId?: unknown; taskId?: unknown };
    const docId = typeof o.docId === 'number' ? o.docId : Number(o.docId);
    if (!Number.isFinite(docId)) return null;
    let taskId: number | null = null;
    if (o.taskId != null) {
      const t = typeof o.taskId === 'number' ? o.taskId : Number(o.taskId);
      taskId = Number.isFinite(t) ? t : null;
    }
    return { docId, taskId };
  } catch {
    return null;
  }
}

/** Записывает контекст «документ открыт из задач» в `sessionStorage`. */
export function writeCollabOpenFromTasksSession(groupId: number, docId: number, taskId: number | null) {
  try {
    sessionStorage.setItem(collabFromTasksSessionKey(groupId), JSON.stringify({ v: 1, docId, taskId }));
  } catch {
    /* ignore */
  }
}

/** Удаляет сессионный маркер для группы (после выхода из документа «обычным» путём). */
export function clearCollabOpenFromTasksSession(groupId: number) {
  try {
    sessionStorage.removeItem(collabFromTasksSessionKey(groupId));
  } catch {
    /* ignore */
  }
}

/**
 * Данные для тоста внизу экрана: простая строка, заголовок+подзаголовок или «карточка» входящего сообщения.
 */
export type ToastPayload =
  | string
  | { title: string; subtitle?: string }
  | {
      kind: 'message-card';
      chatLabel: string;
      senderLabel: string;
      preview: string;
    };

/**
 * Показывает нативное уведомление ОС (если разрешение `granted`). Используется для упоминаний и сообщений в фоне.
 * Тег дедуплицирует повторные уведомления с тем же чатом.
 */
export function tryOsMessageNotification(p: {
  chatLabel: string;
  senderLabel: string;
  preview: string;
  tag: string;
}) {
  if (typeof window === 'undefined') return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const preview = p.preview.replace(/\s+/g, ' ').trim().slice(0, 280);
  const body = `${p.senderLabel}: ${preview}`;
  try {
    const n = new Notification(p.chatLabel, { body, tag: p.tag });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    setTimeout(() => n.close(), 12000);
  } catch {
    /* ignore */
  }
}

/** Один общий `AudioContext` на вкладку — переиспользуется всеми звуковыми пингами. */
let notifyAudioCtx: AudioContext | null = null;

/**
 * Короткий синтезированный звук входящего события (Web Audio API, без mp3).
 *
 * @param kind — `mention`: двухтональный сигнал; `message`: один тон
 */
export function playChatNotifySound(kind: 'message' | 'mention') {
  if (typeof window === 'undefined') return;
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!notifyAudioCtx) notifyAudioCtx = new AC();
    const ctx = notifyAudioCtx;
    void ctx.resume();
    const t0 = ctx.currentTime;
    const tone = (offset: number, f0: number, f1: number, peak: number) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.connect(g);
      g.connect(ctx.destination);
      const t = t0 + offset;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + 0.07);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.start(t);
      osc.stop(t + 0.24);
    };
    if (kind === 'mention') {
      tone(0, 880, 1180, 0.11);
      tone(0.13, 1180, 1568, 0.09);
    } else {
      tone(0, 523, 784, 0.085);
    }
  } catch {
    /* ignore */
  }
}

/** Ключ `localStorage` для массива пользовательских вкладок чатов (v1 схема). */
export const CUSTOM_CHAT_TABS_KEY = 'localchat_custom_chat_tabs_v1';

/**
 * MIME-тип для `dataTransfer` при перетаскивании чата на полоску вкладок «Группы / Личные / …».
 */
export const CHAT_TAB_DND_MIME = 'application/x-localchat-tab-chat';

/**
 * Разбирает payload drag-and-drop чата, положенный в {@link CHAT_TAB_DND_MIME}.
 *
 * @returns `null`, если данных нет или формат неверный
 */
export function parseTabChatDrag(dt: DataTransfer | null): {
  kind: 'group' | 'direct';
  id: number;
  fromTabId?: string;
} | null {
  if (!dt) return null;
  try {
    const raw = dt.getData(CHAT_TAB_DND_MIME);
    if (!raw) return null;
    const o = JSON.parse(raw) as { kind?: string; id?: unknown; fromTabId?: string };
    const id = typeof o.id === 'number' ? o.id : Number(o.id);
    if ((o.kind !== 'group' && o.kind !== 'direct') || !Number.isFinite(id)) return null;
    return { kind: o.kind, id, fromTabId: o.fromTabId };
  } catch {
    return null;
  }
}

/**
 * Синхронизирует подписки сокета `join`/`leave` с актуальными списками групп и личных чатов.
 * Без этого сервер рассылает `message:new` только для «открытой» комнаты.
 *
 * @param s — подключённый клиент Socket.IO
 * @param prev — предыдущий набор id; для id, выпавших из списков, шлётся `leave`
 * @returns новый снимок множеств id для следующего вызова
 */
export function syncSocketChatRooms(
  s: Socket,
  groups: GroupSummary[],
  directs: DirectSummary[],
  prev: { g: Set<number>; d: Set<number> } | null
): { g: Set<number>; d: Set<number> } {
  if (!s.connected) return prev ?? { g: new Set(), d: new Set() };
  const gIds = new Set(groups.map((x) => x.id));
  const dIds = new Set(directs.map((x) => x.id));
  if (prev) {
    for (const id of prev.g) {
      if (!gIds.has(id)) s.emit('leave', { kind: 'group', id });
    }
    for (const id of prev.d) {
      if (!dIds.has(id)) s.emit('leave', { kind: 'direct', id });
    }
  }
  for (const id of gIds) s.emit('join', { kind: 'group', id });
  for (const id of dIds) s.emit('join', { kind: 'direct', id });
  return { g: gIds, d: dIds };
}

/** Пользовательская вкладка в сайдбаре: имя и список чатов (группа/личка). */
export type CustomChatTab = {
  id: string;
  name: string;
  entries: { kind: 'group' | 'direct'; id: number }[];
};

/**
 * Загружает кастомные вкладки из `localStorage`. Невалидные элементы массива отфильтровываются.
 */
export function loadCustomChatTabs(): CustomChatTab[] {
  try {
    const r = localStorage.getItem(CUSTOM_CHAT_TABS_KEY);
    if (!r) return [];
    const p = JSON.parse(r) as unknown;
    if (!Array.isArray(p)) return [];
    return p.filter(
      (x: unknown) =>
        x &&
        typeof x === 'object' &&
        typeof (x as CustomChatTab).id === 'string' &&
        typeof (x as CustomChatTab).name === 'string' &&
        Array.isArray((x as CustomChatTab).entries)
    ) as CustomChatTab[];
  } catch {
    return [];
  }
}

/**
 * Кнопка «звезда» избранного у строки чата в сайдбаре.
 */
export function ChatFavStarButton({
  favorited,
  onClick,
}: {
  favorited: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`lc-chat-fav-star${favorited ? ' lc-chat-fav-star--on' : ''}`}
      title={favorited ? 'Убрать из избранного' : 'В избранное'}
      onClick={onClick}
    >
      ★
    </button>
  );
}

/**
 * Проверяет, выключены ли push-уведомления для конкретного чата в prefs.
 */
export function isChatMutedPrefs(prefs: ChatPref[], kind: 'group' | 'direct', id: number) {
  const p = prefs.find((x) => x.chat_kind === kind && x.chat_id === id);
  return (p?.mute_notifications ?? 0) === 1;
}

/** Вкладки модалки «вложения»: фото, видео, музыка, файлы; `links` обрабатывается отдельно. */
export type AttachmentGalleryTab = 'photos' | 'video' | 'music' | 'files' | 'links';

/**
 * Подходит ли вложение под выбранную вкладку галереи (по `kind` и `mimeType`).
 */
export function attachmentMatchesGalleryTab(tab: AttachmentGalleryTab, a: ChatAttachmentIndexItem) {
  if (tab === 'links') return false;
  const mt = a.mimeType || '';
  if (tab === 'photos') return a.kind === 'image' || mt.startsWith('image/');
  if (tab === 'video') return a.kind === 'video' || mt.startsWith('video/');
  if (tab === 'music')
    return a.kind === 'audio' || a.kind === 'voice' || mt.startsWith('audio/');
  if (tab === 'files') return a.kind === 'file';
  return false;
}

/**
 * Подсвечивает в тексте все вхождения поискового запроса тегами `<mark>`.
 *
 * @param body — полный текст сообщения
 * @param q — подстрока поиска (без regex)
 */
export function messageBodyWithSearchMarks(body: string, q: string): ReactNode {
  const needle = q.trim();
  if (!needle) return body;
  const lower = body.toLowerCase();
  const n = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  let k = 0;
  while (start < body.length) {
    const found = lower.indexOf(n, start);
    if (found < 0) {
      parts.push(body.slice(start));
      break;
    }
    if (found > start) parts.push(body.slice(start, found));
    const slice = body.slice(found, found + needle.length);
    parts.push(
      <mark key={`m-${found}-${k++}`} className="lc-search-mark">
        {slice}
      </mark>
    );
    start = found + needle.length;
  }
  return <>{parts}</>;
}

/**
 * Одна строка превью для списка чатов: обрезанный текст или подпись про вложения.
 */
export function previewMessageLine(m: Message) {
  const t = (m.body ?? '').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 120);
  if (m.attachments?.length)
    return m.attachments.length > 1 ? `${m.attachments.length} вложения` : 'Вложение';
  return 'Сообщение';
}

/** Часовой пояс для разделителей дней и часов в ленте (фиксированно МСК). */
export const CHAT_TIMEZONE = 'Europe/Moscow';

/** Дата сообщения в формате `YYYY-MM-DD` по календарю МСК. */
export function isoToMoscowYmd(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: CHAT_TIMEZONE });
}

/** Сегодняшняя дата `YYYY-MM-DD` по МСК. */
export function moscowNowYmd(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: CHAT_TIMEZONE });
}

/** Вчера относительно «сегодня» в МСК, строка `YYYY-MM-DD`. */
export function moscowYesterdayYmd(): string {
  const today = moscowNowYmd();
  const [y, m, d] = today.split('-').map(Number);
  const ud = new Date(Date.UTC(y, m - 1, d));
  ud.setUTCDate(ud.getUTCDate() - 1);
  return ud.toISOString().slice(0, 10);
}

/**
 * Подпись разделителя дня в ленте: «Сегодня», «Вчера» или дата по-русски (+ год, если не текущий).
 */
export function daySeparatorLabel(ymd: string): string {
  if (ymd === moscowNowYmd()) return 'Сегодня';
  if (ymd === moscowYesterdayYmd()) return 'Вчера';
  const [Y, M, D] = ymd.split('-').map(Number);
  const ref = new Date(Date.UTC(Y, M - 1, D, 12, 0, 0));
  const curY = +moscowNowYmd().slice(0, 4);
  const yStr = Y !== curY ? ` ${Y}` : '';
  return (
    ref.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      timeZone: CHAT_TIMEZONE,
    }) + yStr
  );
}

/** Время сообщения в ленте, `ЧЧ:ММ`, 24ч, МСК. */
export function formatMessageClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: CHAT_TIMEZONE,
  });
}

/**
 * Текст подсказки для галочек «прочитано» у своего сообщения в личке.
 */
export function formatReadReceiptTooltip(iso: string | null | undefined): string {
  if (!iso) return 'Прочитано';
  try {
    return `Прочитано ${new Date(iso).toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: CHAT_TIMEZONE,
    })}`;
  } catch {
    return 'Прочитано';
  }
}

/**
 * Две галочки (или одна) у исходящего сообщения: отправлено / прочитано собеседником.
 */
export function MsgReadTicks({ read, readAt }: { read: boolean; readAt: string | null }) {
  const title = read ? formatReadReceiptTooltip(readAt) : 'Отправлено';
  return (
    <span className="lc-msg-read-wrap" title={title}>
      <span
        className={`lc-msg-ticks${read ? ' lc-msg-ticks--read' : ' lc-msg-ticks--sent'}`}
        aria-hidden
      >
        {read ? (
          <>
            <span className="lc-msg-tick">✓</span>
            <span className="lc-msg-tick lc-msg-tick--second">✓</span>
          </>
        ) : (
          <span className="lc-msg-tick">✓</span>
        )}
      </span>
    </span>
  );
}

/** Элемент плоского списка для рендера ленты: день, маркер «новые» или сообщение. */
export type ChatTimelineRow =
  | { type: 'day'; key: string; label: string }
  | { type: 'newMarker' }
  | { type: 'msg'; m: Message };

/**
 * Определяет системное событие входа/выхода участника группы (не считается обычным сообщением).
 */
export function groupMemberChatEventKind(m: Message): 'member_join' | 'member_leave' | null {
  if (m.chatEvent === 'member_join' || m.chatEvent === 'member_leave') return m.chatEvent;
  if (m.groupId == null) return null;
  const b = m.body ?? '';
  if (b.startsWith('Пользователь ') && b.endsWith(' покинул чат')) return 'member_leave';
  if (b.startsWith('Пользователь ') && b.endsWith(' присоединился к чату')) return 'member_join';
  return null;
}

/**
 * Строит плоский массив строк таймлайна: разделители по дням (МСК), маркер «Новые сообщения», сообщения.
 *
 * @param messages — все видимые сообщения (будут отсортированы по `id`)
 * @param dividerAfterMessageId — курсор «прочитано до»; сообщения с большим id от других считаются новыми
 * @param viewerUserId — свой user id; свои сообщения не попадают под «новые для меня»
 */
export function buildChatTimeline(
  messages: Message[],
  dividerAfterMessageId: number | null | undefined,
  viewerUserId: number
): ChatTimelineRow[] {
  const sorted = [...messages].sort((a, b) => a.id - b.id);
  const threshold = dividerAfterMessageId ?? 0;

  const isUnreadFromOther = (m: Message) =>
    m.id > threshold &&
    m.sender.id !== viewerUserId &&
    !groupMemberChatEventKind(m);

  /** Если есть непрочитанные за «сегодня» (МСК), линию ставим перед ними — иначе она залипает под «Вчера», хотя собеседник уже пишет сегодня. */
  const todayYmd = moscowNowYmd();
  const todayUnread = sorted.find((m) => isUnreadFromOther(m) && isoToMoscowYmd(m.createdAt) === todayYmd);
  const fallbackUnread = sorted.find((m) => isUnreadFromOther(m));
  const markerBeforeId = todayUnread?.id ?? fallbackUnread?.id ?? null;

  const rows: ChatTimelineRow[] = [];
  let lastYmd: string | null = null;
  let insertedNew = false;
  for (const m of sorted) {
    const ymd = isoToMoscowYmd(m.createdAt);
    if (ymd !== lastYmd) {
      rows.push({ type: 'day', key: ymd, label: daySeparatorLabel(ymd) });
      lastYmd = ymd;
    }
    if (!insertedNew && markerBeforeId != null && m.id === markerBeforeId) {
      rows.push({ type: 'newMarker' });
      insertedNew = true;
    }
    rows.push({ type: 'msg', m });
  }
  return rows;
}

/** Курсор прочтения участника группы (для своих исходящих в группе). */
export type MemberReadCursor = { lastReadMessageId: number | null; lastReadAt: string | null };

/**
 * Прочитано ли **моё** сообщение в личке: сравнение `messageId` с `peer.lastReadMessageId`.
 */
export function directOwnMessageRead(
  messageId: number,
  peer: { lastReadMessageId: number | null; lastReadAt: string | null } | null
) {
  const cur = peer?.lastReadMessageId ?? 0;
  const read = cur >= messageId;
  return { read, readAt: read ? peer?.lastReadAt ?? null : null };
}

/**
 * В группе «прочитано» для своего сообщения: все остальные участники должны иметь `lastReadMessageId >= messageId`.
 * `readAt` — максимальный `lastReadAt` среди тех, кто уже дочитал (для подсказки).
 */
export function groupOwnMessageRead(messageId: number, memberReads: Record<number, MemberReadCursor>) {
  const entries = Object.values(memberReads);
  if (entries.length === 0) return { read: false, readAt: null as string | null };
  let read = true;
  let latestAt: string | null = null;
  for (const v of entries) {
    const c = v.lastReadMessageId ?? 0;
    if (c < messageId) {
      read = false;
    } else if (v.lastReadAt && (!latestAt || v.lastReadAt > latestAt)) {
      latestAt = v.lastReadAt;
    }
  }
  return { read, readAt: read ? latestAt : null };
}

/**
 * Нормализует пару дат поиска: пустые строки → `null`, если `from > to` — меняет местами.
 */
export function normalizeSearchDateRange(fromStr: string, toStr: string) {
  let f = fromStr.trim() || null;
  let t = toStr.trim() || null;
  if (f && t && f > t) [f, t] = [t, f];
  return { from: f, to: t, active: f != null || t != null };
}

/** Набор эмодзи для панели ввода в композере. */
export const CHAT_EMOJIS = [
  '😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😍', '🥰', '😘', '😜', '🤔', '😉', '😎', '😢',
  '😭', '😤', '👍', '👎', '👏', '🙏', '🔥', '❤️', '💯', '✨', '🎉', '👀', '🤝', '💪',
];

/** Быстрые реакции под сообщением (первый ряд). */
export const REACTION_QUICK = ['👍', '❤️', '🔥', '😂', '😮', '😢', '🙏', '👏', '💯', '✨'];

/** Иконка: быстрый ответ (стрелка влево-вниз). */
export function IconReplyQuick(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M9.5 8.5 5 13l4.5 4.5" />
      <path d="M5 13h12.5a5.5 5.5 0 015.5 5.5v.5a5.5 5.5 0 01-5.5 5.5H8" />
    </svg>
  );
}

/** Иконка пункта меню: ответить. */
export function IconMenuReply(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h11a5 5 0 015 5v2" />
    </svg>
  );
}

/** Иконка пункта меню: переслать. */
export function IconMenuForward(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M15 10l5-5-5-5" />
      <path d="M20 5H9a5 5 0 00-5 5v2" />
    </svg>
  );
}

/** Иконка пункта меню: важное / звезда. */
export function IconMenuStar(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden {...props}>
      <path d="M12 3l2.2 5.5L20 10l-4.5 3.3L17 20l-5-3-5 3 1.5-6.7L4 10l5.8-1.5L12 3z" strokeLinejoin="round" />
    </svg>
  );
}

/** Иконка пункта меню: копировать текст. */
export function IconMenuCopy(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden {...props}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M4 16V6a2 2 0 012-2h10" />
    </svg>
  );
}

/** Иконка пункта меню: коллеги / заявка (два силуэта). */
export function IconMenuFriend(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden {...props}>
      <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" strokeLinecap="round" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" strokeLinecap="round" />
    </svg>
  );
}

/** Иконка пункта меню: удалить сообщение. */
export function IconMenuTrash(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden {...props}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V5h6v2" strokeLinejoin="round" />
    </svg>
  );
}

/** Иконка пункта меню: режим выбора нескольких сообщений. */
export function IconMenuSelect(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l2.5 2.5L16 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Иконка раскрытия подменю (шеврон вправо). */
export function IconMenuChevron(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden {...props}>
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Иконка пункта меню: редактировать сообщение. */
export function IconMenuEdit(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden {...props}>
      <path
        d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Иконка кнопки поиска по чату в шапке. */
export function IconHeaderSearch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </svg>
  );
}

/** Одна галочка (мелкая, для вложенных UI). */
export function IconMsgCheckSingle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={15} height={15} aria-hidden {...props}>
      <path
        d="M5 12l3 3 7-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Двойная галочка (мелкая). */
export function IconMsgCheckDouble(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={18} height={15} aria-hidden {...props}>
      <path
        d="M4 12l2.5 2.5L11 8M9 12l2.5 2.5L17 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Может ли модератор/админ приглашать в группу по политике `invitePolicy`.
 */
export function canUseInviteInGroupMod(role: string, invitePolicy: InvitePolicy | string) {
  if (role === 'admin') return true;
  if (invitePolicy === 'all') return true;
  if (invitePolicy === 'admin_moderator' && role === 'moderator') return true;
  return false;
}

/**
 * Если курсор стоит сразу после `@` и фрагмента без пробелов/переносов — возвращает границы для автодополнения упоминаний.
 *
 * @param value — полный текст композера
 * @param cursor — позиция каретки
 */
export function mentionQueryAtCursor(value: string, cursor: number): { start: number; query: string } | null {
  if (cursor < 0 || cursor > value.length) return null;
  const before = value.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0) {
    const prev = before.charCodeAt(at - 1);
    if (prev !== 10 && prev !== 13 && prev !== 32 && prev !== 9) return null;
  }
  const frag = before.slice(at + 1);
  if (frag.includes('\n') || frag.includes(' ')) return null;
  return { start: at, query: frag };
}

/**
 * Аналогично {@link mentionQueryAtCursor}, но для `#` (привязка задачи/документа); в запросе допускаются пробелы, но не перевод строки.
 */
export function hashQueryAtCursor(value: string, cursor: number): { start: number; query: string } | null {
  if (cursor < 0 || cursor > value.length) return null;
  const before = value.slice(0, cursor);
  const hash = before.lastIndexOf('#');
  if (hash < 0) return null;
  if (hash > 0) {
    const prev = before.charCodeAt(hash - 1);
    if (prev !== 10 && prev !== 13 && prev !== 32 && prev !== 9) return null;
  }
  const frag = before.slice(hash + 1);
  if (frag.includes('\n') || frag.includes('\r')) return null;
  return { start: hash, query: frag };
}

/**
 * Иконка закрепления сообщения в меню; при `pinned` заливка текущим цветом.
 */
export function IconMenuPin({ pinned, ...props }: SVGProps<SVGSVGElement> & { pinned?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden {...props}>
      <path
        d="M12 2v8M6 10h12l-2 8H8L6 10z"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
