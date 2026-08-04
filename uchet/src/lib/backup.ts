import { db } from '@/lib/db'
import fs from 'fs'
import path from 'path'

const KEEP = parseInt(process.env.BACKUP_KEEP || '30')
const INTERVAL_HOURS = Math.max(1, parseInt(process.env.BACKUP_INTERVAL_HOURS || '6'))

function dbPath(): string | null {
  const url = process.env.DATABASE_URL || ''
  const m = url.match(/^file:(.+)$/)
  if (!m) return null
  return path.isAbsolute(m[1]) ? m[1] : path.resolve(process.cwd(), m[1])
}

export async function backupNow(): Promise<string | null> {
  const src = dbPath()
  if (!src || !fs.existsSync(src)) return null
  const dir = process.env.BACKUP_DIR
    || (fs.existsSync('/app/data') ? '/app/data/backups' : path.join(path.dirname(src), 'backups'))
  fs.mkdirSync(dir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const target = path.join(dir, `custom-${stamp}.db`)
  await db.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`)

  const files = fs.readdirSync(dir).filter(f => /^custom-.*\.db$/.test(f)).sort()
  while (files.length > KEEP) {
    const old = files.shift()!
    try { fs.unlinkSync(path.join(dir, old)) } catch { /* */ }
  }
  return target
}

let started = false
export function startAutoBackup(): void {
  if (started || process.env.BACKUP_DISABLED === '1') return
  started = true
  const run = () => backupNow()
    .then(t => t && console.log(`[backup] ${t}`))
    .catch(e => console.error('[backup]', e?.message || e))
  setTimeout(run, 60_000)
  setInterval(run, INTERVAL_HOURS * 3600_000)
}
