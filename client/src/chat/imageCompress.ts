/**
 * Сжатие фото перед отправкой: max dimension ~2048, JPEG quality ~0.85.
 */

const MAX_DIM = 2048;
const JPEG_QUALITY = 0.85;

export async function compressImageFileForUpload(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') {
    return file;
  }
  if (typeof createImageBitmap === 'undefined') return file;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const w = bitmap.width;
    const h = bitmap.height;
    if (w <= MAX_DIM && h <= MAX_DIM && file.size < 1_500_000) {
      return file;
    }
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, tw, th);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
    );
    if (!blob) return file;
    const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    bitmap?.close?.();
  }
}

export async function compressImageFilesForUpload(files: File[]): Promise<File[]> {
  return Promise.all(files.map((f) => compressImageFileForUpload(f)));
}
