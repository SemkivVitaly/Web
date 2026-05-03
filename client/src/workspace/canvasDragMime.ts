/**
 * @fileoverview Общий MIME для drag-and-drop карточек канбана: одна и та же полезная нагрузка на канвасе
 * и в `CanvasSolutionExplorer`, плюс запасной `text/plain` для совместимости.
 */

/** MIME для перетаскивания с поверхности канваса. */
export const DND_CANVAS_ITEM = 'application/x-localchat-canvas-item';
/** MIME для перетаскивания из дерева-обозревателя. */
export const DND_EXPLORER_ITEM = 'application/x-localchat-explorer-item';

/** Положить id элемента доски во все поддерживаемые форматы `DataTransfer`. */
export function setTaskBoardDragItemData(dt: DataTransfer, itemId: number): void {
  const s = String(itemId);
  dt.setData(DND_CANVAS_ITEM, s);
  dt.setData(DND_EXPLORER_ITEM, s);
  dt.setData('text/plain', s);
  dt.effectAllowed = 'move';
}

/** Прочитать id элемента доски из drop-события (порядок: explorer → canvas → plain text). */
export function readTaskBoardDragItemId(dt: DataTransfer): number | null {
  const raw =
    dt.getData(DND_EXPLORER_ITEM) ||
    dt.getData(DND_CANVAS_ITEM) ||
    dt.getData('text/plain');
  const n = raw.trim() ? +raw : NaN;
  return Number.isFinite(n) ? n : null;
}
