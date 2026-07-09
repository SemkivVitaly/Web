/**
 * @fileoverview Всплывающий предпросмотр карточки канбана и строки в «Структуре»: задача/документ/файл/папка/ссылка.
 * Для текстовых вложений — ограниченный fetch и обрезка (константы `HOVER_TEXT_*` в `filePreviewUtils`).
 */

import { useEffect, useState } from 'react';
import type { TaskCanvasItem } from '../types';
import { resolveUrl } from '../api';
import {
  HOVER_TEXT_DISPLAY_MAX_CHARS,
  HOVER_TEXT_FETCH_MAX_BYTES,
  fetchUtf8TextLimited,
  formatTextIfJson,
  isTextPreviewableFile,
} from './filePreviewUtils';

/** Короткая вытяжка текста загруженного файла по URL (для ховера на карточке «файл»). */
function CanvasUploadTextSnippet({ url, fileName }: { url: string; fileName: string | null }) {
  const [state, setState] = useState<'loading' | 'empty' | 'ready' | 'err'>('loading');
  const [text, setText] = useState('');

  useEffect(() => {
    let gone = false;
    (async () => {
      const res = await fetchUtf8TextLimited(url, HOVER_TEXT_FETCH_MAX_BYTES);
      if (gone) return;
      if (!res.ok) {
        setState('err');
        return;
      }
      let t = res.text;
      if ((fileName || '').toLowerCase().endsWith('.json')) t = formatTextIfJson(t);
      if (t.length > HOVER_TEXT_DISPLAY_MAX_CHARS) t = t.slice(0, HOVER_TEXT_DISPLAY_MAX_CHARS) + '…';
      if (!t.trim()) {
        setState('empty');
        return;
      }
      setText(t);
      setState('ready');
    })();
    return () => {
      gone = true;
    };
  }, [url, fileName]);

  if (state === 'loading') return <div className="meta">Читаю файл…</div>;
  if (state === 'err') return <div className="meta">Текст не прочитать</div>;
  if (state === 'empty') return <div className="meta">Пустой файл</div>;
  return <pre className="lc-canvas-hover-text-snippet">{text}</pre>;
}

/**
 * Содержимое тултипа по `TaskCanvasItem`: превью задачи/документа, картинка, текстовый сниппет или подсказка для папки/ссылки.
 * @param item — элемент доски с полями `taskPreview` / `docPreview` / `fileUrl` в зависимости от `kind`
 */
export function CanvasCardPreview({ item }: { item: TaskCanvasItem }) {
  if (item.kind === 'task' && item.taskPreview) {
    return (
      <div className="lc-canvas-hover-body">
        <div className="lc-canvas-hover-status">
          {item.taskPreview.status} · {item.taskPreview.progress}%
        </div>
        {item.taskPreview.description ? (
          <div className="lc-canvas-hover-desc">{item.taskPreview.description}</div>
        ) : (
          <div className="meta">Нет описания</div>
        )}
      </div>
    );
  }
  if (item.kind === 'collab_doc' && item.docPreview) {
    return (
      <div className="lc-canvas-hover-body">
        <div className="meta">{item.docPreview.docType === 'spreadsheet' ? 'Таблица' : 'Документ'}</div>
        {item.docPreview.description ? (
          <div className="lc-canvas-hover-desc">{item.docPreview.description}</div>
        ) : null}
      </div>
    );
  }
  if (item.kind === 'upload' && item.fileUrl) {
    if (item.isImage) {
      return (
        <div className="lc-canvas-hover-body lc-canvas-hover-imgwrap">
          <img src={resolveUrl(item.fileUrl)} alt="" className="lc-canvas-hover-img" />
        </div>
      );
    }
    if (isTextPreviewableFile(item.fileMime, item.fileName)) {
      return (
        <div className="lc-canvas-hover-body">
          <div className="meta">{item.fileMime || 'Текст'}</div>
          {item.fileName ? <div className="lc-canvas-hover-filename">{item.fileName}</div> : null}
          <CanvasUploadTextSnippet url={resolveUrl(item.fileUrl)} fileName={item.fileName} />
        </div>
      );
    }
    return (
      <div className="lc-canvas-hover-body">
        <div className="meta">{item.fileMime || 'Файл'}</div>
        {item.fileName ? <div className="lc-canvas-hover-desc">{item.fileName}</div> : null}
      </div>
    );
  }
  if (item.kind === 'folder') {
    return (
      <div className="lc-canvas-hover-body">
        <div className="meta">Перетащите сюда элементы с доски</div>
      </div>
    );
  }
  if (item.kind === 'link' && item.linkUrl) {
    return (
      <div className="lc-canvas-hover-body">
        <div className="meta lc-canvas-hover-url">{item.linkUrl}</div>
      </div>
    );
  }
  return null;
}
