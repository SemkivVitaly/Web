/**
 * @fileoverview Модель совместной таблицы в Yjs: под картой `sheet` хранятся размеры сетки, `cells`/`merges`/`styles` с ключами `row,col`.
 * Есть объединение ячеек, заливка, вставка и удаление строк/столбцов со сдвигом данных, снимок для копирования состояния,
 * импорт первого листа из Excel/CSV и экспорт в xlsx/csv через SheetJS (`xlsx`).
 */

import * as Y from 'yjs';
import * as XLSX from 'xlsx';

export type MergeInfo = { rowspan: number; colspan: number };
export type CellStyle = { bg?: string };

/** Ключ ячейки в `Y.Map` — координаты через запятую. */
export function keyRC(r: number, c: number) {
  return `${r},${c}`;
}

/** Обратно к числовым индексам строки и столбца. */
export function parseKey(k: string): [number, number] {
  const [r, c] = k.split(',').map(Number);
  return [r, c];
}

/** Создать структуру `sheet` в документе, если её ещё нет (идемпотентно). */
export function ensureSheet(ydoc: Y.Doc) {
  ydoc.transact(() => {
    const root = ydoc.getMap('sheet');
    if (!root.get('inited')) {
      root.set('inited', true);
      root.set('cols', 8);
      root.set('rows', 24);
      root.set('cells', new Y.Map());
      root.set('merges', new Y.Map());
      root.set('styles', new Y.Map());
    } else {
      if (!root.get('merges')) root.set('merges', new Y.Map());
      if (!root.get('styles')) root.set('styles', new Y.Map());
    }
  });
}

/** Удобный доступ к корню и вложенным картам/числам размеров. */
export function getMaps(ydoc: Y.Doc) {
  const root = ydoc.getMap('sheet');
  return {
    root,
    rows: (root.get('rows') as number) || 24,
    cols: (root.get('cols') as number) || 8,
    cells: (root.get('cells') as Y.Map<string>) || new Y.Map<string>(),
    merges: (root.get('merges') as Y.Map<string>) || new Y.Map<string>(),
    styles: (root.get('styles') as Y.Map<string>) || new Y.Map<string>(),
  };
}

// --- Объединения ячеек и нормализация прямоугольника выделения ---

/** Якорь объединения, покрывающего (r,c), или null */
export function mergeCovering(
  merges: Y.Map<string> | undefined,
  r: number,
  c: number
): { anchorR: number; anchorC: number; rowspan: number; colspan: number } | null {
  if (!merges) return null;
  for (const k of merges.keys()) {
    const [ar, ac] = parseKey(k);
    let info: MergeInfo;
    try {
      info = JSON.parse(merges.get(k) || '{}') as MergeInfo;
    } catch {
      continue;
    }
    if (!info.rowspan || !info.colspan) continue;
    if (r >= ar && r < ar + info.rowspan && c >= ac && c < ac + info.colspan) {
      return { anchorR: ar, anchorC: ac, rowspan: info.rowspan, colspan: info.colspan };
    }
  }
  return null;
}

export function isCoveredNonAnchor(merges: Y.Map<string> | undefined, r: number, c: number): boolean {
  const m = mergeCovering(merges, r, c);
  return m != null && (m.anchorR !== r || m.anchorC !== c);
}

export function normalizeRect(r1: number, c1: number, r2: number, c2: number) {
  return {
    r1: Math.min(r1, r2),
    c1: Math.min(c1, c2),
    r2: Math.max(r1, r2),
    c2: Math.max(c1, c2),
  };
}

function removeMergesOverlapping(merges: Y.Map<string>, rect: ReturnType<typeof normalizeRect>) {
  const toDel: string[] = [];
  for (const k of merges.keys()) {
    const [ar, ac] = parseKey(k);
    let info: MergeInfo;
    try {
      info = JSON.parse(merges.get(k) || '{}') as MergeInfo;
    } catch {
      toDel.push(k);
      continue;
    }
    const er = ar + info.rowspan - 1;
    const ec = ac + info.colspan - 1;
    const overlap = !(er < rect.r1 || ar > rect.r2 || ec < rect.c1 || ac > rect.c2);
    if (overlap) toDel.push(k);
  }
  for (const k of toDel) merges.delete(k);
}

