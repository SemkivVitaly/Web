import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const PRODUCTS = [
  { code: 'DEMO-A1', name: 'Плата управления А1' },
  { code: 'DEMO-B2', name: 'Модуль питания Б2' },
  { code: 'DEMO-C3', name: 'Контроллер В3' },
  { code: 'DEMO-D4', name: 'Датчик Г4' },
]

const EMPLOYEES = [
  { code: 'ДЕМО-Н', name: 'Демо Начальник', role: 'boss', pin: '1234' },
  { code: 'ДЕМО-С', name: 'Демо Старший', role: 'senior', pin: '2222' },
  { code: 'Т-01', name: 'Демо Тестировщик 1', role: 'tester', pin: '1111' },
  { code: 'Т-02', name: 'Демо Тестировщик 2', role: 'tester', pin: '3333' },
]

const CATALOG = [
  'Не проходит функциональный тест',
  'Нет связи по интерфейсу',
  'Повышенный ток потребления',
  'Непропай вывода',
  'Механическое повреждение корпуса',
  'Не распознаётся QR-код',
]

const SOURCES = ['Склад', 'Инспекция', 'Печь', 'Лакировка']
const FLOW = ['accepted', 'input_control', 'in_progress', 'output_control', 'ready_to_ship', 'shipped']

const hashPin = async (pin) => {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(`uchet:${pin}`).digest('hex')
}
const daysAgo = (n) => new Date(Date.now() - n * 86400_000)
const pad = (n, w = 4) => String(n).padStart(w, '0')

async function guard() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_RESET !== '1') {
    console.error('[demo] ОТКАЗ: NODE_ENV=production.')
    console.error('[demo] — задайте ALLOW_DEMO_RESET=1.')
    process.exit(1)
  }
  const acts = await db.act.count()
  const force = process.argv.includes('--yes') || process.env.ALLOW_DEMO_RESET === '1'
  if (acts > 0 && !force) {
    console.error(`[demo] ОТКАЗ: в базе ${acts} актов. Демо-сброс СОТРЁТ ВСЕ ДАННЫЕ.`)
    console.error('[demo] Если данные точно не нужны — запустите с флагом --yes.')
    process.exit(1)
  }
}

async function reset() {
  await db.actionLog.deleteMany({})
  await db.unit.deleteMany({})
  await db.defect.deleteMany({})
  await db.shipment.deleteMany({})
  await db.act.deleteMany({})
  await db.defectCatalog.deleteMany({})
  await db.productType.deleteMany({})
  await db.employee.deleteMany({})
}

async function main() {
  await guard()
  await reset()

  const products = []
  for (const p of PRODUCTS) products.push(await db.productType.create({ data: p }))

  for (const e of EMPLOYEES) {
    await db.employee.create({ data: { ...e, pin: await hashPin(e.pin) } })
  }

  for (const [i, text] of CATALOG.entries()) {
    await db.defectCatalog.create({ data: { text, sortOrder: i } })
  }

  let actNo = 1000
  let created = 0
  for (let i = 0; i < 24; i++) {
    const product = products[i % products.length]
    const qty = [5, 10, 15, 20, 30][i % 5]
    const stageIdx = Math.min(FLOW.length - 1, Math.floor((i % 12) / 2))
    const status = FLOW[stageIdx]
    const accepted = daysAgo(28 - i)
    actNo++

    const serials = Array.from({ length: qty }, (_, k) => `SN-${pad(actNo)}-${pad(k + 1, 3)}`)
    const shipped = status === 'shipped'
    const inRepair = i % 4 === 0 ? 2 : 0
    const onAnalysis = i % 7 === 0 ? 1 : 0

    const act = await db.act.create({
      data: {
        actNumber: String(actNo),
        actDate: accepted,
        actTime: `${8 + (i % 8)}:${pad((i * 7) % 60, 2)}`,
        actType: product.name,
        productId: product.id,
        quantity: qty,
        source: SOURCES[i % SOURCES.length],
        purpose: i % 5 === 0 ? 'Инспекция' : 'Тестирование',
        status,
        takenBy: i % 2 === 0 ? 'Т-01' : 'Т-02',
        employeeName: i % 2 === 0 ? 'Демо Тестировщик 1' : 'Демо Тестировщик 2',
        outputControlBy: stageIdx >= 3 ? 'ДЕМО-С' : null,
        plannedShipAt: stageIdx >= 4 ? daysAgo(28 - i - 2) : null,
        actualShipAt: shipped ? daysAgo(28 - i - 3) : null,
        shippedQty: shipped ? qty : 0,
        repairQty: inRepair,
        analysisQty: onAnalysis,
        units: { create: serials.map((serial) => ({ serial })) },
      },
    })

    if (inRepair > 0) {
      await db.defect.create({
        data: {
          actId: act.id, kind: 'repeated', state: 'in_repair', quantity: inRepair,
          serial: serials[0], labelNumber: `Я-${pad(actNo)}`,
          description: CATALOG[i % CATALOG.length], reportedBy: 'Т-01',
        },
      })
    }
    if (onAnalysis > 0) {
      await db.defect.create({
        data: {
          actId: act.id, kind: 'analysis', state: 'on_analysis', quantity: onAnalysis,
          serial: serials[1] || serials[0], labelNumber: `Я-${pad(actNo)}-А`,
          description: 'На анализ ', reportedBy: 'Т-02',
        },
      })
    }

    await db.actionLog.create({
      data: {
        actionType: 'CREATE_ACT', entityType: 'ACT', entityId: act.id,
        entityNumber: act.actNumber, actId: act.id,
        description: `Приём продукции: акт ${act.actNumber}, ${qty} шт.`,
        userId: act.takenBy, createdAt: accepted,
      },
    })
    if (shipped) {
      await db.actionLog.create({
        data: {
          actionType: 'CHANGE_STATUS', entityType: 'ACT', entityId: act.id,
          entityNumber: act.actNumber, actId: act.id,
          description: `Акт ${act.actNumber}: К отгрузке → Отгружен`,
          changes: JSON.stringify({ from: 'ready_to_ship', to: 'shipped' }),
          userId: 'ДЕМО-С', createdAt: act.actualShipAt,
        },
      })
    }
    created++
  }

  console.log(`[demo] загружено: ${products.length} изделий, ${EMPLOYEES.length} сотрудников, ${created} актов (демо-данные, вымышленные)`)
  console.log('[demo] вход: ДЕМО-Н / 1234 (начальник), ДЕМО-С / 2222 (старший), Т-01 / 1111 (тестировщик)')
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
