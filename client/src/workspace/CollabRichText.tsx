/**
 * @fileoverview Встроенный rich text редактор коллаб-документа на TipTap + Yjs Collaboration (шрифт, размер, цвет, inline-картинки base64).
 * Панель инструментов в стиле Word, вставка из буфера (в т.ч. изображения), режим `imageFocus` для документов из одного фото.
 */

import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { useEffect, useReducer, useRef, type ReactNode } from 'react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import TextStyle from '@tiptap/extension-text-style';
import FontFamily from '@tiptap/extension-font-family';
import Color from '@tiptap/extension-color';
import Image from '@tiptap/extension-image';
import type { Doc } from 'yjs';
import DOMPurify from 'dompurify';
import { FontSize } from './fontSizeExtension';

/**
 * Политика санитайзера для HTML, который попадает в TipTap/Yjs: paste из буфера и открытие HTML-файла.
 * Приложение работает только в локальной сети, без выхода в интернет. Поэтому из внешнего HTML мы режем:
 *   — скрипты/обработчики (XSS, сохранились бы в общем Yjs-доке и исполнялись у всех участников);
 *   — любые `http(s)`/`mailto:`/`tel:` схемы — иначе `<img src="https://evil/..">` утечёт DNS/факт просмотра.
 * Оставляем только `data:image/*` (inline-картинки) и `#`-якори.
 */
function sanitizeExternalHtml(raw: string): string {
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: /^(?:data:image\/(?:png|jpe?g|gif|webp|bmp)|#)/i,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'srcset', 'formaction'],
  });
}

// --- Константы UI, цвет, буфер обмена (копировать / вставить / вырезать) ---

const FONT_CHOICES = ['Calibri', 'Arial', 'Times New Roman', 'Segoe UI', 'Georgia', 'Consolas'] as const;
const SIZE_CHOICES = ['9', '10', '11', '12', '14', '16', '18', '24'] as const;

function normalizeHexFromColorAttr(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const t = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t;
  const m = t.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    const r = Math.min(255, parseInt(m[1], 10));
    const g = Math.min(255, parseInt(m[2], 10));
    const b = Math.min(255, parseInt(m[3], 10));
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
  return fallback;
}

function copySelection(editor: Editor) {
  const { from, to, empty } = editor.state.selection;
  editor.chain().focus().run();
  if (!empty) {
    if (typeof document !== 'undefined' && document.execCommand('copy')) return;
    void navigator.clipboard?.writeText(editor.state.doc.textBetween(from, to, '\n'));
    return;
  }
  void navigator.clipboard?.writeText(editor.getText());
}

function cutSelection(editor: Editor) {
  const { from, to, empty } = editor.state.selection;
  if (empty) return;
  editor.chain().focus().run();
  if (typeof document !== 'undefined' && document.execCommand('cut')) return;
  void navigator.clipboard?.writeText(editor.state.doc.textBetween(from, to, '\n'));
  editor.chain().focus().deleteSelection().run();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('read'));
    r.readAsDataURL(blob);
  });
}

async function pasteFromClipboard(editor: Editor) {
  editor.chain().focus().run();
  try {
    if (!navigator.clipboard?.read) {
      const text = await navigator.clipboard.readText();
      editor.chain().focus().insertContent(text).run();
      return;
    }
    const clip = await navigator.clipboard.read();
    for (const item of clip) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        const src = await blobToDataUrl(blob);
        editor.chain().focus().setImage({ src, alt: 'вставка' }).run();
        return;
      }
      const htmlType = item.types.find((t) => t === 'text/html' || t.startsWith('text/html'));
      if (htmlType) {
        const html = await (await item.getType(htmlType)).text();
        editor.chain().focus().insertContent(sanitizeExternalHtml(html)).run();
        return;
      }
    }
    const text = await navigator.clipboard.readText();
    editor.chain().focus().insertContent(text).run();
  } catch {
    try {
      document.execCommand('paste');
    } catch {
      /* браузер может требовать Ctrl+V */
    }
  }
}

/**
 * Редактор тела документа; состояние текста живёт в переданном `Y.Doc` (синхронизацию обеспечивает родитель).
 *
 * @param ydoc — общий Yjs-документ комнаты коллаба
 * @param docName — подпись для aria / заголовков вставки файла
 * @param imageFocus — упрощённый UI для документа-картинки (импорт с диска)
 */