export function applyMerge(ydoc: Y.Doc, r1: number, c1: number, r2: number, c2: number) {
  const { r1: a, c1: b, r2: d, c2: e } = normalizeRect(r1, c1, r2, c2);
  const rowspan = d - a + 1;
  const colspan = e - b + 1;
  if (rowspan === 1 && colspan === 1) return;
  ydoc.transact(() => {
    const { merges } = getMaps(ydoc);
    removeMergesOverlapping(merges, { r1: a, c1: b, r2: d, c2: e });
    merges.set(keyRC(a, b), JSON.stringify({ rowspan, colspan }));
  });
}

export function unmergeAt(ydoc: Y.Doc, r: number, c: number) {
  ydoc.transact(() => {
    const { merges } = getMaps(ydoc);
    const m = mergeCovering(merges, r, c);
    if (!m) return;
    merges.delete(keyRC(m.anchorR, m.anchorC));
  });
}

// --- Заливка диапазона и сброс стиля одной ячейки ---

export function setCellsBackground(ydoc: Y.Doc, r1: number, c1: number, r2: number, c2: number, bg: string) {
  const { r1: a, c1: b, r2: d, c2: e } = normalizeRect(r1, c1, r2, c2);
  ydoc.transact(() => {
    const { styles, merges } = getMaps(ydoc);
    for (let r = a; r <= d; r++) {
      for (let c = b; c <= e; c++) {
        if (isCoveredNonAnchor(merges, r, c)) continue;
        const k = keyRC(r, c);
        let cur: CellStyle = {};
        try {
          cur = JSON.parse(styles.get(k) || '{}') as CellStyle;
        } catch {
          /* noop */
        }
        cur.bg = bg;
        styles.set(k, JSON.stringify(cur));
      }
    }
  });
}

export function clearCellStyle(ydoc: Y.Doc, r: number, c: number) {
  ydoc.transact(() => {
    const { styles } = getMaps(ydoc);
    styles.delete(keyRC(r, c));
  });
}

// --- Сдвиг ключей в maps и merges при insert/delete строки или столбца ---

function shiftMapRows(
  m: Y.Map<string>,
  pivot: number,
  delta: number,
  parser: (v: string) => string = (x) => x
) {
  const keys = [...m.keys()];
  const updates: [string, string][] = [];
  const dels: string[] = [];
  for (const k of keys) {
    const [r, c] = parseKey(k);
    if (delta > 0 && r >= pivot) {
      dels.push(k);
      updates.push([keyRC(r + delta, c), parser(m.get(k) || '')]);
    } else if (delta < 0 && r > pivot) {
      dels.push(k);
      updates.push([keyRC(r + delta, c), parser(m.get(k) || '')]);
    } else if (delta < 0 && r === pivot) {
      dels.push(k);
    }
  }
  for (const k of dels) m.delete(k);
  for (const [k, v] of updates) m.set(k, v);
}

