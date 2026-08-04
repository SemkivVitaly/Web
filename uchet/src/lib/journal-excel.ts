import ExcelJS from 'exceljs'
import { db } from '@/lib/db'
import { STATUS_LABELS, statusFromExcel } from '@/lib/statuses'

export const JOURNAL_HEADERS = [
  'Дата', 'Время', 'Изделие', 'Акт', 'Кол-во', 'Акт несоот.', 'Кол-во рем.',
  'Кол-во анализ', 'Кол-во Отгружен', 'Статус', 'к Отгрузке (дата)',
  'к Отгрузке (время)', 'факт Отгр (дата)', 'факт Отгр (время)',
  'Выполнил вых кон', 'Примечание',
] as const

const plausibleYear = (d: Date | null) =>
  d && d.getFullYear() >= 2000 && d.getFullYear() <= 2100 ? d : null

function toDateOnly(v: unknown): Date | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return plausibleYear(v)

  if (typeof v === 'number' || /^\d{4,6}$/.test(String(v).trim())) {
    const serial = typeof v === 'number' ? v : parseInt(String(v).trim())

    if (serial > 20000 && serial < 60000) {
      return plausibleYear(new Date((serial - 25569) * 86400_000))
    }
    return null
  }
  const s = String(v).trim()

  const m = s.match(/^(\d{1,2})[.:/-](\d{1,2})[.:/-](\d{2,4})(?:[\sT]|$)/)
  if (m) {
    let y = parseInt(m[3])
    if (y < 100) y += 2000
    const d = new Date(y, parseInt(m[2]) - 1, parseInt(m[1]))
    return plausibleYear(isNaN(d.getTime()) ? null : d)
  }
  const d = new Date(s)
  return plausibleYear(isNaN(d.getTime()) ? null : d)
}

function toTimeParts(v: unknown): [number, number] | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return [v.getUTCHours(), v.getUTCMinutes()]
  const m = String(v).trim().match(/^(\d{1,2})[.:](\d{2})/)
  if (m) return [parseInt(m[1]) % 24, parseInt(m[2])]
  return null
}

function combine(d: unknown, t: unknown): Date | null {
  const date = toDateOnly(d)
  const time = toTimeParts(t)

  if (!date) return null
  const res = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (time) res.setHours(time[0], time[1])
  return res
}

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('ru-RU') : ''
const fmtTime = (d: Date | null) =>
  d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''

