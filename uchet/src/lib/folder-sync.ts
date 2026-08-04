import fs from 'fs'

interface SyncState {
  enabled: boolean
  file: string
  intervalSeconds: number
  lastImportAt: string | null
  lastImportResult: string | null
  lastWriteAt: string | null
  lastError: string | null
}

const g = globalThis as unknown as {
  __sync2Started?: boolean
  __sync2State?: SyncState
  __sync2OurMtime?: number
  __sync2DbStamp?: number
  __sync2Busy?: boolean
}

export function getSyncState(): SyncState {
  return (
    g.__sync2State ?? {
      enabled: false, file: '', intervalSeconds: 60,
      lastImportAt: null, lastImportResult: null, lastWriteAt: null, lastError: null,
    }
  )
}

export function startFolderSync(): void {
  if (g.__sync2Started) return
  g.__sync2Started = true

  const file = process.env.SYNC_FILE || ''
  const intervalSeconds = Math.max(15, parseInt(process.env.SYNC_INTERVAL_SECONDS || '60') || 60)

  const state: SyncState = {
    enabled: Boolean(file), file, intervalSeconds,
    lastImportAt: null, lastImportResult: null, lastWriteAt: null, lastError: null,
  }
  g.__sync2State = state

  if (!file) {
    console.log('[sync] выключена: SYNC_FILE не задан')
    return
  }
  console.log(`[sync] общий файл: ${file}, каждые ${intervalSeconds}с`)

  const tick = async () => {
    if (g.__sync2Busy) return
    g.__sync2Busy = true
    try {
      if (!fs.existsSync(file)) {
        state.lastError = 'файл не найден: ' + file
        return
      }

      let mtime = fs.statSync(file).mtimeMs
      if (mtime !== (g.__sync2OurMtime ?? 0)) {
        try {
          const { importJournalWorkbook } = await import('@/lib/journal-excel')
          const buffer = fs.readFileSync(file)
          const result = await importJournalWorkbook(buffer)
          state.lastImportAt = new Date().toISOString()
          state.lastImportResult = `+${result.created} новых, ~${result.updated} обновлено`
          state.lastError = null
          g.__sync2OurMtime = mtime
        } catch (e) {

          state.lastError = `чтение: ${e instanceof Error ? e.message : String(e)}`
          return
        }
      }

      const { db } = await import('@/lib/db')
      const agg = await db.act.aggregate({ _max: { updatedAt: true }, _count: true })
      const dbStamp = (agg._max.updatedAt?.getTime() ?? 0) + agg._count * 0.001
      if (dbStamp === (g.__sync2DbStamp ?? -1)) return

      const { writeJournalIntoWorkbook } = await import('@/lib/journal-excel')
      const before = fs.readFileSync(file)
      const updated = await writeJournalIntoWorkbook(before)

      mtime = fs.statSync(file).mtimeMs
      if (mtime !== g.__sync2OurMtime) return

      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, updated)
      try {
        fs.renameSync(tmp, file)
      } catch (e) {

        try { fs.unlinkSync(tmp) } catch {  }
        state.lastError = 'файл открыт в Excel — записываю при следующей проверке'
        return
      }
      g.__sync2OurMtime = fs.statSync(file).mtimeMs
      g.__sync2DbStamp = dbStamp
      state.lastWriteAt = new Date().toISOString()
      state.lastError = null
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e)
    } finally {
      g.__sync2Busy = false
    }
  }

  tick().catch(() => {})
  setInterval(() => { tick().catch(() => {}) }, intervalSeconds * 1000)
}
