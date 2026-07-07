/**
 * @fileoverview Полноэкранный просмотр/редактирование коллаб-документа: выбор OnlyOffice vs встроенного Yjs (`CollabRichText` / `CollabSheet`),
 * присоединение к комнате `collab:{docId}`, синхронизация через `collab:y-update`, редактирование описания при `canEditMeta`.
 */

import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import type { Socket } from 'socket.io-client';
import * as Y from 'yjs';
import { api } from '../api';
import { yjsUpdateToBase64, base64ToUint8Array } from './yjsB64';
import { CollabRichText } from './CollabRichText';
import { OnlyOfficeDocEmbed } from './OnlyOfficeDocEmbed';

const CollabSheet = lazy(() =>
  import('./CollabSheet').then((m) => ({ default: m.CollabSheet }))
);

type JoinResp = { ok?: boolean; error?: string; state?: string };

type OoEnabled = { enabled: boolean; documentServerUrl: string | null };
type OoConfigResp = { documentServerUrl: string; config: Record<string, unknown> };

/**
 * Оболочка документа воркспейса: шапка «Назад», описание, затем iframe OnlyOffice или Yjs-редактор.
 *
 * @param docId — id в `collab_documents`
 * @param docType — rich text или таблица
 * @param docName / docDescription — отображаемые метаданные
 * @param canEditMeta — показать редактирование описания (PATCH `/api/collab-docs/:id`)
 * @param password / folderPassword — для API и `collab:join`
 * @param socket — клиент с обработчиками коллаба
 * @param onBack — возврат к списку документов
 * @param onMetaSaved — после успешного сохранения описания
 */
