/**
 * @fileoverview Решение «показывать ли вложение как текст» и безопасная подгрузка UTF-8 с лимитом байт.
 *
 * Используется в задачах (модальное превью, ховер на канбане) и родственных UI.
 */

/** Максимум байт тела для модального текстового превью вложений задач. */
export const TASK_TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

/** Лимит байт при fetch для всплывающей подсказки на доске (меньше, чем модалка). */
export const HOVER_TEXT_FETCH_MAX_BYTES = 36 * 1024;
/** Максимум символов отображения в ховере (обрезка на клиенте после fetch). */
export const HOVER_TEXT_DISPLAY_MAX_CHARS = 3600;

const TEXT_LIKE_EXT = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'tsv',
  'log',
  'xml',
  'yml',
  'yaml',
  'css',
  'scss',
  'sass',
  'less',
  'styl',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'tsx',
  'ts',
  'vue',
  'svelte',
  'java',
  'kt',
  'kts',
  'py',
  'rb',
  'go',
  'rs',
  'php',
  'sql',
  'html',
  'htm',
  'xhtml',
  'svg',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'psm1',
  'cs',
  'fs',
  'fsx',
  'cpp',
  'cc',
  'cxx',
  'c',
  'h',
  'hpp',
  'hh',
  'ino',
  'swift',
  'r',
  'lua',
  'pl',
  'pm',
  'dockerfile',
  'gitignore',
  'env',
  'toml',
  'ini',
  'cfg',
  'conf',
  'config',
  'properties',
  'editorconfig',
  'npmrc',
  'lock',
  'gradle',
  'cmake',
  'makefile',
  'mk',
  'dart',
  'ex',
  'exs',
  'clj',
  'cljs',
  'edn',
  'graphql',
  'gql',
  'http',
  'rest',
]);

function extFromName(fileName: string): string {
  const n = fileName.trim().toLowerCase();
  const i = n.lastIndexOf('.');
  if (i <= 0 || i === n.length - 1) return '';
  return n.slice(i + 1);
}

/** Текстовый предпросмотр (UTF-8), не изображение/видео/аудио/PDF */
export function isTextPreviewableFile(
  mime: string | null | undefined,
  fileName: string | null | undefined
): boolean {
  const m = (mime || '').toLowerCase().trim();
  const name = (fileName || '').toLowerCase();

  if (m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/')) return false;
  if (m === 'application/pdf' || m.includes('pdf')) return false;
  if (m.startsWith('font/')) return false;
  if (
    m.startsWith('application/zip') ||
    m.includes('zip') ||
    m.includes('tar') ||
    m.includes('rar') ||
    m.includes('7z')
  )
    return false;
  if (m.includes('word') || m.includes('excel') || m.includes('spreadsheetml') || m.includes('officedocument'))
    return false;
  if (m === 'application/octet-stream') {
    const e = extFromName(name);
    return TEXT_LIKE_EXT.has(e);
  }

  if (m.startsWith('text/')) return true;
  if (m === 'application/json' || m.endsWith('+json')) return true;
  if (m === 'application/xml' || m === 'text/xml' || m.endsWith('+xml')) return true;
  if (m === 'application/javascript' || m === 'text/javascript' || m === 'application/x-javascript') return true;
  if (m === 'application/sql') return true;
  if (m === 'application/x-sh' || m === 'application/x-csh') return true;

  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return true;
  if (name === 'makefile' || name === 'gnumakefile') return true;
  if (name === 'jenkinsfile' || name.endsWith('.jenkinsfile')) return true;

  const e = extFromName(name);
  return TEXT_LIKE_EXT.has(e);
}

/**
 * GET по `url` с cookie, декод UTF-8; при превышении `maxBytes` обрезает и помечает в тексте.
 */
export async function fetchUtf8TextLimited(
  url: string,
  maxBytes: number
): Promise<{ text: string; truncated: boolean; ok: true } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const buf = await r.arrayBuffer();
    const truncated = buf.byteLength > maxBytes;
    const slice = truncated ? buf.slice(0, maxBytes) : buf;
    const dec = new TextDecoder('utf-8', { fatal: false });
    let text = dec.decode(slice);
    if (truncated) {
      text += `\n\n… (${Math.round(maxBytes / 1024)} КБ — показано начало файла)`;
    }
    return { text, truncated, ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Ошибка загрузки' };
  }
}

/** Попытка красиво отформатировать JSON */
export function formatTextIfJson(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return raw;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return raw;
  }
}
