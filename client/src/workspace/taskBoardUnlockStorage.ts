/**
 * @fileoverview Сохранение паролей защищённых досок задач в `localStorage` (на группу).
 *
 * Сервер отдаёт `passwordFingerprint` (хэш от хэша пароля); при смене пароля на доске fingerprint меняется —
 * устаревшие записи удаляются в `mergeBoardPwFromStore`. Пока список досок с API пуст, очистку не делаем,
 * чтобы не стереть пароли при временно пустом ответе после переключения вкладок.
 */

import type { TaskBoardSummary } from '../types';

type UnlockEntry = { fp: string; pw: string };

type TaskBoardUnlockStore = Record<string, UnlockEntry>;

function storeKey(groupId: number) {
  return `localchat_task_board_unlock_v1_${groupId}`;
}

/** Прочитать сырой объект разблокировок для группы (пустой при ошибке parse / отсутствии ключа). */
export function readTaskBoardUnlock(groupId: number): TaskBoardUnlockStore {
  try {
    const raw = localStorage.getItem(storeKey(groupId));
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    return p as TaskBoardUnlockStore;
  } catch {
    return {};
  }
}

/** Записать весь store группы (тихо игнорирует переполнение quota). */
function writeTaskBoardUnlock(groupId: number, store: TaskBoardUnlockStore) {
  try {
    localStorage.setItem(storeKey(groupId), JSON.stringify(store));
  } catch {
    /* ignore quota */
  }
}

/** Сохранить пароль доски после успешного ввода; без `fingerprint` ничего не пишем. */
export function rememberTaskBoardUnlock(
  groupId: number,
  boardId: number,
  fingerprint: string | null | undefined,
  password: string
) {
  if (!fingerprint) return;
  const s = readTaskBoardUnlock(groupId);
  s[String(boardId)] = { fp: fingerprint, pw: password };
  writeTaskBoardUnlock(groupId, s);
}

/**
 * Карта `boardId → пароль` для досок, у которых fingerprint в store совпадает с ответом API.
 * Удаляет из store записи по доскам без пароля, с другим fingerprint или исчезнувшим id.
 */
export function mergeBoardPwFromStore(groupId: number, boards: TaskBoardSummary[]): Record<number, string> {
  const s = readTaskBoardUnlock(groupId);
  /**
   * Пока список досок ещё не загружен (например после смены вкладки «Задачи» → «Чат» → «Задачи»),
   * нельзя «чистить» хранилище: byId пустой и любая запись выглядела бы невалидной — пароли стирались.
   */
  if (!boards.length) {
    const out: Record<number, string> = {};
    for (const k of Object.keys(s)) {
      const id = +k;
      if (Number.isFinite(id) && s[k]?.pw) out[id] = s[k].pw;
    }
    return out;
  }

  const byId = Object.fromEntries(boards.map((b) => [b.id, b]));
  let changed = false;
  for (const k of Object.keys(s)) {
    const id = +k;
    const b = byId[id];
    const e = s[k];
    if (!b?.hasPassword || !b.passwordFingerprint || !e || e.fp !== b.passwordFingerprint) {
      delete s[k];
      changed = true;
    }
  }
  if (changed) writeTaskBoardUnlock(groupId, s);

  const out: Record<number, string> = {};
  for (const b of boards) {
    if (!b.hasPassword || !b.passwordFingerprint) continue;
    const e = s[String(b.id)];
    if (e && e.fp === b.passwordFingerprint) out[b.id] = e.pw;
  }
  return out;
}

/** Один пароль по id доски, если fingerprint совпал; иначе пустая строка. */
export function getStoredTaskBoardPassword(
  groupId: number,
  boardId: number,
  fingerprint: string | null | undefined
): string {
  if (!fingerprint) return '';
  const e = readTaskBoardUnlock(groupId)[String(boardId)];
  if (e && e.fp === fingerprint) return e.pw;
  return '';
}
