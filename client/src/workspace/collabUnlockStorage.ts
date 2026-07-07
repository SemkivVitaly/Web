/**
 * @fileoverview Сохранение паролей защищённых папок и документов коллаба в `sessionStorage` (на группу).
 *
 * Аналогично доскам задач: пара `passwordFingerprint` + пароль. `buildFolderPwMap` чистит устаревшие записи папок;
 * `mergeDocUnlocksFromStore` синхронизирует только документы текущего списка, не трогая записи о документах в других папках.
 */

import type { CollabDocSummary, CollabFolderSummary } from '../types';

type UnlockEntry = { fp: string; pw: string };

type CollabUnlockStore = {
  folders: Record<string, UnlockEntry>;
  docs: Record<string, UnlockEntry>;
};

function storeKey(groupId: number) {
  return `localchat_collab_unlock_v1_${groupId}`;
}

/** Прочитать store папок и документов для группы. */
export function readCollabUnlock(groupId: number): CollabUnlockStore {
  try {
    const raw = localStorage.getItem(storeKey(groupId));
    if (!raw) return { folders: {}, docs: {} };
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object') return { folders: {}, docs: {} };
    const o = p as { folders?: unknown; docs?: unknown };
    return {
      folders:
        o.folders && typeof o.folders === 'object' && !Array.isArray(o.folders)
          ? (o.folders as Record<string, UnlockEntry>)
          : {},
      docs:
        o.docs && typeof o.docs === 'object' && !Array.isArray(o.docs)
          ? (o.docs as Record<string, UnlockEntry>)
          : {},
    };
  } catch {
    return { folders: {}, docs: {} };
  }
}

/** Полная перезапись store группы (игнор quota). */
function writeCollabUnlock(groupId: number, store: CollabUnlockStore) {
  try {
    localStorage.setItem(storeKey(groupId), JSON.stringify(store));
  } catch {
    /* ignore quota */
  }
}

/** Запомнить пароль папки после успешного ввода. */
export function rememberFolderUnlock(
  groupId: number,
  folderId: number,
  fingerprint: string | null | undefined,
  password: string
) {
  if (!fingerprint) return;
  const s = readCollabUnlock(groupId);
  s.folders[String(folderId)] = { fp: fingerprint, pw: password };
  writeCollabUnlock(groupId, s);
}

/** Запомнить пароль документа после успешного ввода. */
export function rememberDocUnlock(
  groupId: number,
  docId: number,
  fingerprint: string | null | undefined,
  password: string
) {
  if (!fingerprint) return;
  const s = readCollabUnlock(groupId);
  s.docs[String(docId)] = { fp: fingerprint, pw: password };
  writeCollabUnlock(groupId, s);
}

/**
 * `folderId → пароль` для папок с паролем, fingerprint в store совпадает с API; чистит невалидные ключи в store.
 */
export function buildFolderPwMap(groupId: number, folders: CollabFolderSummary[]): Record<number, string> {
  const s = readCollabUnlock(groupId);
  /**
   * Пока дерево папок ещё не загружено (вкладка «Документы» после переключения с другой вкладки),
   * нельзя чистить хранилище: byId пустой — любая запись смотрелась бы невалидной и стиралась.
   */
  if (!folders.length) {
    const out: Record<number, string> = {};
    for (const k of Object.keys(s.folders)) {
      const id = +k;
      if (Number.isFinite(id) && s.folders[k]?.pw) out[id] = s.folders[k].pw;
    }
    return out;
  }

  const byId = Object.fromEntries(folders.map((f) => [f.id, f]));
  let changed = false;
  for (const k of Object.keys(s.folders)) {
    const id = +k;
    const f = byId[id];
    const e = s.folders[k];
    if (!f?.hasPassword || !f.passwordFingerprint || !e || e.fp !== f.passwordFingerprint) {
      delete s.folders[k];
      changed = true;
    }
  }
  if (changed) writeCollabUnlock(groupId, s);

  const out: Record<number, string> = {};
  for (const f of folders) {
    if (!f.hasPassword || !f.passwordFingerprint) continue;
    const e = s.folders[String(f.id)];
    if (e && e.fp === f.passwordFingerprint) out[f.id] = e.pw;
  }
  return out;
}

/**
 * Обновить карту `docId → пароль` для переданного списка документов: убрать несовпадающие fingerprint,
 * подтянуть из store; записи в `localStorage` о документах не из этого списка не изменяются.
 */
export function mergeDocUnlocksFromStore(
  groupId: number,
  docs: CollabDocSummary[],
  prev: Record<number, string>
): Record<number, string> {
  const s = readCollabUnlock(groupId);
  let changed = false;
  for (const d of docs) {
    const k = String(d.id);
    const e = s.docs[k];
    if (!d.hasPassword || !d.passwordFingerprint) {
      if (e) {
        delete s.docs[k];
        changed = true;
      }
      continue;
    }
    if (e && e.fp !== d.passwordFingerprint) {
      delete s.docs[k];
      changed = true;
    }
  }
  if (changed) writeCollabUnlock(groupId, s);

  const next = { ...prev };
  for (const d of docs) {
    if (!d.hasPassword || !d.passwordFingerprint) {
      delete next[d.id];
      continue;
    }
    const e = s.docs[String(d.id)];
    if (e && e.fp === d.passwordFingerprint) next[d.id] = e.pw;
    else delete next[d.id];
  }
  return next;
}
