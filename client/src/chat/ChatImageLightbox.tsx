/**
 * @fileoverview Полноэкранный просмотр одного или нескольких фото (стрелки, Escape, счётчик, zoom).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type ChatImageLightboxItem = {
  url: string;
  alt?: string;
};

type Props = {
  items: ChatImageLightboxItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  /** aria-label диалога, по умолчанию «Фото» */
  ariaLabel?: string;
  /** Открыть редактор рисования для текущего фото */
  onAnnotate?: () => void;
};

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.35;
const DOUBLE_CLICK_SCALE = 2;
const WHEEL_SENSITIVITY = 0.002;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function zoomTowardPoint(
  prevScale: number,
  nextScale: number,
  pan: { x: number; y: number },
  point: { x: number; y: number }
) {
  if (nextScale <= MIN_SCALE) return { x: 0, y: 0 };
  const ratio = nextScale / prevScale;
  return {
    x: point.x - ratio * (point.x - pan.x),
    y: point.y - ratio * (point.y - pan.y),
  };
}

export function ChatImageLightbox({
  items,
  index,
  onClose,
  onIndexChange,
  ariaLabel = 'Фото',
  onAnnotate,
}: Props) {
  const item = items[index];
  const hasMany = items.length > 1;
  const canPrev = hasMany && index > 0;
  const canNext = hasMany && index < items.length - 1;

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(scale);
  const panRef = useRef(pan);
  scaleRef.current = scale;
  panRef.current = pan;

  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; scale: number; pan: { x: number; y: number } } | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const resetZoom = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    dragRef.current = null;
    pinchRef.current = null;
    pointersRef.current.clear();
  }, []);

  useEffect(() => {
    resetZoom();
  }, [index, resetZoom]);

  const viewportPoint = useCallback((clientX: number, clientY: number) => {
    const el = viewportRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    };
  }, []);

  const applyScale = useCallback(
    (nextScale: number, anchor?: { x: number; y: number }) => {
      const prevScale = scaleRef.current;
      const clamped = clampScale(nextScale);
      if (clamped <= MIN_SCALE) {
        resetZoom();
        return;
      }
      const point = anchor ?? { x: 0, y: 0 };
      setPan(zoomTowardPoint(prevScale, clamped, panRef.current, point));
      setScale(clamped);
    },
    [resetZoom]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowLeft' && canPrev) {
        e.preventDefault();
        onIndexChange(index - 1);
        return;
      }
      if (e.key === 'ArrowRight' && canNext) {
        e.preventDefault();
        onIndexChange(index + 1);
        return;
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        applyScale(scaleRef.current + ZOOM_STEP);
        return;
      }
      if (e.key === '-') {
        e.preventDefault();
        applyScale(scaleRef.current - ZOOM_STEP);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyScale, canNext, canPrev, index, onClose, onIndexChange]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const prevScale = scaleRef.current;
      const nextScale = clampScale(prevScale * (1 - e.deltaY * WHEEL_SENSITIVITY));
      if (nextScale === prevScale) return;
      const point = viewportPoint(e.clientX, e.clientY);
      if (nextScale <= MIN_SCALE) {
        resetZoom();
        return;
      }
      setPan(zoomTowardPoint(prevScale, nextScale, panRef.current, point));
      setScale(nextScale);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [index, resetZoom, viewportPoint]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchRef.current = { dist, scale: scaleRef.current, pan: { ...panRef.current } };
      dragRef.current = null;
      setDragging(false);
      return;
    }

    if (scaleRef.current > MIN_SCALE) {
      dragRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX: panRef.current.x,
        panY: panRef.current.y,
      };
      setDragging(true);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2 && pinchRef.current) {
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchRef.current.dist <= 0) return;
      const ratio = dist / pinchRef.current.dist;
      const nextScale = clampScale(pinchRef.current.scale * ratio);
      if (nextScale <= MIN_SCALE) {
        resetZoom();
        return;
      }
      setScale(nextScale);
      setPan(pinchRef.current.pan);
      return;
    }

    if (dragRef.current && scaleRef.current > MIN_SCALE) {
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      setPan({
        x: dragRef.current.panX + dx,
        y: dragRef.current.panY + dy,
      });
    }
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) {
      dragRef.current = null;
      setDragging(false);
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (scaleRef.current > MIN_SCALE + 0.01) {
      resetZoom();
      return;
    }
    applyScale(DOUBLE_CLICK_SCALE, viewportPoint(e.clientX, e.clientY));
  };

  if (!item) return null;

  const zoomPercent = Math.round(scale * 100);
  const canZoomOut = scale > MIN_SCALE;
  const canZoomIn = scale < MAX_SCALE;

  return createPortal(
    <div
      className="modal-backdrop lc-chat-doc-img-lightbox"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="lc-chat-doc-img-lightbox-inner"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="lc-task-file-lightbox-close"
          aria-label="Закрыть"
          onClick={onClose}
        >
          ×
        </button>
        {onAnnotate && (
          <button
            type="button"
            className="lc-chat-img-lightbox-annotate"
            aria-label="Рисовать на фото"
            title="Рисовать на фото"
            onClick={(e) => {
              e.stopPropagation();
              onAnnotate();
            }}
          >
            ✏️
          </button>
        )}
        {hasMany && (
          <div className="lc-chat-img-lightbox-counter" aria-live="polite">
            {index + 1} / {items.length}
          </div>
        )}
        {canPrev && (
          <button
            type="button"
            className="lc-chat-img-lightbox-nav lc-chat-img-lightbox-nav--prev"
            aria-label="Предыдущее фото"
            onClick={() => onIndexChange(index - 1)}
          >
            ‹
          </button>
        )}
        <div
          ref={viewportRef}
          className={`lc-chat-img-lightbox-viewport${dragging ? ' lc-chat-img-lightbox-viewport--dragging' : ''}${scale > MIN_SCALE ? ' lc-chat-img-lightbox-viewport--zoomed' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onDoubleClick={onDoubleClick}
        >
          <img
            src={item.url}
            alt={item.alt ?? ''}
            className="lc-task-file-lightbox-img lc-chat-img-lightbox-img"
            draggable={false}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            }}
          />
        </div>
        <div className="lc-chat-img-lightbox-zoom" role="toolbar" aria-label="Масштаб">
          <button
            type="button"
            className="lc-chat-img-lightbox-zoom-btn"
            aria-label="Уменьшить"
            disabled={!canZoomOut}
            onClick={() => applyScale(scaleRef.current - ZOOM_STEP)}
          >
            −
          </button>
          <span className="lc-chat-img-lightbox-zoom-label" aria-live="polite">
            {zoomPercent}%
          </span>
          <button
            type="button"
            className="lc-chat-img-lightbox-zoom-btn"
            aria-label="Увеличить"
            disabled={!canZoomIn}
            onClick={() => applyScale(scaleRef.current + ZOOM_STEP)}
          >
            +
          </button>
          {canZoomOut && (
            <button
              type="button"
              className="lc-chat-img-lightbox-zoom-btn lc-chat-img-lightbox-zoom-btn--reset"
              aria-label="Сбросить масштаб"
              title="Сбросить масштаб"
              onClick={resetZoom}
            >
              ↺
            </button>
          )}
        </div>
        {canNext && (
          <button
            type="button"
            className="lc-chat-img-lightbox-nav lc-chat-img-lightbox-nav--next"
            aria-label="Следующее фото"
            onClick={() => onIndexChange(index + 1)}
          >
            ›
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
