import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const run = async (sql, ignoreDup = false) => {
  try {
    await db.$executeRawUnsafe(sql)
  } catch (e) {
    const msg = String(e?.message || e)
    if (ignoreDup && /duplicate column|already exists/i.test(msg)) return
    if (/already exists/i.test(msg)) return
    throw e
  }
}

try {
  await run(`CREATE TABLE IF NOT EXISTS "units" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "units_actId_fkey" FOREIGN KEY ("actId") REFERENCES "acts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "units_serial_idx" ON "units"("serial")`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "units_actId_serial_key" ON "units"("actId", "serial")`)
  await run(`ALTER TABLE "acts" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'Тестирование'`, true)
  await run(`ALTER TABLE "defects" ADD COLUMN "serial" TEXT`, true)
  await run(`ALTER TABLE "defects" ADD COLUMN "designator" TEXT`, true)
  await run(`ALTER TABLE "defects" ADD COLUMN "checkedBy" TEXT`, true)
  await run(`CREATE TABLE IF NOT EXISTS "defect_catalog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "defect_catalog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product_types" ("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`)
  await run(`CREATE INDEX IF NOT EXISTS "defect_catalog_productId_idx" ON "defect_catalog"("productId")`)
  await run(`ALTER TABLE "acts" ADD COLUMN "clientKey" TEXT`, true)
  await run(`ALTER TABLE "defects" ADD COLUMN "clientKey" TEXT`, true)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "acts_clientKey_key" ON "acts"("clientKey")`)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "defects_clientKey_key" ON "defects"("clientKey")`)
  await run(`CREATE INDEX IF NOT EXISTS "action_logs_actId_actionType_idx" ON "action_logs"("actId","actionType")`)
  await run(`CREATE INDEX IF NOT EXISTS "action_logs_createdAt_idx" ON "action_logs"("createdAt")`)
  await run(`ALTER TABLE "employees" ADD COLUMN "chatTag" TEXT`, true)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS "employees_chatTag_key" ON "employees"("chatTag")`)
  for (const col of [
    `"acceptedBy" TEXT`, `"acceptedAt" DATETIME`,
    `"inputControlBy" TEXT`, `"inputControlAt" DATETIME`,
    `"testedBy" TEXT`, `"testedAt" DATETIME`,
    `"outputControlBy" TEXT`, `"outputControlAt" DATETIME`,
    `"unitState" TEXT NOT NULL DEFAULT 'accepted'`,
  ]) {
    await run(`ALTER TABLE "units" ADD COLUMN ${col}`, true)
  }
  console.log('[migrate] схема БД актуальна')
} catch (e) {
  console.error('[migrate] ошибка догонки схемы:', e?.message || e)
  process.exitCode = 1
} finally {
  await db.$disconnect()
}
