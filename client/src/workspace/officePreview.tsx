/**
 * @fileoverview Предпросмотр вложений Office в задачах (lightbox): .docx через mammoth → HTML, .xlsx/.xls через SheetJS → таблица.
 * Лимит размера загрузки — `OFFICE_PREVIEW_MAX_BYTES`; Excel обрезается по числу строк/столбцов для UI.
 */

import { useEffect, useMemo, useState } from 'react';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import DOMPurify from 'dompurify';

/** Максимум байт тела файла для разбора Word/Excel в браузере. */
export const OFFICE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

const EXCEL_MAX_ROWS = 400;
const EXCEL_MAX_COLS = 32;

/** Подходит ли файл для предпросмотра как Word (по расширению или MIME). */
export function isWordDocxPreviewable(mime?: string | null, fileName?: string | null): boolean {
  const n = (fileName || '').toLowerCase();
  if (n.endsWith('.docx')) return true;
  const m = (mime || '').toLowerCase();
  return (
    m.includes('wordprocessingml.document') ||
    m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

/** Подходит ли файл для предпросмотра как Excel. */
export function isExcelOfficePreviewable(mime?: string | null, fileName?: string | null): boolean {
  const n = (fileName || '').toLowerCase();
  if (n.endsWith('.xlsx') || n.endsWith('.xls')) return true;
  const m = (mime || '').toLowerCase();
  return (
    m.includes('spreadsheetml.sheet') ||
    m === 'application/vnd.ms-excel' ||
    m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

// --- Загрузка с лимитом; компоненты превью ---

async function fetchArrayBufferLimited(url: string, maxBytes: number): Promise<ArrayBuffer> {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const cl = r.headers.get('content-length');
  if (cl != null && cl !== '' && Number(cl) > maxBytes) {
    throw new Error(`Файл больше ${Math.round(maxBytes / (1024 * 1024))} МБ — предпросмотр отключён`);
  }
  const buf = await r.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new Error(`Файл больше ${Math.round(maxBytes / (1024 * 1024))} МБ — предпросмотр отключён`);
  }
  return buf;
}

/**
 * Политика санитайзера для Mammoth. Приложение по дизайну offline/air-gapped: любые внешние
 * http(s)-ссылки (img src, href и т. п.) должны быть запрещены, иначе `<img src="https://…">` из
 * подсунутого .docx автоматически уйдёт во внешнюю сеть и утечёт факт открытия файла.
 * Разрешаем только `data:image/*` (Mammoth кладёт встроенные картинки как base64) и локальные `#`-якоря.
 */
function sanitizeMammothHtml(raw: string): string {
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: /^(?:data:image\/(?:png|jpe?g|gif|webp|bmp)|#)/i,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'style', 'srcset', 'formaction'],
  });
}

/** HTML из .docx в контейнере с классами TipTap. HTML санитизируется через DOMPurify перед вставкой. */
export function TaskWordPreviewBody({ url }: { url: string }) {
  const [state, setState] = useState<'loading' | 'err' | 'ok'>('loading');
  const [html, setHtml] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancel = false;
    setState('loading');
    setHtml('');
    setErr('');
    (async () => {
      try {
        const ab = await fetchArrayBufferLimited(url, OFFICE_PREVIEW_MAX_BYTES);
        const { value, messages } = await mammoth.convertToHtml({ arrayBuffer: ab });
        if (cancel) return;
        if (messages?.length) {
          const warns = messages.filter((m) => m.type === 'error').map((m) => m.message);
          if (warns.length && !value?.trim()) {
            setErr(warns.join('; ') || 'Не удалось разобрать документ');
            setState('err');
            return;
          }
        }
        setHtml(value || '<p class="meta">Документ пустой</p>');
        setState('ok');
      } catch (e) {
        if (cancel) return;
        setErr((e as Error).message || 'Ошибка');
        setState('err');
      }
    })();
    return () => {
      cancel = true;
    };
  }, [url]);

  const safeHtml = useMemo(() => (state === 'ok' ? sanitizeMammothHtml(html) : ''), [html, state]);

  if (state === 'loading') return <p className="meta lc-task-text-preview-status">Разбор Word…</p>;
  if (state === 'err') return <p className="error lc-task-text-preview-status">{err}</p>;
  return (
    <div
      className="lc-office-word-html lc-tiptap"
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
}

/** Первый лист → матрица строк для `<table>` с ограничением размеров. */
function sheetToMatrix(ws: XLSX.WorkSheet): string[][] {
  const ref = ws['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const rows: string[][] = [];
  const lastR = Math.min(range.e.r, range.s.r + EXCEL_MAX_ROWS - 1);
  const lastC = Math.min(range.e.c, range.s.c + EXCEL_MAX_COLS - 1);
  for (let R = range.s.r; R <= lastR; R++) {
    const row: string[] = [];
    for (let C = range.s.c; C <= lastC; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (!cell) {
        row.push('');
        continue;
      }
      if (cell.t === 'z') {
        row.push('');
        continue;
      }
      row.push(String(cell.w != null && cell.w !== '' ? cell.w : cell.v ?? ''));
    }
    rows.push(row);
  }
  return rows;
}

/** Табличный предпросмотр книги Excel; переключение листов при `SheetNames.length > 1`. */
export function TaskExcelPreviewBody({ url }: { url: string }) {
  const [state, setState] = useState<'loading' | 'err' | 'ok'>('loading');
  const [err, setErr] = useState('');
  const [wb, setWb] = useState<XLSX.WorkBook | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    let cancel = false;
    setState('loading');
    setErr('');
    setWb(null);
    setActiveIdx(0);
    (async () => {
      try {
        const ab = await fetchArrayBufferLimited(url, OFFICE_PREVIEW_MAX_BYTES);
        const book = XLSX.read(ab, { type: 'array' });
        if (cancel) return;
        if (!book.SheetNames.length) {
          setErr('В книге нет листов');
          setState('err');
          return;
        }
        setWb(book);
        setState('ok');
      } catch (e) {
        if (cancel) return;
        setErr((e as Error).message || 'Ошибка');
        setState('err');
      }
    })();
    return () => {
      cancel = true;
    };
  }, [url]);

  if (state === 'loading') return <p className="meta lc-task-text-preview-status">Разбор Excel…</p>;
  if (state === 'err') return <p className="error lc-task-text-preview-status">{err}</p>;
  if (!wb) return null;

  const names = wb.SheetNames;
  const sn = names[activeIdx] ?? names[0];
  const sheet = sn ? wb.Sheets[sn] : undefined;
  const matrix = sheet ? sheetToMatrix(sheet) : [];

  return (
    <div className="lc-office-excel-wrap">
      {names.length > 1 && (
        <div className="lc-office-sheet-tabs" role="tablist">
          {names.map((n, i) => (
            <button
              key={n}
              type="button"
              role="tab"
              aria-selected={i === activeIdx}
              className={i === activeIdx ? 'lc-office-sheet-tab lc-office-sheet-tab--active' : 'lc-office-sheet-tab'}
              onClick={() => setActiveIdx(i)}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      <div className="lc-office-excel-scroll">
        <table className="lc-office-preview-table">
          <tbody>
            {matrix.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="meta lc-office-excel-note">
        Показано до {EXCEL_MAX_ROWS} строк и {EXCEL_MAX_COLS} столбцов на листе. Сложное форматирование и диаграммы не
        отображаются.
      </p>
    </div>
  );
}
