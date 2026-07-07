/**
 * @fileoverview Рисование поверх фото: ручка, прямоугольник, маркер; экспорт в PNG.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type Tool = 'pen' | 'rect' | 'highlight';

type StrokeBase = {
  tool: Tool;
  color: string;
  width: number;
};

type PenStroke = StrokeBase & {
  tool: 'pen';
  points: { x: number; y: number }[];
};

type RectStroke = StrokeBase & {
  tool: 'rect' | 'highlight';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type Stroke = PenStroke | RectStroke;

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#ffffff', '#007aff'] as const;

type Props = {
  imageSrc: string;
  fileName?: string;
  onClose: () => void;
  onSave: (file: File) => void;
  saveLabel?: string;
};

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  if (s.tool === 'pen') {
    if (s.points.length < 2) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.stroke();
    return;
  }
  const x = Math.min(s.x1, s.x2);
  const y = Math.min(s.y1, s.y2);
  const w = Math.abs(s.x2 - s.x1);
  const h = Math.abs(s.y2 - s.y1);
  if (s.tool === 'highlight') {
    ctx.fillStyle = s.color.startsWith('rgba') ? s.color : `${s.color}59`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    return;
  }
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.strokeRect(x, y, w, h);
}

function redrawCanvas(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  strokes: Stroke[],
  draft: Stroke | null
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  for (const s of strokes) drawStroke(ctx, s);
  if (draft) drawStroke(ctx, draft);
}

function highlightColor(hex: string) {
  if (hex === '#ffffff') return 'rgba(255,255,255,0.45)';
  if (hex === '#ffcc00') return 'rgba(255,204,0,0.45)';
  if (hex === '#34c759') return 'rgba(52,199,89,0.4)';
  if (hex === '#007aff') return 'rgba(0,122,255,0.4)';
  return 'rgba(255,59,48,0.4)';
}

export function PhotoAnnotator({
  imageSrc,
  fileName = 'photo.png',
  onClose,
  onSave,
  saveLabel = 'Готово',
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const drawingRef = useRef(false);
  const strokesRef = useRef<Stroke[]>([]);
  strokesRef.current = strokes;

  const brushWidth = tool === 'pen' ? 4 : 3;

  const paint = useCallback(
    (nextStrokes: Stroke[], nextDraft: Stroke | null) => {
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (!canvas || !img) return;
      redrawCanvas(canvas, img, nextStrokes, nextDraft);
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const maxW = Math.min(window.innerWidth - 48, 960);
      const maxH = Math.min(window.innerHeight - 160, 720);
      const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      setStrokes([]);
      setDraft(null);
      redrawCanvas(canvas, img, [], null);
      setLoading(false);
    };
    img.onerror = () => {
      if (!cancelled) {
        setLoadError('Не удалось загрузить фото');
        setLoading(false);
      }
    };
    img.src = imageSrc;
    return () => {
      cancelled = true;
    };
  }, [imageSrc]);

  useEffect(() => {
    paint(strokes, draft);
  }, [strokes, draft, paint]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (loading || loadError) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const p = canvasPoint(e);
    if (tool === 'pen') {
      setDraft({ tool: 'pen', color, width: brushWidth, points: [p] });
    } else {
      const strokeColor = tool === 'highlight' ? highlightColor(color) : color;
      setDraft({
        tool,
        color: strokeColor,
        width: brushWidth,
        x1: p.x,
        y1: p.y,
        x2: p.x,
        y2: p.y,
      });
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !draft) return;
    const p = canvasPoint(e);
    if (draft.tool === 'pen') {
      setDraft({ ...draft, points: [...draft.points, p] });
    } else {
      setDraft({ ...draft, x2: p.x, y2: p.y });
    }
  };

  const finishStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (!draft) return;
    if (draft.tool === 'pen' && draft.points.length < 2) {
      setDraft(null);
      return;
    }
    if (draft.tool !== 'pen') {
      const w = Math.abs(draft.x2 - draft.x1);
      const h = Math.abs(draft.y2 - draft.y1);
      if (w < 4 && h < 4) {
        setDraft(null);
        return;
      }
    }
    setStrokes((prev) => [...prev, draft]);
    setDraft(null);
  };

  const undo = () => setStrokes((prev) => prev.slice(0, -1));

  const clearAll = () => {
    setStrokes([]);
    setDraft(null);
  };

  const handleSave = () => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const scaleX = img.naturalWidth / canvas.width;
    const scaleY = img.naturalHeight / canvas.height;
    const out = document.createElement('canvas');
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    for (const s of strokesRef.current) {
      const scaled: Stroke =
        s.tool === 'pen'
          ? {
              ...s,
              points: s.points.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })),
              width: s.width * Math.max(scaleX, scaleY),
            }
          : {
              ...s,
              x1: s.x1 * scaleX,
              y1: s.y1 * scaleY,
              x2: s.x2 * scaleX,
              y2: s.y2 * scaleY,
              width: s.width * Math.max(scaleX, scaleY),
            };
      drawStroke(ctx, scaled);
    }
    out.toBlob(
      (blob) => {
        if (!blob) return;
        const base = fileName.replace(/\.[^.]+$/, '') || 'photo';
        const useJpeg = !strokes.some((s) => s.tool === 'highlight');
        if (useJpeg) {
          onSave(new File([blob], `${base}-edited.jpg`, { type: 'image/jpeg' }));
        } else {
          onSave(new File([blob], `${base}-edited.png`, { type: 'image/png' }));
        }
      },
      strokes.some((s) => s.tool === 'highlight') ? 'image/png' : 'image/jpeg',
      strokes.some((s) => s.tool === 'highlight') ? 0.92 : 0.85
    );
  };

  return (
    <div className="modal-backdrop lc-photo-annotator" role="presentation" onClick={onClose}>
      <div
        className="lc-photo-annotator-inner"
        role="dialog"
        aria-modal="true"
        aria-label="Рисование на фото"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lc-photo-annotator-toolbar">
          <div className="lc-photo-annotator-tools" role="toolbar" aria-label="Инструменты">
            <button
              type="button"
              className={tool === 'pen' ? 'lc-photo-annotator-tool lc-photo-annotator-tool--active' : 'lc-photo-annotator-tool'}
              aria-pressed={tool === 'pen'}
              title="Кисть"
              onClick={() => setTool('pen')}
            >
              ✏️
            </button>
            <button
              type="button"
              className={tool === 'rect' ? 'lc-photo-annotator-tool lc-photo-annotator-tool--active' : 'lc-photo-annotator-tool'}
              aria-pressed={tool === 'rect'}
              title="Рамка"
              onClick={() => setTool('rect')}
            >
              ▭
            </button>
            <button
              type="button"
              className={
                tool === 'highlight'
                  ? 'lc-photo-annotator-tool lc-photo-annotator-tool--active'
                  : 'lc-photo-annotator-tool'
              }
              aria-pressed={tool === 'highlight'}
              title="Выделить область"
              onClick={() => setTool('highlight')}
            >
              🖍
            </button>
          </div>
          <div className="lc-photo-annotator-colors" role="group" aria-label="Цвет">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={
                  color === c
                    ? 'lc-photo-annotator-color lc-photo-annotator-color--active'
                    : 'lc-photo-annotator-color'
                }
                style={{ background: c }}
                aria-label={`Цвет ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <div className="lc-photo-annotator-actions">
            <button type="button" className="lc-text-btn" onClick={undo} disabled={strokes.length === 0}>
              Отменить
            </button>
            <button type="button" className="lc-text-btn" onClick={clearAll} disabled={strokes.length === 0}>
              Очистить
            </button>
          </div>
        </div>
        <div className="lc-photo-annotator-canvas-wrap">
          {loading && <p className="meta">Загрузка…</p>}
          {loadError && <p className="meta">{loadError}</p>}
          <canvas
            ref={canvasRef}
            className="lc-photo-annotator-canvas"
            hidden={loading || !!loadError}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
          />
        </div>
        <div className="lc-photo-annotator-footer">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
          <button type="button" className="primary" onClick={handleSave} disabled={loading || !!loadError}>
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