export function CollabRichText({
  ydoc,
  docName = 'документ',
  imageFocus = false,
}: {
  ydoc: Doc;
  docName?: string;
  /** Документ из импорта фото: акцент на просмотр картинки, без ленты Word */
  imageFocus?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ history: false }),
        TextStyle,
        FontFamily,
        FontSize,
        Color,
        Image.configure({ inline: true, allowBase64: true }),
        Collaboration.configure({
          document: ydoc,
        }),
      ],
      editorProps: {
        attributes: { class: 'lc-tiptap lc-word-body', spellcheck: 'true' },
      },
    },
    [ydoc]
  );

  const [, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    if (!editor) return;
    const fn = () => bump();
    editor.on('selectionUpdate', fn);
    editor.on('transaction', fn);
    return () => {
      editor.off('selectionUpdate', fn);
      editor.off('transaction', fn);
    };
  }, [editor]);

  if (!editor) return <div className="meta">Редактор загружается…</div>;

  if (imageFocus) {
    return (
      <div className="lc-collab-image-doc lc-word-app">
        <div className="lc-collab-image-doc__toolbar">
          <button
            type="button"
            className="lc-collab-image-doc__paste"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void pasteFromClipboard(editor)}
          >
            Вставить из буфера
          </button>
          <button
            type="button"
            className="lc-collab-image-doc__paste"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
          >
            Вставить файл…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f || !f.type.startsWith('image/')) return;
              const r = new FileReader();
              r.onload = () => {
                const src = String(r.result || '');
                if (src) editor.chain().focus().setImage({ src, alt: f.name }).run();
              };
              r.readAsDataURL(f);
            }}
          />
        </div>
        <div className="lc-word-page-wrap lc-collab-image-doc__stage">
          <div className="lc-word-page lc-collab-image-doc__page">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
    );
  }

  const ts = editor.getAttributes('textStyle') as {
    fontFamily?: string;
    fontSize?: string;
    color?: string;
  };
  const fontFirst = ts.fontFamily
    ? ts.fontFamily.split(',')[0]?.replace(/['"]/g, '').trim() || ''
    : '';
  const fontInList = FONT_CHOICES.includes(fontFirst as (typeof FONT_CHOICES)[number]);
  const fontSelectValue = fontFirst && (fontInList || ts.fontFamily) ? fontFirst : 'Calibri';

  const sizeNum = ts.fontSize ? ts.fontSize.replace(/px\s*$/i, '').trim() : '';
  const sizeInList = SIZE_CHOICES.includes(sizeNum as (typeof SIZE_CHOICES)[number]);
  const sizeSelectValue = sizeNum && sizeInList ? sizeNum : sizeNum ? sizeNum : '11';

  const rb = (name: string, label: ReactNode, on: () => void, active?: boolean) => (
    <button
      key={name}
      type="button"
      className={`lc-msword-ribbon-btn${active ? ' is-active' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => on()}
      title={name}
    >
      {label}
    </button>
  );

  return (
    <div className="lc-word-app lc-msword">
      <div className="lc-msword-ribbon-wrap">
        <div className="lc-msword-tabs" role="tablist" aria-label="Вкладки ленты">
          <span className="lc-msword-tab lc-msword-tab--active" role="tab" aria-selected="true">
            Главная
          </span>
          <span className="lc-msword-tab lc-msword-tab--idle" role="tab" aria-selected="false">
            Вставка
          </span>
          <span className="lc-msword-tab lc-msword-tab--idle" role="tab" aria-selected="false">
            Разметка страницы
          </span>
          <span className="lc-msword-tab lc-msword-tab--idle" role="tab" aria-selected="false">
            Ссылки
          </span>
        </div>
        <div className="lc-msword-ribbon-panel" role="toolbar" aria-label="Главная">
          <div className="lc-msword-group">
            <div className="lc-msword-group-inner">
              <div className="lc-msword-group-row">
                <button
                  type="button"
                  className="lc-msword-ribbon-btn lc-msword-ribbon-btn--stack"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void pasteFromClipboard(editor)}
                  title="Вставить из буфера"
                >
                  <span className="lc-msword-ico lc-msword-ico-paste" aria-hidden />
                  <span className="lc-msword-ribbon-btn-cap">Вставить</span>
                </button>
                <div className="lc-msword-mini-col">
                  <button
                    type="button"
                    className="lc-msword-ribbon-btn lc-msword-ribbon-btn--lite"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => cutSelection(editor)}
                    title="Вырезать"
                  >
                    Вырезать
                  </button>
                  <button
                    type="button"
                    className="lc-msword-ribbon-btn lc-msword-ribbon-btn--lite"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => copySelection(editor)}
                    title="Копировать"
                  >
                    Копировать
                  </button>
                </div>
              </div>
            </div>
            <span className="lc-msword-group-label">Буфер обмена</span>
          </div>
          <div className="lc-msword-vsep" aria-hidden />
          <div className="lc-msword-group lc-msword-group--font">
            <div className="lc-msword-group-inner">
              <div className="lc-msword-font-row">
                <select
                  className="lc-msword-select lc-msword-select--font"
                  aria-label="Шрифт"
                  value={fontSelectValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === 'Calibri') editor.chain().focus().unsetFontFamily().run();
                    else editor.chain().focus().setFontFamily(v).run();
                  }}
                >
                  {fontFirst && !fontInList ? (
                    <option value={fontFirst}>{fontFirst}</option>
                  ) : null}
                  {FONT_CHOICES.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <select
                  className="lc-msword-select lc-msword-select--size"
                  aria-label="Размер"
                  value={sizeSelectValue}
                  onChange={(e) => {
                    const px = `${e.target.value}px`;
                    editor.chain().focus().setFontSize(px).run();
                  }}
                >
                  {sizeNum && !sizeInList ? (
                    <option value={sizeNum}>
                      {sizeNum}
                    </option>
                  ) : null}
                  {SIZE_CHOICES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <input
                  type="color"
                  className="lc-msword-font-color"
                  title="Цвет текста"
                  aria-label="Цвет текста"
                  value={normalizeHexFromColorAttr(ts.color, '#e8eaef')}
                  onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
                  onMouseDown={(e) => e.preventDefault()}
                />
              </div>
              <div className="lc-msword-group-row">
                {rb('bold', <strong className="lc-msword-ribbon-cap">Ж</strong>, () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
                {rb('italic', <em className="lc-msword-ribbon-cap">К</em>, () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
                {rb(
                  'strike',
                  <span className="lc-msword-ribbon-cap lc-msword-strike-cap">abc</span>,
                  () => editor.chain().focus().toggleStrike().run(),
                  editor.isActive('strike')
                )}
                {rb('code', <span className="lc-msword-ribbon-cap mono">&lt;/&gt;</span>, () => editor.chain().focus().toggleCode().run(), editor.isActive('code'))}
              </div>
            </div>
            <span className="lc-msword-group-label">Шрифт</span>
          </div>
          <div className="lc-msword-vsep" aria-hidden />
          <div className="lc-msword-group">
            <div className="lc-msword-group-inner">
              <div className="lc-msword-group-row">
                {rb('h2', 'Заголовок 1', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
                {rb('h3', 'Заголовок 2', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive('heading', { level: 3 }))}
                {rb('p', 'Обычный', () => editor.chain().focus().setParagraph().run(), editor.isActive('paragraph'))}
              </div>
              <div className="lc-msword-group-row">
                {rb('bullet', '• Маркеры', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
                {rb('ordered', '1. Нумерация', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
              </div>
            </div>
            <span className="lc-msword-group-label">Абзац</span>
          </div>
          <div className="lc-msword-vsep" aria-hidden />
          <div className="lc-msword-group">
            <div className="lc-msword-group-inner">
              <div className="lc-msword-group-row">
                {rb('quote', 'Цитата', () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'))}
                {rb('rule', 'Линия', () => editor.chain().focus().setHorizontalRule().run(), false)}
              </div>
            </div>
            <span className="lc-msword-group-label">Стили</span>
          </div>
          <div className="lc-msword-vsep" aria-hidden />
          <div className="lc-msword-group">
            <div className="lc-msword-group-inner">
              <div className="lc-msword-group-row lc-msword-group-row--file">
                <button
                  type="button"
                  className="lc-msword-ribbon-btn lc-msword-ribbon-btn--file"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const html = editor.getHTML();
                    const doc = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${docName.replace(/</g, '')}</title></head><body>${html}</body></html>`;
                    const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${docName.replace(/[/\\?%*:|"<>]/g, '-')}.html`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                >
                  Сохранить как HTML
                </button>
                <button
                  type="button"
                  className="lc-msword-ribbon-btn lc-msword-ribbon-btn--file"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => fileRef.current?.click()}
                >
                  Открыть…
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".html,.htm,text/html,text/plain"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    const r = new FileReader();
                    r.onload = () => {
                      const t = String(r.result || '');
                      const bodyMatch = t.match(/<body[^>]*>([\s\S]*)<\/body>/i);
                      const inner = bodyMatch ? bodyMatch[1] : t;
                      editor.commands.setContent(sanitizeExternalHtml(inner));
                    };
                    r.readAsText(f);
                  }}
                />
              </div>
            </div>
            <span className="lc-msword-group-label">Файл</span>
          </div>
        </div>
      </div>
      <div className="lc-word-page-wrap lc-msword-page-stage">
        <div className="lc-word-page lc-msword-page">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