async function loadWorkbookTolerant(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer)
    return wb
  } catch {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(buffer)
    const names = Object.keys(zip.files)
    for (const n of names) {
      if (/^xl\/tables\//.test(n)) zip.remove(n)
    }
    for (const n of names.filter(x => /^xl\/worksheets\/sheet\d+\.xml$/.test(x))) {
      let xml = await zip.file(n)!.async('string')
      xml = xml.replace(/<tableParts[\s\S]*?<\/tableParts>/g, '').replace(/<tableParts[^>]*\/>/g, '')
      zip.file(n, xml)
    }
    for (const n of names.filter(x => /^xl\/worksheets\/_rels\//.test(x))) {
      let xml = await zip.file(n)!.async('string')
      xml = xml.replace(/<Relationship[^>]*\/table"[^>]*\/>/g, '')
      zip.file(n, xml)
    }
    const ctName = '[Content_Types].xml'
    if (zip.file(ctName)) {
      let ct = await zip.file(ctName)!.async('string')
      ct = ct.replace(/<Override[^>]*table\+xml[^>]*\/>/g, '')
      zip.file(ctName, ct)
    }
    const cleaned = (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
    const wb2 = new ExcelJS.Workbook()
    await wb2.xlsx.load(cleaned as unknown as ExcelJS.Buffer)
    return wb2
  }
}

export async function buildJournalWorkbook(): Promise<ExcelJS.Workbook> {
  const acts = await db.act.findMany({
    orderBy: [{ actDate: 'desc' }, { createdAt: 'desc' }],
    include: { product: { select: { name: true } } },
  })

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Журнал "Прием_отгрузка"', { views: [{ state: 'frozen', ySplit: 1 }] })

  ws.columns = [
    { width: 11 }, { width: 7 }, { width: 14 }, { width: 10 }, { width: 8 },
    { width: 11 }, { width: 10 }, { width: 11 }, { width: 12 }, { width: 18 },
    { width: 14 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 14 },
    { width: 30 },
  ]

  const header = ws.addRow([...JOURNAL_HEADERS])
  header.font = { bold: true }
  header.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  })

  const statusFills: Record<string, string> = {
    shipped: 'FFC6EFCE',
    ready_to_ship: 'FFFFEB9C',
    stopped: 'FFFFC7CE',
  }

  for (const act of acts) {
    const row = ws.addRow([
      fmtDate(act.actDate),
      act.actTime || '',
      act.product?.name || act.actType,
      act.actNumber,
      act.quantity,
      act.ncActNumber || '',
      act.repairQty || '',
      act.analysisQty || '',
      act.shippedQty || '',
      STATUS_LABELS[act.status] || act.status,
      fmtDate(act.plannedShipAt),
      fmtTime(act.plannedShipAt),
      fmtDate(act.actualShipAt),
      fmtTime(act.actualShipAt),
      act.outputControlBy || '',
      act.notes || '',
    ])
    row.eachCell((c) => {
      c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }
    })
    const fill = statusFills[act.status]
    if (fill) {
      row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
    }
  }
  ws.autoFilter = { from: 'A1', to: `P${Math.max(acts.length + 1, 2)}` }

  const sv = wb.addWorksheet('Сводка')
  sv.columns = [{ width: 24 }, { width: 10 }, { width: 12 }, { width: 13 }]
  const svh = sv.addRow(['Изделие / Акт', 'Кол-во', 'Кол-во рем.', 'Кол-во анализ'])
  svh.font = { bold: true }
  svh.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }
  })

  const byProduct = new Map<string, typeof acts>()
  for (const a of acts) {
    const key = a.product?.name || a.actType
    if (!byProduct.has(key)) byProduct.set(key, [])
    byProduct.get(key)!.push(a)
  }
  let totalQ = 0
  let totalR = 0
  let totalA = 0
  for (const [name, list] of [...byProduct.entries()].sort((x, y) => x[0].localeCompare(y[0], 'ru'))) {
    const q = list.reduce((s, a) => s + a.quantity, 0)
    const r = list.reduce((s, a) => s + a.repairQty, 0)
    const an = list.reduce((s, a) => s + a.analysisQty, 0)
    const row = sv.addRow([name, q, r || '', an || ''])
    row.font = { bold: true }
    for (const a of [...list].sort((x, y) => x.actNumber.localeCompare(y.actNumber, 'ru'))) {
      sv.addRow([`    ${a.actNumber}`, a.quantity, a.repairQty || '', a.analysisQty || ''])
    }
    totalQ += q
    totalR += r
    totalA += an
  }
  const totalRow = sv.addRow(['Общий итог', totalQ, totalR, totalA])
  totalRow.font = { bold: true }

  return wb
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
}

