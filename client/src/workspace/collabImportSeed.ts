/**
 * @fileoverview Построение начального бинарного состояния Yjs для коллаб-документов при импорте с диска (ленивый чанк).
 *
 * Rich text: временный TipTap + Collaboration на скрытом DOM, mammoth для .docx, plain/HTML как параграфы.
 * Таблицы: `importSpreadsheetFileToYdoc`. Результат — `Uint8Array` для `POST .../y-seed` (часто оборачивается в Base64 в вызывающем коде).
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import TextStyle from '@tiptap/extension-text-style';
import FontFamily from '@tiptap/extension-font-family';
import Color from '@tiptap/extension-color';
import Image from '@tiptap/extension-image';
import * as Y from 'yjs';
import mammoth from 'mammoth';
import { FontSize } from './fontSizeExtension';
import { importSpreadsheetFileToYdoc } from './sheetModel';

const MAX_RICHTEXT_BYTES = 4 * 1024 * 1024;
const MAX_SHEET_BYTES = 12 * 1024 * 1024;
/** Макс. размер файла-картинки перед встраиванием как data URL в Yjs. */
const MAX_DISK_IMAGE_BYTES = 6 * 1024 * 1024;

/** Набор расширений TipTap, совпадающий с боевым rich text редактором (в т.ч. Collaboration на `ydoc`). */
function collabRichTextEditorExtensions(ydoc: Y.Doc) {
  return [
    StarterKit.configure({ history: false }),
    TextStyle,
    FontFamily,
    FontSize,
    Color,
    Image.configure({ inline: true, allowBase64: true }),
    Collaboration.configure({ document: ydoc }),
  ];
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Не удалось прочитать файл'));
    r.readAsDataURL(file);
  });
}

/** Текст/HTML-файл → простой HTML для TipTap (экранирование и переносы строк). */
function fileTextToTipTapHtml(file: File, text: string): string {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const bodyMatch = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const inner = bodyMatch ? bodyMatch[1].trim() : text;
    return inner || '<p></p>';
  }
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const paras = esc.split(/\r?\n/).map((line) => `<p>${line.length ? line : '<br>'}</p>`).join('');
  return paras || '<p></p>';
}

/** Состояние Yjs для редактора, совместимого с CollabRichText (TipTap + те же расширения). */
export async function buildRichTextYUpdateFromFile(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_RICHTEXT_BYTES) {
    throw new Error('Файл слишком большой для импорта в документ (макс. 4 МБ)');
  }
  const lower = file.name.toLowerCase();
  let html: string;
  if (lower.endsWith('.docx')) {
    const r = await mammoth.convertToHtml({ arrayBuffer: buf });
    html = (r.value && r.value.trim()) || '<p></p>';
  } else if (lower.endsWith('.doc')) {
    throw new Error('Старый формат .doc не поддерживается — сохраните файл как .docx');
  } else {
    const text = new TextDecoder('utf-8').decode(buf);
    html = fileTextToTipTapHtml(file, text);
  }

  const ydoc = new Y.Doc();
  const mount = document.createElement('div');
  mount.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(mount);

  const editor = new Editor({
    element: mount,
    extensions: collabRichTextEditorExtensions(ydoc),
    content: html,
  });

  try {
    return Y.encodeStateAsUpdate(ydoc);
  } finally {
    editor.destroy();
    ydoc.destroy();
    mount.remove();
  }
}

function imageAltFromFileName(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, '') || file.name || 'фото';
  return base.slice(0, 200);
}

/**
 * Одно изображение в документе: `src` — абсолютный URL или data URL.
 * Через setImage (не HTML-строку), чтобы длинные data: и кавычки в SVG не ломали разбор.
 */
export async function buildRichTextYUpdateFromImageUrl(src: string, alt: string): Promise<Uint8Array> {
  const ydoc = new Y.Doc();
  const mount = document.createElement('div');
  mount.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(mount);

  const editor = new Editor({
    element: mount,
    extensions: collabRichTextEditorExtensions(ydoc),
    content: '<p></p>',
  });

  editor.chain().focus().setImage({ src, alt: alt || 'фото' }).run();

  try {
    return Y.encodeStateAsUpdate(ydoc);
  } finally {
    editor.destroy();
    ydoc.destroy();
    mount.remove();
  }
}

/** Локальный data URL (без загрузки на сервер); для импорта с диска предпочтительнее URL с сервера. */
export async function buildRichTextYUpdateFromImageFile(file: File): Promise<Uint8Array> {
  if (file.size > MAX_DISK_IMAGE_BYTES) {
    throw new Error(`Фото слишком большое (макс. ${Math.round(MAX_DISK_IMAGE_BYTES / (1024 * 1024))} МБ)`);
  }
  const dataUrl = await fileToDataUrl(file);
  return buildRichTextYUpdateFromImageUrl(dataUrl, imageAltFromFileName(file));
}

/**
 * Импорт Excel/CSV в Yjs через `sheetModel` (лимит размера буфера — 12 МБ).
 * @throws Error если таблица слишком большая
 */
export function buildSpreadsheetYUpdateFromFile(file: File, data: ArrayBuffer): Uint8Array {
  if (data.byteLength > MAX_SHEET_BYTES) {
    throw new Error('Таблица слишком большая (макс. 12 МБ)');
  }
  const ydoc = new Y.Doc();
  try {
    importSpreadsheetFileToYdoc(ydoc, file, data);
    return Y.encodeStateAsUpdate(ydoc);
  } finally {
    ydoc.destroy();
  }
}
