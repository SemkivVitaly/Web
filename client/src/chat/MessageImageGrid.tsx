import type { Attachment } from '../types';

export const MAX_MESSAGE_PHOTOS = 10;

type GridPlacement = {
  columns: number;
  rows: string;
  spans: { col: [number, number]; row: [number, number] }[];
};

/** Раскладка альбома (как в Telegram): компактная сетка для 2–10 фото. */
function gridLayout(count: number): GridPlacement | null {
  switch (count) {
    case 2:
      return {
        columns: 2,
        rows: 'minmax(120px, 200px)',
        spans: [
          { col: [1, 2], row: [1, 2] },
          { col: [2, 3], row: [1, 2] },
        ],
      };
    case 3:
      return {
        columns: 2,
        rows: 'repeat(2, minmax(90px, 140px))',
        spans: [
          { col: [1, 2], row: [1, 3] },
          { col: [2, 3], row: [1, 2] },
          { col: [2, 3], row: [2, 3] },
        ],
      };
    case 4:
      return {
        columns: 2,
        rows: 'repeat(2, minmax(90px, 140px))',
        spans: [
          { col: [1, 2], row: [1, 2] },
          { col: [2, 3], row: [1, 2] },
          { col: [1, 2], row: [2, 3] },
          { col: [2, 3], row: [2, 3] },
        ],
      };
    case 5:
      return {
        columns: 6,
        rows: 'minmax(100px, 150px) minmax(90px, 130px)',
        spans: [
          { col: [1, 4], row: [1, 2] },
          { col: [4, 7], row: [1, 2] },
          { col: [1, 3], row: [2, 3] },
          { col: [3, 5], row: [2, 3] },
          { col: [5, 7], row: [2, 3] },
        ],
      };
    case 6:
      return {
        columns: 3,
        rows: 'repeat(2, minmax(90px, 130px))',
        spans: [
          { col: [1, 2], row: [1, 2] },
          { col: [2, 3], row: [1, 2] },
          { col: [3, 4], row: [1, 2] },
          { col: [1, 2], row: [2, 3] },
          { col: [2, 3], row: [2, 3] },
          { col: [3, 4], row: [2, 3] },
        ],
      };
    case 7:
      return {
        columns: 6,
        rows: 'minmax(90px, 130px) minmax(80px, 110px) minmax(80px, 110px)',
        spans: [
          { col: [1, 3], row: [1, 2] },
          { col: [3, 5], row: [1, 2] },
          { col: [5, 7], row: [1, 2] },
          { col: [1, 4], row: [2, 3] },
          { col: [4, 7], row: [2, 3] },
          { col: [1, 4], row: [3, 4] },
          { col: [4, 7], row: [3, 4] },
        ],
      };
    case 8:
      return {
        columns: 4,
        rows: 'repeat(2, minmax(80px, 120px))',
        spans: [
          { col: [1, 2], row: [1, 2] },
          { col: [2, 3], row: [1, 2] },
          { col: [3, 4], row: [1, 2] },
          { col: [4, 5], row: [1, 2] },
          { col: [1, 2], row: [2, 3] },
          { col: [2, 3], row: [2, 3] },
          { col: [3, 4], row: [2, 3] },
          { col: [4, 5], row: [2, 3] },
        ],
      };
    case 9:
      return {
        columns: 3,
        rows: 'repeat(3, minmax(70px, 110px))',
        spans: [
          { col: [1, 2], row: [1, 2] },
          { col: [2, 3], row: [1, 2] },
          { col: [3, 4], row: [1, 2] },
          { col: [1, 2], row: [2, 3] },
          { col: [2, 3], row: [2, 3] },
          { col: [3, 4], row: [2, 3] },
          { col: [1, 2], row: [3, 4] },
          { col: [2, 3], row: [3, 4] },
          { col: [3, 4], row: [3, 4] },
        ],
      };
    case 10:
      return {
        columns: 6,
        rows:
          'minmax(100px, 140px) minmax(100px, 140px) minmax(70px, 100px) minmax(70px, 100px)',
        spans: [
          { col: [1, 4], row: [1, 2] },
          { col: [4, 7], row: [1, 2] },
          { col: [1, 4], row: [2, 3] },
          { col: [4, 7], row: [2, 3] },
          { col: [1, 3], row: [3, 4] },
          { col: [3, 5], row: [3, 4] },
          { col: [5, 7], row: [3, 4] },
          { col: [1, 3], row: [4, 5] },
          { col: [3, 5], row: [4, 5] },
          { col: [5, 7], row: [4, 5] },
        ],
      };
    default:
      return null;
  }
}

type Props = {
  images: Attachment[];
  allAttachments: Attachment[];
  resolveUrl: (url: string) => string;
  /** URL для превью в ленте (миниатюра, если есть). */
  resolveImageUrl?: (a: Attachment) => string;
  onOpenImage: (allAttachments: Attachment[], attachmentId: number) => void;
};

export function MessageImageGrid({
  images,
  allAttachments,
  resolveUrl,
  resolveImageUrl,
  onOpenImage,
}: Props) {
  const imgSrc = (a: Attachment) => (resolveImageUrl ? resolveImageUrl(a) : resolveUrl(a.url));
  if (images.length === 0) return null;

  if (images.length === 1) {
    const a = images[0];
    return (
      <img
        className="attach lc-chat-attach-img--clickable lc-msg-img-single"
        src={imgSrc(a)}
        alt={a.fileName}
        role="button"
        tabIndex={0}
        onClick={() => onOpenImage(allAttachments, a.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenImage(allAttachments, a.id);
          }
        }}
      />
    );
  }

  const layout = gridLayout(Math.min(images.length, MAX_MESSAGE_PHOTOS));
  const shown = images.slice(0, MAX_MESSAGE_PHOTOS);

  if (!layout) {
    return (
      <div className="lc-msg-img-grid lc-msg-img-grid--fallback">
        {shown.map((a) => (
          <img
            key={a.id}
            className="attach lc-chat-attach-img--clickable"
            src={imgSrc(a)}
            alt={a.fileName}
            role="button"
            tabIndex={0}
            onClick={() => onOpenImage(allAttachments, a.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenImage(allAttachments, a.id);
              }
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`lc-msg-img-grid lc-msg-img-grid--n${shown.length}`}
      style={{
        gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
        gridTemplateRows: layout.rows,
      }}
    >
      {shown.map((a, i) => {
        const span = layout.spans[i];
        if (!span) return null;
        return (
          <button
            key={a.id}
            type="button"
            className="lc-msg-img-grid-cell lc-chat-attach-img--clickable"
            style={{
              gridColumn: `${span.col[0]} / ${span.col[1]}`,
              gridRow: `${span.row[0]} / ${span.row[1]}`,
            }}
            aria-label={a.fileName}
            onClick={() => onOpenImage(allAttachments, a.id)}
          >
            <img src={imgSrc(a)} alt="" draggable={false} />
          </button>
        );
      })}
    </div>
  );
}

/** Ограничить число фотографий в очереди композера. */
export function capComposerPhotoFiles(
  prev: File[],
  incoming: File[],
  onLimit: () => void
): File[] {
  if (!incoming.length) return prev;
  const merged = [...prev, ...incoming];
  const images = merged.filter((f) => f.type.startsWith('image/'));
  const rest = merged.filter((f) => !f.type.startsWith('image/'));
  if (images.length <= MAX_MESSAGE_PHOTOS) return merged;
  onLimit();
  return [...rest, ...images.slice(0, MAX_MESSAGE_PHOTOS)];
}