export async function importJournalWorkbook(buffer: ArrayBuffer | Buffer): Promise<ImportResult> {
  const wb = await loadWorkbookTolerant(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))

  let ws: ExcelJS.Worksheet | undefined
  wb.eachSheet((sheet) => {
    if (ws) return
    const first = sheet.getRow(1).values as unknown[]
    const cells = (first || []).map((v) => String(v ?? '').trim().toLowerCase())
    if (cells.some((v) => v === 'акт') && cells.some((v) => v.includes('изделие'))) ws = sheet
  })
  if (!ws) ws = wb.worksheets[0]

  const col: Record<string, number> = {}
  ws.getRow(1).eachCell((c, n) => {
    col[String(c.value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()] = n
  })
  const get = (row: ExcelJS.Row, ...names: string[]) => {
    for (const n of names) {
      if (col[n]) {
        const v = row.getCell(col[n]).value
        if (v != null && typeof v === 'object' && 'result' in (v as object)) {
          return (v as { result: unknown }).result
        }
        return v
      }
    }
    return null
  }

  const result: ImportResult = { created: 0, updated: 0, skipped: 0 }

  const productCache = new Map<string, string>()

  const occurrence = new Map<string, number>()

  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i)
    const rawAct = get(row, 'акт')
    const rawProduct = get(row, 'изделие')
    if (rawAct == null || rawProduct == null) {
      result.skipped++
      continue
    }
    const actNumber = typeof rawAct === 'number' ? String(rawAct) : String(rawAct).trim()
    const productName = String(rawProduct).trim()
    if (!actNumber || !productName) {
      result.skipped++
      continue
    }

    let productId = productCache.get(productName)
    if (!productId) {
      let product = await db.productType.findFirst({ where: { name: productName } })
      if (!product) {
        product = await db.productType.create({
          data: { code: `PROD-${productName}`, name: productName },
        })
      }
      productId = product.id
      productCache.set(productName, productId)
    }

    const ncRaw = get(row, 'акт несоот.', 'акт несоот')
    const outBy = get(row, 'выполнил вых кон')
    const noteRaw = get(row, 'примечание')

    const parsedDate =
      toDateOnly(get(row, 'дата')) ??
      combine(get(row, 'к отгрузке (дата)'), null) ??
      combine(get(row, 'факт отгр (дата)'), null)
    const data = {
      actDate: parsedDate ?? new Date(),
      actTime:
        (toTimeParts(get(row, 'время')) &&
          `${String(toTimeParts(get(row, 'время'))![0]).padStart(2, '0')}:${String(
            toTimeParts(get(row, 'время'))![1]
          ).padStart(2, '0')}`) ||
        '',
      actType: productName,
      productId,
      quantity: parseInt(String(get(row, 'кол-во') ?? 0)) || 0,
      status: statusFromExcel(get(row, 'статус')) ?? 'accepted',
      ncActNumber: ncRaw != null && ncRaw !== '' ? String(ncRaw).trim() : null,
      repairQty: parseInt(String(get(row, 'кол-во рем.', 'кол-во рем') ?? 0)) || 0,
      shippedQty: parseInt(String(get(row, 'кол-во отгружен') ?? 0)) || 0,
      analysisQty: parseInt(String(get(row, 'кол-во анализ', 'анализ') ?? 0)) || 0,
      plannedShipAt: combine(get(row, 'к отгрузке (дата)'), get(row, 'к отгрузке (время)')),
      actualShipAt: combine(get(row, 'факт отгр (дата)'), get(row, 'факт отгр (время)')),
      outputControlBy: outBy != null && outBy !== '' ? String(outBy).trim() : null,
      notes: noteRaw != null && noteRaw !== '' ? String(noteRaw).trim() : null,
    }

    const key = `${actNumber}::${productName}`
    const nth = occurrence.get(key) ?? 0
    occurrence.set(key, nth + 1)

    const matches = await db.act.findMany({
      where: { actNumber, productId },
      orderBy: { createdAt: 'asc' },
    })
    const existing = matches[nth]
    if (existing) {

      const order = ['accepted', 'input_control', 'in_progress', 'output_control', 'ready_to_ship', 'shipped']
      const merged = { ...data }
      const fileStatus = statusFromExcel(get(row, 'статус'))
      if (fileStatus === null || order.indexOf(existing.status) > order.indexOf(fileStatus)) {

        merged.status = existing.status as typeof data.status
      }
      if (!merged.plannedShipAt && existing.plannedShipAt) merged.plannedShipAt = existing.plannedShipAt
      if (!merged.actualShipAt && existing.actualShipAt) merged.actualShipAt = existing.actualShipAt
      if (!merged.outputControlBy && existing.outputControlBy) merged.outputControlBy = existing.outputControlBy
      if (!merged.ncActNumber && existing.ncActNumber) merged.ncActNumber = existing.ncActNumber
      if (!merged.notes && existing.notes) merged.notes = existing.notes

      merged.repairQty = existing.repairQty
      merged.analysisQty = existing.analysisQty
      if (!merged.shippedQty && existing.shippedQty) merged.shippedQty = existing.shippedQty

      if (!parsedDate) {
        merged.actDate = existing.actDate
        if (!merged.actTime) merged.actTime = existing.actTime
      }

      const unitCount = await db.unit.count({ where: { actId: existing.id } })
      const minQty = Math.max(
        (existing.repairQty || 0) + (existing.analysisQty || 0),
        unitCount,
        1,
      )
      if (!Number.isFinite(merged.quantity) || merged.quantity < minQty) {
        merged.quantity = Math.max(existing.quantity, minQty)
      }
      await db.act.update({ where: { id: existing.id }, data: merged })
      result.updated++
    } else {

      const cap = Math.max(0, data.quantity)
      data.analysisQty = Math.min(data.analysisQty, cap)
      data.repairQty = Math.min(data.repairQty, cap - data.analysisQty)
      await db.act.create({ data: { actNumber, ...data } })
      result.created++
    }
  }

  try {
    await db.actionLog.create({
      data: {
        actionType: 'IMPORT_JOURNAL',
        entityType: 'ACT',
        entityId: 'journal',
        description: `Импорт журнала Excel: +${result.created} новых, ~${result.updated} обновлено, ${result.skipped} пропущено`,
      },
    })
  } catch {  }

  return result
}

