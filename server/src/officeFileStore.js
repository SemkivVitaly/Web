/**
 * @fileoverview Файлы OnlyOffice на диске: `data/collab-office-files/{docId}.docx|xlsx`.
 * Пустые шаблоны создаются при первом открытии (`ensureOfficeDiskFile`); callback редактора и импорт перезаписывают буфер.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import { Document, Packer, Paragraph, TextRun } from 'docx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const officeDir = path.join(dataDir, 'collab-office-files');

function extForDocType(docType) {
  return docType === 'spreadsheet' ? 'xlsx' : 'docx';
}

/** Абсолютный путь к офисному файлу документа на диске сервера. */
export function officeDiskPath(docId, docType) {
  return path.join(officeDir, `${docId}.${extForDocType(docType)}`);
}

async function writeEmptyDocx(filePath) {
  const doc = new Document({
    sections: [
      {
        children: [new Paragraph({ children: [new TextRun('')] })],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buf);
}

function writeEmptyXlsx(filePath) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['']]);
  XLSX.utils.book_append_sheet(wb, ws, 'Лист1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(filePath, Buffer.from(buf));
}

/**
 * Создать каталог и при отсутствии файла записать пустой docx/xlsx (для первого открытия в OnlyOffice).
 * @returns {Promise<string>} путь к файлу
 */
export async function ensureOfficeDiskFile(docId, docType) {
  fs.mkdirSync(officeDir, { recursive: true });
  const p = officeDiskPath(docId, docType);
  if (fs.existsSync(p)) return p;
  if (docType === 'spreadsheet') writeEmptyXlsx(p);
  else await writeEmptyDocx(p);
  return p;
}

/** Прочитать файл целиком или `null`, если его нет. */
export function readOfficeFileBuffer(docId, docType) {
  const p = officeDiskPath(docId, docType);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

/** Атомарно перезаписать содержимое (создаёт каталог при необходимости). */
export function writeOfficeFileBuffer(docId, docType, buffer) {
  fs.mkdirSync(officeDir, { recursive: true });
  const p = officeDiskPath(docId, docType);
  fs.writeFileSync(p, buffer);
}
