import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import path from 'node:path'

const KEEP = parseInt(process.env.BACKUP_KEEP || '30')

function dbPath() {
  const url = process.env.DATABASE_URL || ''
  const m = url.match(/^file:(.+)$/)
  if (!m) return null
  return path.isAbsolute(m[1]) ? m[1] : path.resolve(process.cwd(), m[1])
}

export async function backupOnce() {
  const src = dbPath()
  if (!src || !fs.existsSync(src)) {
    console.error('[backup] база не найдена по DATABASE_URL')
    return null
  }
  const dir = process.env.BACKUP_DIR
    || (fs.existsSync('/app/data') ? '/app/data/backups' : path.join(path.dirname(src), 'backups'))
  fs.mkdirSync(dir, { recursive: true })

  const now = new Date()
  const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const target = path.join(dir, `custom-${stamp}.db`)

  const db = new PrismaClient()
  try {
    await db.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } finally {
    await db.$disconnect()
  }

  const backups = fs.readdirSync(dir)
    .filter(f => /^custom-.*\.db$/.test(f))
    .sort()
  while (backups.length > KEEP) {
    const old = backups.shift()
    try { fs.unlinkSync(path.join(dir, old)) } catch { /* */ }
  }
  console.log(`[backup] сохранён ${target} (храним последние ${KEEP})`)
  return target
}

const isDirect = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`
if (isDirect) {
  backupOnce().catch(e => { console.error('[backup]', e?.message || e); process.exit(1) })
}
