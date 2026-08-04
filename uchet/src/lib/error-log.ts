import fs from 'fs'
import path from 'path'

const DIR = process.env.UCHET_LOG_DIR || path.join(process.cwd(), 'logs')

const fmt = (a: unknown): string =>
  a instanceof Error ? (a.stack || a.message)
    : typeof a === 'string' ? a
      : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()

function write(kind: string, args: unknown[]): void {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const now = new Date()
    const line = `[${now.toISOString()}] [${kind}] ${args.map(fmt).join(' ')}\n`
    fs.appendFile(path.join(DIR, `errors-${now.toISOString().slice(0, 10)}.log`), line, () => {})
  } catch {  }
}

const FLAG = '__uchetErrorLogInstalled'

export function installErrorFileLog(): void {
  const g = globalThis as Record<string, unknown>
  if (g[FLAG]) return
  g[FLAG] = true

  const orig = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    write('error', args)
    orig(...args)
  }
  process.on('unhandledRejection', (reason) => write('unhandledRejection', [reason]))
  process.on('uncaughtException', (e) => write('uncaughtException', [e]))
}
