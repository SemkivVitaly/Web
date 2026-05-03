/**
 * @fileoverview Встраивание OnlyOffice Document Editor: динамическая подгрузка `api.js` с Document Server, singleton `DocsAPI.DocEditor` на контейнер.
 * Скрипт кэшируется по базовому URL сервера; при смене `document.key` в config редактор пересоздаётся.
 */

import { useEffect, useRef, useMemo } from 'react';

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: (
        id: string,
        config: Record<string, unknown>
      ) => { destroyEditor?: () => void };
    };
  }
}

const scriptPromises = new Map<string, Promise<void>>();

/** Однократная вставка `<script src=".../web-apps/apps/api/documents/api.js">` на origin Document Server. */
function ensureOnlyOfficeScript(documentServerUrl: string): Promise<void> {
  const base = documentServerUrl.replace(/\/$/, '');
  if (typeof window !== 'undefined' && window.DocsAPI) return Promise.resolve();
  if (!scriptPromises.has(base)) {
    scriptPromises.set(
      base,
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `${base}/web-apps/apps/api/documents/api.js`;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Не удалось загрузить API OnlyOffice'));
        document.body.appendChild(s);
      })
    );
  }
  return scriptPromises.get(base)!;
}

/**
 * Контейнер с фиксированным `id` для iframe редактора; `config` — ответ `POST .../onlyoffice/config`.
 *
 * @param documentServerUrl — базовый URL OnlyOffice (без завершающего `/`)
 * @param config — объект конфигурации редактора (document, editorConfig, …)
 * @param docId — для уникального id DOM-узла при нескольких документах в SPA
 * @param containerId — явный id контейнера (например просмотр вложения в чате, чтобы не пересекаться с collab `docId`)
 */
export function OnlyOfficeDocEmbed({
  documentServerUrl,
  config,
  docId,
  containerId,
}: {
  documentServerUrl: string;
  config: Record<string, unknown>;
  docId: number;
  containerId?: string;
}) {
  const hostId = containerId ?? `lc-onlyoffice-${docId}`;
  const editorRef = useRef<{ destroyEditor?: () => void } | null>(null);
  const configKey = useMemo(
    () => (config as { document?: { key?: string } })?.document?.key ?? '',
    [config]
  );
  const latestConfig = useRef(config);
  latestConfig.current = config;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureOnlyOfficeScript(documentServerUrl);
        if (cancelled || !window.DocsAPI) return;
        editorRef.current?.destroyEditor?.();
        editorRef.current = window.DocsAPI.DocEditor(hostId, latestConfig.current);
      } catch {
        /* родитель может показать ошибку */
      }
    })();
    return () => {
      cancelled = true;
      editorRef.current?.destroyEditor?.();
      editorRef.current = null;
    };
  }, [documentServerUrl, docId, configKey, hostId, containerId]);

  return <div id={hostId} className="lc-onlyoffice-host" />;
}