export async function writeJournalIntoWorkbook(buffer: Buffer): Promise<Buffer> {
  const wb = await loadWorkbookTolerant(buffer)

  let ws: ExcelJS.Worksheet | undefined
  wb.eachSheet((sheet) => {
    if (ws) return
    const first = sheet.getRow(1).values as unknown[]
    const cells = (first || []).map((v) => String(v ?? '').trim().toLowerCase())
    if (cells.some((v) => v === 'акт') && cells.some((v) => v.includes('изделие'))) ws = sheet
  })
  if (!ws) throw new Error('в файле не найден лист журнала (шапка «Акт» + «Изделие»)')

  const col: Record<string, number> = {}
  ws.getRow(1).eachCell((c, n) => {
    col[String(c.value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()] = n
  })

  const acts = await db.act.findMany({
    orderBy: [{ createdAt: 'asc' }],
    include: { product: { select: { name: true } } },
  })

  if (ws.rowCount > 1) ws.spliceRows(2, ws.rowCount - 1)

  const put = (row: ExcelJS.Row, name: string, value: unknown) => {
    const n = col[name]
    if (n) row.getCell(n).value = (value ?? '') as ExcelJS.CellValue
  }

  acts.forEach((act, i) => {
    const row = ws!.getRow(i + 2)
    put(row, 'дата', fmtDate(act.actDate))
    put(row, 'время', act.actTime || '')
    put(row, 'изделие', act.product?.name || act.actType)
    put(row, 'акт', /^\d+$/.test(act.actNumber) ? parseInt(act.actNumber) : act.actNumber)
    put(row, 'кол-во', act.quantity)
    put(row, 'акт несоот.', act.ncActNumber || '')
    put(row, 'кол-во рем.', act.repairQty || '')
    put(row, 'кол-во анализ', act.analysisQty || '')
    put(row, 'кол-во отгружен', act.shippedQty || '')
    put(row, 'статус', STATUS_LABELS[act.status] || act.status)
    put(row, 'к отгрузке (дата)', act.plannedShipAt ? new Date(act.plannedShipAt) : '')
    put(row, 'к отгрузке (время)', fmtTime(act.plannedShipAt))
    put(row, 'факт отгр (дата)', act.actualShipAt ? new Date(act.actualShipAt) : '')
    put(row, 'факт отгр (время)', fmtTime(act.actualShipAt))
    put(row, 'выполнил вых кон', act.outputControlBy || '')
    put(row, 'примечание', act.notes || '')
    row.commit()
  })

  return Buffer.from(await wb.xlsx.writeBuffer())
}
