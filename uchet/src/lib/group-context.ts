import { NextRequest } from 'next/server'
import { withGroupDb } from '@/lib/db'

export const GROUP_COOKIE = 'uchet_group'

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie') || ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('=') || '')
  }
  return null
}

export function readGroupId(request: Request | NextRequest | null | undefined): string | null {
  if (!request) return null
  const fromHeader = request.headers.get('x-uchet-group-id')
  if (fromHeader && /^\d+$/.test(fromHeader.trim())) return fromHeader.trim()
  const fromCookie =
    'cookies' in request && typeof (request as NextRequest).cookies?.get === 'function'
      ? (request as NextRequest).cookies.get(GROUP_COOKIE)?.value
      : cookieValue(request, GROUP_COOKIE)
  if (fromCookie && /^\d+$/.test(fromCookie.trim())) return fromCookie.trim()
  try {
    const url = new URL(request.url)
    const fromQuery = url.searchParams.get('groupId')
    if (fromQuery && /^\d+$/.test(fromQuery.trim())) return fromQuery.trim()
  } catch {
    /* ignore */
  }
  return null
}

/** Выполняет API-обработчик в контексте БД группы из cookie/заголовка. */
export function withGroupFromRequest<T>(
  request: Request | NextRequest | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return withGroupDb(readGroupId(request), fn)
}
