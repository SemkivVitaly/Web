/**
 * Проверка «открыть в OnlyOffice» для вложения чата — держим в соответствии с
 * `ooAttachmentViewerTypes` в `server/src/onlyOfficeRoutes.js`.
 */
export function chatAttachmentSupportsOnlyOffice(fileName: string, mimeType: string): boolean {
  const lower = String(fileName || '');
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1).toLowerCase() : '';
  const mime = String(mimeType || '').toLowerCase();
  if (['xlsx', 'xls', 'ods', 'csv', 'fods'].includes(ext)) return true;
  const wordExts = ['docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'htm', 'pdf', 'epub', 'docm', 'dotx'];
  if (wordExts.includes(ext)) return true;
  if (mime.includes('pdf')) return true;
  if (mime.includes('spreadsheet') || mime.includes('excel')) return true;
  if (mime.includes('word') || mime.includes('officedocument.wordprocessingml')) return true;
  if (mime.includes('text/plain')) return true;
  if (mime.includes('html')) return true;
  return false;
}