export function CollabDocView({
  docId,
  docType,
  docName,
  docDescription,
  canEditMeta,
  password,
  folderPassword,
  socket,
  onBack,
  onMetaSaved,
}: {
  docId: number;
  docType: 'richtext' | 'spreadsheet';
  docName: string;
  docDescription: string;
  canEditMeta: boolean;
  password: string;
  folderPassword?: string;
  socket: Socket;
  onBack: () => void;
  onMetaSaved?: () => void;
}) {
  // --- Режим редактора: проверка OnlyOffice + meta; сессия OO; Y.Doc только в ветке yjs ---

  const [editorMode, setEditorMode] = useState<'checking' | 'onlyoffice' | 'yjs'>('checking');
  const [ooSession, setOoSession] = useState<OoConfigResp | null>(null);
  const [ooHint, setOoHint] = useState('');

  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);
  const yref = useRef<Y.Doc | null>(null);
  const [desc, setDesc] = useState(docDescription);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descSaving, setDescSaving] = useState(false);
  const [imageDocument, setImageDocument] = useState(false);

  useEffect(() => {
    setDesc(docDescription);
  }, [docDescription]);

  // --- Выбор OnlyOffice: /enabled, meta (preferBuiltin / imageDocument), config; иначе или при ошибке — yjs ---

  useEffect(() => {
    let alive = true;
    setEditorMode('checking');
    setOoSession(null);
    setOoHint('');
    setImageDocument(false);

    void (async () => {
      try {
        const en = await api<OoEnabled>('/api/onlyoffice/enabled');
        if (!alive) return;
        let meta: { preferBuiltinEditor?: boolean; imageDocument?: boolean } | null = null;
        try {
          meta = await api<{ preferBuiltinEditor?: boolean; imageDocument?: boolean }>(
            `/api/collab-docs/${docId}/meta`
          );
          if (!alive) return;
          setImageDocument(!!meta.imageDocument);
        } catch {
          meta = null;
        }
        if (!en.enabled) {
          setEditorMode('yjs');
          return;
        }
        if (meta?.preferBuiltinEditor) {
          setEditorMode('yjs');
          return;
        }
        const cfg = await api<OoConfigResp>(`/api/collab-docs/${docId}/onlyoffice/config`, {
          method: 'POST',
          json: {
            password: password || undefined,
            folderPassword: folderPassword || undefined,
          },
        });
        if (!alive) return;
        setOoSession(cfg);
        setEditorMode('onlyoffice');
      } catch (e) {
        if (!alive) return;
        const base = (e as Error).message || 'OnlyOffice недоступен';
        setOoHint(
          `${base}. Если документ появился импортом «с диска» под OnlyOffice, его содержимое лежит в .docx/.xlsx на сервере — встроенный редактор (Yjs) при этом часто пустой.`
        );
        setEditorMode('yjs');
      }
    })();

    return () => {
      alive = false;
    };
  }, [docId, password, folderPassword]);

  // --- Yjs: join, начальный state с сервера, локальные update → collab:y-update, remote → applyUpdate ---

  useEffect(() => {
    if (editorMode !== 'yjs') return;
    let alive = true;
    setErr('');
    setReady(false);
    const y = new Y.Doc();
    yref.current = y;

    const onSocketUpdate = (payload: { docId: number; update: string }) => {
      if (payload.docId !== docId || !yref.current) return;
      try {
        Y.applyUpdate(yref.current, base64ToUint8Array(payload.update), 'remote');
      } catch {
        /* noop */
      }
    };

    const onLocalUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || origin === 'socket') return;
      socket.emit('collab:y-update', { docId, update: yjsUpdateToBase64(update) });
    };

    y.on('update', onLocalUpdate);
    socket.on('collab:y-update', onSocketUpdate);

    socket.emit(
      'collab:join',
      {
        docId,
        password: password || undefined,
        folderPassword: folderPassword || undefined,
      },
      (resp: JoinResp) => {
        if (!alive || !yref.current) return;
        if (!resp?.ok) {
          setErr(resp?.error || 'Не удалось открыть документ');
          return;
        }
        if (resp.state) {
          try {
            Y.applyUpdate(yref.current, base64ToUint8Array(resp.state), 'remote');
          } catch {
            /* noop */
          }
        }
        setYdoc(yref.current);
        setReady(true);
      }
    );

    return () => {
      alive = false;
      socket.off('collab:y-update', onSocketUpdate);
      y.off('update', onLocalUpdate);
      socket.emit('collab:leave', { docId });
      y.destroy();
      yref.current = null;
      setYdoc(null);
      setReady(false);
    };
  }, [docId, password, folderPassword, socket, editorMode]);

  async function saveDescription() {
    setDescSaving(true);
    try {
      await api(`/api/collab-docs/${docId}`, {
        method: 'PATCH',
        json: { description: desc },
      });
      setEditingDesc(false);
      onMetaSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDescSaving(false);
    }
  }

  // --- Разметка: шапка Office-like, блок описания, OnlyOffice iframe или CollabRichText / CollabSheet ---

  const shellVisual =
    docType === 'richtext' && imageDocument && editorMode === 'yjs' ? 'image' : docType === 'richtext' ? 'word' : 'excel';
  const subBuiltIn =
    docType === 'richtext' && imageDocument
      ? 'Изображение · просмотр и правка'
      : docType === 'richtext'
        ? 'Встроенный редактор · Word'
        : 'Встроенный редактор · Excel';
  const subOo = docType === 'richtext' ? 'OnlyOffice · совместное редактирование' : 'OnlyOffice · совместное редактирование';

  return (
    <div className={`lc-workspace-panel lc-office-shell lc-office-shell--${shellVisual}`}>
      <header className="lc-mso-titlebar" role="banner">
        <div className="lc-mso-titlebar-left">
          <button type="button" className="lc-mso-back" onClick={onBack} title="Назад к списку">
            ←
          </button>
          <div className="lc-mso-titlebar-doc">
            <span className="lc-mso-titlebar-name">{docName}</span>
            <span className="lc-mso-titlebar-sub">
              {editorMode === 'onlyoffice' ? subOo : subBuiltIn}
            </span>
          </div>
        </div>
        <div className="lc-mso-titlebar-brand" aria-hidden>
          {docType === 'richtext' && imageDocument && editorMode === 'yjs' ? '🖼' : docType === 'richtext' ? 'W' : 'X'}
        </div>
      </header>
      <div className="lc-office-doc-desc-block lc-mso-desc-block">
        {editingDesc && canEditMeta ? (
          <div className="lc-office-doc-desc-edit">
            <textarea
              className="lc-textarea-field"
              rows={3}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Краткое описание документа"
            />
            <div className="row-actions">
              <button
                type="button"
                className="primary"
                disabled={descSaving}
                onClick={() => void saveDescription()}
              >
                Сохранить
              </button>
              <button
                type="button"
                onClick={() => {
                  setDesc(docDescription);
                  setEditingDesc(false);
                }}
              >
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <>
            {desc.trim() ? (
              <p className="lc-office-doc-desc">{desc}</p>
            ) : (
              <p className="lc-office-doc-desc lc-office-doc-desc--empty">Нет описания</p>
            )}
            {canEditMeta && (
              <button type="button" className="lc-office-desc-btn" onClick={() => setEditingDesc(true)}>
                {desc.trim() ? 'Изменить описание' : 'Добавить описание'}
              </button>
            )}
          </>
        )}
      </div>
      {ooHint ? <p className="meta lc-onlyoffice-fallback-hint">{ooHint} — открыт встроенный редактор.</p> : null}
      {err && <p className="error">{err}</p>}
      {editorMode === 'checking' && <p className="meta">Подготовка редактора…</p>}
      {editorMode === 'onlyoffice' && ooSession && (
        <div className="lc-onlyoffice-wrap">
          <OnlyOfficeDocEmbed
            documentServerUrl={ooSession.documentServerUrl}
            config={ooSession.config}
            docId={docId}
          />
        </div>
      )}
      {editorMode === 'yjs' && !err && ready && ydoc && docType === 'richtext' && (
        <CollabRichText ydoc={ydoc} docName={docName} imageFocus={imageDocument} />
      )}
      {editorMode === 'yjs' && !err && ready && ydoc && docType === 'spreadsheet' && (
        <Suspense fallback={<p className="meta">Загрузка таблицы…</p>}>
          <CollabSheet ydoc={ydoc} docName={docName} />
        </Suspense>
      )}
      {editorMode === 'yjs' && !err && !ready && <p className="meta">Подключение к совместному редактированию…</p>}
    </div>
  );
}