function shiftMergeRows(merges: Y.Map<string>, pivot: number, delta: number) {
  const keys = [...merges.keys()];
  const next = new Map<string, string>();
  for (const k of keys) {
    const [ar, ac] = parseKey(k);
    let info: MergeInfo;
    try {
      info = JSON.parse(merges.get(k) || '{}') as MergeInfo;
    } catch {
      merges.delete(k);
      continue;
    }
    merges.delete(k);
    if (delta > 0) {
      if (ar >= pivot) {
        next.set(keyRC(ar + delta, ac), JSON.stringify(info));
      } else if (ar < pivot && ar + info.rowspan > pivot) {
        next.set(keyRC(ar, ac), JSON.stringify({ ...info, rowspan: info.rowspan + delta }));
      } else {
        next.set(keyRC(ar, ac), JSON.stringify(info));
      }
    } else {
      if (ar === pivot) {
        /* удаляем строку — снимаем объединение с этой строкой */
        continue;
      }
      if (ar > pivot) {
        next.set(keyRC(ar + delta, ac), JSON.stringify(info));
      } else if (ar < pivot && ar + info.rowspan - 1 >= pivot) {
        const nr = info.rowspan - 1;
        if (nr >= 1 && (nr > 1 || info.colspan > 1)) next.set(keyRC(ar, ac), JSON.stringify({ rowspan: nr, colspan: info.colspan }));
      } else {
        next.set(keyRC(ar, ac), JSON.stringify(info));
      }
    }
  }
  for (const [k, v] of next) merges.set(k, v);
}

function shiftMapCols(m: Y.Map<string>, pivot: number, delta: number) {
  const keys = [...m.keys()];
  const updates: [string, string][] = [];
  const dels: string[] = [];
  for (const k of keys) {
    const [r, c] = parseKey(k);
    if (delta > 0 && c >= pivot) {
      dels.push(k);
      updates.push([keyRC(r, c + delta), m.get(k) || '']);
    } else if (delta < 0 && c > pivot) {
      dels.push(k);
      updates.push([keyRC(r, c + delta), m.get(k) || '']);
    } else if (delta < 0 && c === pivot) {
      dels.push(k);
    }
  }
  for (const k of dels) m.delete(k);
  for (const [k, v] of updates) m.set(k, v);
}

function shiftMergeCols(merges: Y.Map<string>, pivot: number, delta: number) {
  const keys = [...merges.keys()];
  const next = new Map<string, string>();
  for (const k of keys) {
    const [ar, ac] = parseKey(k);
    let info: MergeInfo;
    try {
      info = JSON.parse(merges.get(k) || '{}') as MergeInfo;
    } catch {
      merges.delete(k);
      continue;
    }
    merges.delete(k);
    if (delta > 0) {
      if (ac >= pivot) {
        next.set(keyRC(ar, ac + delta), JSON.stringify(info));
      } else if (ac < pivot && ac + info.colspan > pivot) {
        next.set(keyRC(ar, ac), JSON.stringify({ ...info, colspan: info.colspan + delta }));
      } else {
        next.set(keyRC(ar, ac), JSON.stringify(info));
      }
    } else {
      if (ac === pivot) continue;
      if (ac > pivot) {
        next.set(keyRC(ar, ac + delta), JSON.stringify(info));
      } else if (ac < pivot && ac + info.colspan - 1 >= pivot) {
        const nc = info.colspan - 1;
        if (nc >= 1 && (nc > 1 || info.rowspan > 1))
          next.set(keyRC(ar, ac), JSON.stringify({ rowspan: info.rowspan, colspan: nc }));
      } else {
        next.set(keyRC(ar, ac), JSON.stringify(info));
      }
    }
  }
  for (const [k, v] of next) merges.set(k, v);
}

// --- Вставка и удаление строк/столбцов (со сдвигом cells/merges/styles) ---

export function insertRow(ydoc: Y.Doc, atRow: number) {
  ydoc.transact(() => {
    const { root, rows, cells, merges, styles } = getMaps(ydoc);
    shiftMapRows(cells, atRow, 1);
    shiftMapRows(styles, atRow, 1);
    shiftMergeRows(merges, atRow, 1);
    root.set('rows', rows + 1);
  });
}

export function deleteRow(ydoc: Y.Doc, atRow: number) {
  ydoc.transact(() => {
    const { root, rows, cells, merges, styles } = getMaps(ydoc);
    if (rows <= 1) return;
    shiftMapRows(cells, atRow, -1);
    shiftMapRows(styles, atRow, -1);
    shiftMergeRows(merges, atRow, -1);
    root.set('rows', rows - 1);
  });
}

