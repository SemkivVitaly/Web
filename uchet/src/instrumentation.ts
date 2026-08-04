export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installErrorFileLog } = await import('@/lib/error-log')
    installErrorFileLog()
    const { db } = await import('@/lib/db')
    try {
      await db.$queryRawUnsafe('PRAGMA journal_mode=WAL')
      await db.$queryRawUnsafe('PRAGMA busy_timeout=8000')
      await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL')
    } catch { /* */ }
    const { startFolderSync } = await import('@/lib/folder-sync')
    startFolderSync()
    const { startAutoBackup } = await import('@/lib/backup')
    startAutoBackup()
  }
}
