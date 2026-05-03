/**
 * @fileoverview Определение типа коллаб-документа (rich text vs таблица) и допустимых файлов при импорте с диска.
 *
 * Два сценария: широкая эвристика для канбана (`inferCollabDocTypeFromFile`) и строгий набор для раздела «Документы»
 * (`inferCollabDocTypeFromDiskImportFile` — Word/Excel/изображение).
 */

/** По имени и MIME: таблица или всё остальное как rich text (канбан, общие сценарии). */
export function inferCollabDocTypeFromFile(file: File): 'richtext' | 'spreadsheet' {
  const n = file.name.toLowerCase();
  const mime = (file.type || '').toLowerCase();
  if (
    n.endsWith('.xlsx') ||
    n.endsWith('.xls') ||
    n.endsWith('.csv') ||
    mime.includes('spreadsheet') ||
    mime.includes('csv') ||
    mime.includes('excel') ||
    mime.includes('officedocument.spreadsheetml')
  )
    return 'spreadsheet';
  return 'richtext';
}

/** Изображение по MIME `image/*` или по расширению файла. */
export function isCollabDiskImageFile(file: File): boolean {
  const m = (file.type || '').toLowerCase();
  if (m.startsWith('image/')) return true;
  const n = file.name.toLowerCase();
  return /\.(jpe?g|png|gif|webp|bmp|svg|avif|tiff?)$/i.test(n);
}

/**
 * Импорт в «Документы»: только Word, Excel или картинка (картинка → rich text с вставкой фото).
 * @throws Error с пользовательским текстом, если тип не подходит
 */
export function inferCollabDocTypeFromDiskImportFile(file: File): 'richtext' | 'spreadsheet' {
  if (isCollabDiskImageFile(file)) return 'richtext';
  const n = file.name.toLowerCase();
  if (n.endsWith('.xlsx') || n.endsWith('.xls')) return 'spreadsheet';
  if (n.endsWith('.docx') || n.endsWith('.doc')) return 'richtext';
  throw new Error('Допустимы Word (.doc, .docx), Excel (.xls, .xlsx) или фото (JPEG, PNG, GIF, WebP, …)');
}

/** @deprecated Используйте `inferCollabDocTypeFromDiskImportFile`. */
export function inferCollabDocTypeFromWordExcelFile(file: File): 'richtext' | 'spreadsheet' {
  return inferCollabDocTypeFromDiskImportFile(file);
}

/** Значение `accept` у `<input type="file">` и ориентир для DnDrop в «Документы». */
export const COLLAB_DISK_FILE_ACCEPT =
  '.docx,.doc,.xlsx,.xls,.jpg,.jpeg,.png,.gif,.webp,.bmp,.svg,.avif,.tif,.tiff,image/*,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Убедиться, что файл подходит для импорта в «Документы»; иначе выбросить `Error` с сообщением для UI.
 */
export function assertCollabDiskFileSupported(file: File): void {
  inferCollabDocTypeFromDiskImportFile(file);
}
