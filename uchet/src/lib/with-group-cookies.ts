import { cookies } from 'next/headers'
import { withGroupDb } from '@/lib/db'

/** Server Components (печать и т.п.): БД группы из cookie SSO. */
export async function withGroupFromCookies<T>(fn: () => Promise<T>): Promise<T> {
  const jar = await cookies()
  const groupId = jar.get('uchet_group')?.value
  return withGroupDb(groupId, fn)
}
