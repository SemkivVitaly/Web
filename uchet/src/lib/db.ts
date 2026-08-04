import { AsyncLocalStorage } from 'async_hooks'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { PrismaClient } from '@prisma/client'

const groupAls = new AsyncLocalStorage<PrismaClient>()

const globalForPrisma = globalThis as unknown as {
  prismaDefault?: PrismaClient
  prismaByGroup?: Map<string, PrismaClient>
  prismaReady?: Set<string>
}

function fileUrlFor(dbPath: string): string {
  const normalized = dbPath.replace(/\\/g, '/')
  const url = `file:${normalized}`
  return url.includes('?') ? `${url}&connection_limit=1` : `${url}?connection_limit=1`
}

function dataRoot(): string {
  if (process.env.UCHET_DATA_DIR) return process.env.UCHET_DATA_DIR
  return path.join(process.cwd(), 'db')
}

function templateDbPath(): string {
  if (process.env.UCHET_DB_TEMPLATE) return process.env.UCHET_DB_TEMPLATE
  const candidates = [
    path.join(process.cwd(), 'db-template', 'custom.db'),
    '/app/db-template/custom.db',
    path.join(process.cwd(), 'db', 'custom.db'),
  ]
  return candidates.find((p) => fs.existsSync(p)) || candidates[0]
}

function defaultDbPath(): string {
  const fromEnv = process.env.DATABASE_URL
  if (fromEnv?.startsWith('file:')) {
    const raw = fromEnv.replace(/^file:/, '').split('?')[0]
    if (path.isAbsolute(raw)) return raw
    return path.resolve(process.cwd(), raw)
  }
  return path.join(dataRoot(), 'custom.db')
}

function groupDbPath(groupId: string): string {
  const safe = String(groupId).replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(dataRoot(), 'groups', `group-${safe}.db`)
}

function ensureSchema(dbFile: string) {
  const ready = globalForPrisma.prismaReady ?? new Set<string>()
  globalForPrisma.prismaReady = ready
  if (ready.has(dbFile)) return

  fs.mkdirSync(path.dirname(dbFile), { recursive: true })

  if (!fs.existsSync(dbFile)) {
    const template = templateDbPath()
    if (fs.existsSync(template) && path.resolve(template) !== path.resolve(dbFile)) {
      fs.copyFileSync(template, dbFile)
      ready.add(dbFile)
      return
    }
    // Dev: создаём схему через Prisma CLI, если шаблона нет
    const url = fileUrlFor(dbFile)
    const r = spawnSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate'],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: url },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      },
    )
    if (r.status !== 0) {
      const err = (r.stderr || r.stdout || '').toString().slice(0, 500)
      throw new Error(`Не удалось инициализировать БД группы: ${err || `exit ${r.status}`}`)
    }
  }
  ready.add(dbFile)
}

function makeClient(dbFile: string): PrismaClient {
  ensureSchema(dbFile)
  return new PrismaClient({
    datasourceUrl: fileUrlFor(dbFile),
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error'],
  })
}

function getDefaultClient(): PrismaClient {
  if (!globalForPrisma.prismaDefault) {
    globalForPrisma.prismaDefault = makeClient(defaultDbPath())
  }
  return globalForPrisma.prismaDefault
}

export function getGroupClient(groupId: string): PrismaClient {
  const id = String(groupId || '').trim()
  if (!id || id === 'default') return getDefaultClient()
  const map = globalForPrisma.prismaByGroup ?? new Map<string, PrismaClient>()
  globalForPrisma.prismaByGroup = map
  let client = map.get(id)
  if (!client) {
    client = makeClient(groupDbPath(id))
    map.set(id, client)
  }
  return client
}

export async function withGroupDb<T>(groupId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  const id = String(groupId || '').trim()
  const client = id ? getGroupClient(id) : getDefaultClient()
  return groupAls.run(client, fn)
}

function currentClient(): PrismaClient {
  return groupAls.getStore() ?? getDefaultClient()
}

/** Прокси: внутри `withGroupDb` ходит в БД группы, иначе — в default. */
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, _receiver) {
    const client = currentClient()
    const value = Reflect.get(client, prop, client)
    return typeof value === 'function' ? value.bind(client) : value
  },
})
