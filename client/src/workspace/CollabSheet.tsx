/**
 * @fileoverview Совместная таблица на кастомной модели Yjs (`sheetModel`): сетка, merge ячеек, заливка, формулы, импорт/экспорт xlsx/csv.
 * Обновление UI по событию `update` на `Y.Doc`.
 */

import { useEffect, useState, useCallback, useRef, type ReactNode, type MouseEvent } from 'react';
import * as Y from 'yjs';
import {
  ensureSheet,
  getMaps,
  keyRC,
  mergeCovering,
  isCoveredNonAnchor,
  normalizeRect,
  applyMerge,
  unmergeAt,
  setCellsBackground,
  insertRow,
  deleteRow,
  insertCol,
  deleteCol,
  exportWorkbookBinary,
  exportCsv,
  importWorkbookToYdoc,
  snapshotFromYdoc,
  applySnapshot,
  type SheetSnapshot,
} from './sheetModel';

// --- Подписи колонок A, B, … и проверка попадания ячейки в выделение ---

function colLabel(c: number): string {
  let s = '';
  let n = c;
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function inSel(
  r: number,
  c: number,
  sel: { r1: number; c1: number; r2: number; c2: number } | null,
  focus: { r: number; c: number }
) {
  if (sel) return r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2;
  return r === focus.r && c === focus.c;
}

/**
 * Полноэкранный spreadsheet-редактор на одном `Y.Doc`; при монтировании вызывает `ensureSheet(ydoc)`.
 *
 * @param ydoc — документ коллаба с картой `sheet` (ячейки, merge, стили)
 * @param docName — для подписи кнопок экспорта / заголовка
 */
export function CollabSheet({ ydoc, docName = 'таблица' }: { ydoc: Y.Doc; docName?: string }) {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((x) => x + 1), []);
  const anchorRef = useRef({ r: 0, c: 0 });
  const fileImportRef = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState({ r: 0, c: 0 });
  const [sel, setSel] = useState<{ r1: number; c1: number; r2: number; c2: number } | null>(null);
  const [fillColor, setFillColor] = useState('#fff59d');
  const [formulaDraft, setFormulaDraft] = useState('');
  const formulaInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ensureSheet(ydoc);
    const onUpd = () => bump();
    ydoc.on('update', onUpd);
    return () => {
      ydoc.off('update', onUpd);
    };
  }, [ydoc, bump]);

  const { rows, cols, cells, merges, styles } = getMaps(ydoc);

  const setCell = (r: number, c: number, v: string) => {
    ydoc.transact(() => {
      const rt = ydoc.getMap('sheet');
      let m = rt.get('cells') as Y.Map<string>;
      if (!m) {
        m = new Y.Map();
        rt.set('cells', m);
      }
      let mg = rt.get('merges') as Y.Map<string> | undefined;
      if (!mg) {
        mg = new Y.Map();
        rt.set('merges', mg);
      }
      const cov = mergeCovering(mg, r, c);
      const ar = cov ? cov.anchorR : r;
      const ac = cov ? cov.anchorC : c;
      m.set(keyRC(ar, ac), v);
    });
  };

  const getCell = (r: number, c: number) => {
    const cov = mergeCovering(merges, r, c);
    const ar = cov ? cov.anchorR : r;
    const ac = cov ? cov.anchorC : c;
    return cells?.get(keyRC(ar, ac)) ?? '';
  };

  const getStyle = (r: number, c: number): { bg?: string } => {
    const cov = mergeCovering(merges, r, c);
    const ar = cov ? cov.anchorR : r;
    const ac = cov ? cov.anchorC : c;
    try {
      return JSON.parse(styles?.get(keyRC(ar, ac)) || '{}') as { bg?: string };
    } catch {
      return {};
    }
  };

  const effectiveSel = () => {
    if (sel) return sel;
    return { r1: focus.r, c1: focus.c, r2: focus.r, c2: focus.c };
  };

  const onTdMouseDown = (r: number, c: number, e: MouseEvent<HTMLTableCellElement>) => {
    if (isCoveredNonAnchor(merges, r, c)) return;
    setFocus({ r, c });
    if (e.shiftKey) {
      setSel(normalizeRect(anchorRef.current.r, anchorRef.current.c, r, c));
    } else {
      anchorRef.current = { r, c };
      setSel(null);
    }
    const inp = e.currentTarget.querySelector<HTMLInputElement>('.lc-excel-cell');
    if (inp && e.target !== inp) {
      e.preventDefault();
      inp.focus({ preventScroll: true });
    }
  };

  const downloadXlsx = () => {
    const buf = exportWorkbookBinary(ydoc);
    const blob = new Blob([buf], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${docName.replace(/[/\\?%*:|"<>]/g, '-')}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadCsv = () => {
    const csv = exportCsv(ydoc);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${docName.replace(/[/\\?%*:|"<>]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadJson = () => {
    const snap = snapshotFromYdoc(ydoc);
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${docName.replace(/[/\\?%*:|"<>]/g, '-')}-sheet.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onImportFile = async (f: File) => {
    const name = f.name.toLowerCase();
    const buf = await f.arrayBuffer();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      importWorkbookToYdoc(ydoc, buf);
      bump();
      return;
    }
    if (name.endsWith('.json')) {
      const t = new TextDecoder().decode(buf);
      const snap = JSON.parse(t) as SheetSnapshot;
      if (snap.version === 1 && snap.rows && snap.cols) {
        applySnapshot(ydoc, snap);
        bump();
      }
      return;
    }
    if (name.endsWith('.csv')) {
      const text = new TextDecoder().decode(buf);
      const lines = text.replace(/^\ufeff/, '').split(/\r?\n/).filter((l) => l.length);
      const parsed = lines.map((line) => {
        const out: string[] = [];
        let cur = '';
        let q = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            q = !q;
          } else if (ch === ',' && !q) {
            out.push(cur);
            cur = '';
          } else cur += ch;
        }
        out.push(cur);
        return out;
      });
      const nrows = parsed.length;
      const ncols = Math.max(1, ...parsed.map((r) => r.length));
      const cellsMap = new Y.Map<string>();
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < ncols; c++) {
          const v = parsed[r]?.[c]?.trim() ?? '';
          if (v) cellsMap.set(keyRC(r, c), v);
        }
      }
      ydoc.transact(() => {
        const root = ydoc.getMap('sheet');
        root.set('rows', Math.min(500, nrows));
        root.set('cols', Math.min(64, ncols));
        root.set('cells', cellsMap);
        root.set('merges', new Y.Map());
        root.set('styles', new Y.Map());
        root.set('inited', true);
      });
      bump();
    }
  };

  const tbBtn = (label: string, on: () => void, title?: string) => (
    <button type="button" className="lc-msexcel-ribbon-btn" title={title} onClick={on}>
      {label}
    </button>
  );

  const nameBoxLabel = `${colLabel(focus.c)}${focus.r + 1}`;

  useEffect(() => {
    if (document.activeElement === formulaInputRef.current) return;
    setFormulaDraft(getCell(focus.r, focus.c));
  }, [focus.r, focus.c, rows, cols, tick]);

  const commitFormulaBar = () => {
    const cur = getCell(focus.r, focus.c);
    if (formulaDraft === cur) return;
    setCell(focus.r, focus.c, formulaDraft);
    bump();
  };

  const renderGridRow = (r: number) => {
    const tds: ReactNode[] = [];
    let c = 0;
    while (c < cols) {
      if (isCoveredNonAnchor(merges, r, c)) {
        c += 1;
        continue;
      }
      const cov = mergeCovering(merges, r, c);
      const isAnchor = cov && cov.anchorR === r && cov.anchorC === c;
      const rowspan = isAnchor ? cov!.rowspan : 1;
      const colspan = isAnchor ? cov!.colspan : 1;
      const st = getStyle(r, c);
      const selected = inSel(r, c, sel, focus);
      tds.push(
        <td
          key={`${r}-${c}`}
          className={`lc-excel-cell-wrap${selected ? ' lc-excel-cell-sel' : ''}`}
          rowSpan={rowspan > 1 ? rowspan : undefined}
          colSpan={colspan > 1 ? colspan : undefined}
          onMouseDown={(e) => onTdMouseDown(r, c, e)}
          style={st.bg ? { background: st.bg } : undefined}
        >
          <input
            className="lc-excel-cell"
            value={getCell(r, c)}
            onChange={(e) => setCell(r, c, e.target.value)}
            onFocus={() => setFocus({ r, c })}
            aria-label={`Ячейка ${colLabel(c)}${r + 1}`}
            style={st.bg ? { background: st.bg } : undefined}
          />
        </td>
      );
      c += colspan;
    }
    return (
      <tr key={r}>
        <th className="lc-excel-rowhead" scope="row">
          <div className="lc-excel-rh-inner">
            <button
              type="button"
              className="lc-excel-mini"
              title="Вставить строку выше"
              onClick={() => {
                insertRow(ydoc, r);
                bump();
              }}
            >
              +
            </button>
            <span>{r + 1}</span>
            <button
              type="button"
              className="lc-excel-mini danger"
              title="Удалить строку"
              onClick={() => {
                if (!confirm(`Удалить строку ${r + 1}?`)) return;
                deleteRow(ydoc, r);
                bump();
              }}
            >
              ×
            </button>
          </div>
        </th>
        {tds}
      </tr>
    );
  };

  return (
    <div className="lc-excel-app lc-msexcel">
      <div className="lc-msexcel-tabs" role="tablist" aria-label="Вкладки Excel">
        <span className="lc-msexcel-tab lc-msexcel-tab--active" role="tab" aria-selected="true">
          Главная
        </span>
        <span className="lc-msexcel-tab lc-msexcel-tab--idle" role="tab" aria-selected="false">
          Вставка
        </span>
        <span className="lc-msexcel-tab lc-msexcel-tab--idle" role="tab" aria-selected="false">
          Разметка страницы
        </span>
        <span className="lc-msexcel-tab lc-msexcel-tab--idle" role="tab" aria-selected="false">
          Формулы
        </span>
        <span className="lc-msexcel-tab lc-msexcel-tab--idle" role="tab" aria-selected="false">
          Данные
        </span>
      </div>
      <div className="lc-msexcel-ribbon" role="toolbar" aria-label="Главная">
        <div className="lc-msexcel-group">
          <div className="lc-msexcel-group-inner">
            <div className="lc-msexcel-group-row">
              {tbBtn('Вставить строку', () => {
                insertRow(ydoc, focus.r);
                bump();
              }, 'Вставить строку выше текущей')}
              {tbBtn('Удалить строку', () => {
                if (confirm(`Удалить строку ${focus.r + 1}?`)) {
                  deleteRow(ydoc, focus.r);
                  bump();
                }
              }, 'Удалить текущую строку')}
            </div>
          </div>
          <span className="lc-msexcel-group-label">Ячейки</span>
        </div>
        <div className="lc-msexcel-vsep" aria-hidden />
        <div className="lc-msexcel-group">
          <div className="lc-msexcel-group-inner">
            <div className="lc-msexcel-group-row">
              {tbBtn('Вставить столбец', () => {
                insertCol(ydoc, focus.c);
                bump();
              }, 'Вставить столбец слева')}
              {tbBtn('Удалить столбец', () => {
                if (confirm(`Удалить столбец ${colLabel(focus.c)}?`)) {
                  deleteCol(ydoc, focus.c);
                  bump();
                }
              }, 'Удалить текущий столбец')}
            </div>
          </div>
          <span className="lc-msexcel-group-label">Столбцы</span>
        </div>
        <div className="lc-msexcel-vsep" aria-hidden />
        <div className="lc-msexcel-group">
          <div className="lc-msexcel-group-inner">
            <div className="lc-msexcel-group-row">
              {tbBtn('Объединить', () => {
                const b = effectiveSel();
                applyMerge(ydoc, b.r1, b.c1, b.r2, b.c2);
                setSel(null);
                bump();
              }, 'Объединить выделение (Shift+клик)')}
              {tbBtn('Разъединить', () => {
                unmergeAt(ydoc, focus.r, focus.c);
                bump();
              }, 'Разъединить ячейку')}
            </div>
          </div>
          <span className="lc-msexcel-group-label">Выравнивание</span>
        </div>
        <div className="lc-msexcel-vsep" aria-hidden />
        <div className="lc-msexcel-group">
          <div className="lc-msexcel-group-inner">
            <div className="lc-msexcel-group-row lc-msexcel-group-row--fill">
              <input
                type="color"
                className="lc-msexcel-color"
                value={fillColor}
                onChange={(e) => setFillColor(e.target.value)}
                title="Цвет заливки"
                aria-label="Цвет заливки"
              />
              {tbBtn('Заливка', () => {
                const b = effectiveSel();
                setCellsBackground(ydoc, b.r1, b.c1, b.r2, b.c2, fillColor);
                bump();
              }, 'Залить выделенный диапазон')}
            </div>
          </div>
          <span className="lc-msexcel-group-label">Шрифт</span>
        </div>
        <div className="lc-msexcel-vsep" aria-hidden />
        <div className="lc-msexcel-group">
          <div className="lc-msexcel-group-inner">
            <div className="lc-msexcel-group-row lc-msexcel-group-row--file">
              {tbBtn('Сохранить .xlsx', downloadXlsx)}
              {tbBtn('CSV', downloadCsv)}
              {tbBtn('JSON', downloadJson)}
              {tbBtn('Открыть…', () => fileImportRef.current?.click())}
              <input
                ref={fileImportRef}
                type="file"
                accept=".xlsx,.xls,.csv,.json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void onImportFile(f);
                }}
              />
            </div>
          </div>
          <span className="lc-msexcel-group-label">Файл</span>
        </div>
      </div>
      <div className="lc-msexcel-formula-bar" role="group" aria-label="Строка формул">
        <div className="lc-msexcel-name-box" title="Имя ячейки">
          {nameBoxLabel}
        </div>
        <span className="lc-msexcel-fx-ico" aria-hidden>
          ƒ<sub>x</sub>
        </span>
        <input
          ref={formulaInputRef}
          type="text"
          className="lc-msexcel-formula-input"
          value={formulaDraft}
          onChange={(e) => setFormulaDraft(e.target.value)}
          onBlur={() => commitFormulaBar()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitFormulaBar();
              formulaInputRef.current?.blur();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setFormulaDraft(getCell(focus.r, focus.c));
              formulaInputRef.current?.blur();
            }
          }}
          title="Строка формул: редактирование активной ячейки (Enter — применить, Esc — отменить)"
          aria-label="Строка формул"
        />
        {sel ? (
          <div className="lc-msexcel-sel-badge" title="Выделенный диапазон">
            {colLabel(effectiveSel().c1)}
            {effectiveSel().r1 + 1}:{colLabel(effectiveSel().c2)}
            {effectiveSel().r2 + 1}
          </div>
        ) : null}
      </div>
      <div className="lc-excel-scroll lc-msexcel-grid-wrap">
        <table className="lc-excel-grid">
          <thead>
            <tr>
              <th className="lc-excel-corner" scope="col" />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} className="lc-excel-colhead" scope="col">
                  <div className="lc-excel-ch-inner">
                    <button
                      type="button"
                      className="lc-excel-mini"
                      title="Вставить столбец слева"
                      onClick={() => {
                        insertCol(ydoc, c);
                        bump();
                      }}
                    >
                      +
                    </button>
                    <span>{colLabel(c)}</span>
                    <button
                      type="button"
                      className="lc-excel-mini danger"
                      title="Удалить столбец"
                      onClick={() => {
                        if (!confirm(`Удалить столбец ${colLabel(c)}?`)) return;
                        deleteCol(ydoc, c);
                        bump();
                      }}
                    >
                      ×
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{Array.from({ length: rows }, (_, r) => renderGridRow(r))}</tbody>
        </table>
      </div>
      <footer className="lc-msexcel-statusbar">
        <span className="lc-msexcel-status-left">Готово</span>
        <span className="lc-msexcel-status-hint">
          Выделение: Shift+клик по углу · объединение и заливка по выделению
        </span>
        <span className="lc-msexcel-status-zoom" aria-hidden>
          100%
        </span>
      </footer>
    </div>
  );
}
