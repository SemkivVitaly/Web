import crypto from 'crypto'
import { db } from '@/lib/db'

export function getOnlyOfficeEnv() {
  return {
    dsUrl: (process.env.ONLYOFFICE_URL || '').replace(/\/+$/, ''),
    appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
    secret: process.env.ONLYOFFICE_JWT_SECRET || '',
  }
}

export function onlyOfficeEnabled(): boolean {

  const { appUrl } = getOnlyOfficeEnv()
  return Boolean(appUrl)
}

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function signJwt(payload: object, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest())
  return `${header}.${body}.${sig}`
}

export function verifyJwt(token: string, secret: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const expected = b64url(
    crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest(),
  )
  try {
    return crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function documentKey(): Promise<string> {
  const agg = await db.act.aggregate({ _max: { updatedAt: true }, _count: true })
  const stamp = `${agg._max.updatedAt?.getTime() ?? 0}-${agg._count}`
  return 'journal-' + crypto.createHash('sha1').update(stamp).digest('hex').slice(0, 16)
}