export function insertCol(ydoc: Y.Doc, atCol: number) {
  ydoc.transact(() => {
    const { root, cols, cells, merges, styles } = getMaps(ydoc);
    shiftMapCols(cells, atCol, 1);
    shiftMapCols(styles, atCol, 1);
    shiftMergeCols(merges, atCol, 1);
    root.set('cols', cols + 1);
  });
}

export function deleteCol(ydoc: Y.Doc, atCol: number) {
  ydoc.transact(() => {
    const { root, cols, cells, merges, styles } = getMaps(ydoc);
    if (cols <= 1) return;
    shiftMapCols(cells, atCol, -1);
    shiftMapCols(styles, atCol, -1);
    shiftMergeCols(merges, atCol, -1);
    root.set('cols', cols - 1);
  });
}

// --- Снимок для клонирования листа; экспорт/импорт через SheetJS ---

export type SheetSnapshot = {
  version: 1;
  rows: number;
  cols: number;
  cells: Record<string, string>;
  merges: Record<string, MergeInfo>;
  styles: Record<string, CellStyle>;
};

export function snapshotFromYdoc(ydoc: Y.Doc): SheetSnapshot {
  const { rows, cols, cells, merges, styles } = getMaps(ydoc);
  const c: Record<string, string> = {};
  const mg: Record<string, MergeInfo> = {};
  const st: Record<string, CellStyle> = {};
  for (const k of cells.keys()) c[k] = cells.get(k) || '';
  for (const k of merges.keys()) {
    try {
      mg[k] = JSON.parse(merges.get(k) || '{}') as MergeInfo;
    } catch {
      /* skip */
    }
  }
  for (const k of styles.keys()) {
    try {
      st[k] = JSON.parse(styles.get(k) || '{}') as CellStyle;
    } catch {
      /* skip */
    }
  }
  return { version: 1, rows, cols, cells: c, merges: mg, styles: st };
}

export function applySnapshot(ydoc: Y.Doc, snap: SheetSnapshot) {
  ydoc.transact(() => {
    const root = ydoc.getMap('sheet');
    root.set('rows', Math.max(1, Math.min(500, snap.rows)));
    root.set('cols', Math.max(1, Math.min(64, snap.cols)));
    const cells = new Y.Map<string>();
    const merges = new Y.Map<string>();
    const styles = new Y.Map<string>();
    for (const [k, v] of Object.entries(snap.cells || {})) cells.set(k, v);
    for (const [k, v] of Object.entries(snap.merges || {}))
      merges.set(k, JSON.stringify({ rowspan: v.rowspan, colspan: v.colspan }));
    for (const [k, v] of Object.entries(snap.styles || {})) styles.set(k, JSON.stringify(v));
    root.set('cells', cells);
    root.set('merges', merges);
    root.set('styles', styles);
    root.set('inited', true);
  });
}

/** Одна вкладка «Лист1» в формате xlsx (бинарный ArrayBuffer). */
export function exportWorkbookBinary(ydoc: Y.Doc): ArrayBuffer {
  const { rows, cols, cells, merges, styles } = getMaps(ydoc);
  const ws: XLSX.WorkSheet = {};
  const mergeList: XLSX.Range[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const v = cells.get(keyRC(r, c)) || '';
      let fill: XLSX.CellObject['s'] | undefined;
      const rawSt = styles.get(keyRC(r, c));
      if (rawSt) {
        try {
          const o = JSON.parse(rawSt) as CellStyle;
          if (o.bg) {
            const rgb = o.bg.replace('#', '');
            fill = {
              fill: { patternType: 'solid', fgColor: { rgb: rgb.length === 6 ? `FF${rgb}` : rgb } },
            };
          }
        } catch {
          /* noop */
        }
      }
      if (!v && !fill) continue;
      const cell: XLSX.CellObject = v ? { t: 's', v } : { t: 's', v: '' };
      if (fill) cell.s = fill;
      ws[addr] = cell;
    }
  }
  for (const k of merges.keys()) {
    try {
      const [ar, ac] = parseKey(k);
      const info = JSON.parse(merges.get(k) || '{}') as MergeInfo;
      mergeList.push({
        s: { r: ar, c: ac },
        e: { r: ar + info.rowspan - 1, c: ac + info.colspan - 1 },
      });
    } catch {
      /* noop */
    }
  }
  if (mergeList.length) ws['!merges'] = mergeList;
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(0, rows - 1), c: Math.max(0, cols - 1) },
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Лист1');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

function applyWorkbookFirstSheetToYdoc(ydoc: Y.Doc, wb: XLSX.WorkBook) {
  const sn = wb.SheetNames[0];
  if (!sn) {
    ensureSheet(ydoc);
    return;
  }
  const ws = wb.Sheets[sn];
  const ref = ws['!ref'] || 'A1';
  const range = XLSX.utils.decode_range(ref);
  const rows = range.e.r - range.s.r + 1;
  const cols = range.e.c - range.s.c + 1;
  const cells = new Y.Map<string>();
  const merges = new Y.Map<string>();
  const styles = new Y.Map<string>();
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr] as XLSX.CellObject | undefined;
      if (!cell) continue;
      const rr = r - range.s.r;
      const cc = c - range.s.c;
      const k = keyRC(rr, cc);
      const val =
        cell.w != null
          ? String(cell.w)
          : cell.v != null
            ? String(cell.v)
            : '';
      if (val) cells.set(k, val);
      const s = cell.s as { fill?: { fgColor?: { rgb?: string } } } | undefined;
      const rgb = s?.fill?.fgColor?.rgb;
      if (rgb) {
        const hex = rgb.length >= 6 ? `#${rgb.slice(-6)}` : `#${rgb}`;
        styles.set(k, JSON.stringify({ bg: hex }));
      }
    }
  }
  const rawMerges = ws['!merges'] || [];
  for (const m of rawMerges) {
    const ar = m.s.r - range.s.r;
    const ac = m.s.c - range.s.c;
    const rowspan = m.e.r - m.s.r + 1;
    const colspan = m.e.c - m.s.c + 1;
    if (rowspan > 1 || colspan > 1) merges.set(keyRC(ar, ac), JSON.stringify({ rowspan, colspan }));
  }
  ydoc.transact(() => {
    const root = ydoc.getMap('sheet');
    root.set('inited', true);
    root.set('rows', Math.min(500, Math.max(1, rows)));
    root.set('cols', Math.min(64, Math.max(1, cols)));
    root.set('cells', cells);
    root.set('merges', merges);
    root.set('styles', styles);
  });
}

/** Заменить содержимое `sheet` первым листом из бинарной книги. */
export function importWorkbookToYdoc(ydoc: Y.Doc, data: ArrayBuffer) {
  const wb = XLSX.read(data, { type: 'array', cellStyles: true });
  applyWorkbookFirstSheetToYdoc(ydoc, wb);
}

/** Импорт первого листа из .xlsx / .xls или CSV (по расширению имени файла). */
export function importSpreadsheetFileToYdoc(ydoc: Y.Doc, file: File, data: ArrayBuffer) {
  const lower = file.name.toLowerCase();
  let wb: XLSX.WorkBook;
  if (lower.endsWith('.csv')) {
    wb = XLSX.read(new TextDecoder('utf-8').decode(data), { type: 'string' });
  } else {
    wb = XLSX.read(data, { type: 'array', cellStyles: true });
  }
  applyWorkbookFirstSheetToYdoc(ydoc, wb);
}

/** Текст CSV по текущей сетке (экранирование кавычек и запятых). */
export function exportCsv(ydoc: Y.Doc): string {
  const { rows, cols, cells } = getMaps(ydoc);
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      const v = (cells.get(keyRC(r, c)) || '').replace(/"/g, '""');
      row.push(v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v}"` : v);
    }
    lines.push(row.join(','));
  }
  return lines.join('\n');
}
