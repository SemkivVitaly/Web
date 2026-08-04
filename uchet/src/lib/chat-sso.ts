import type { Role } from '@/lib/roles'

/** SSO включён, если задан адрес чата (группа передаётся динамически из вкладки). */
export const chatSsoEnabled = (): boolean => Boolean(process.env.CHAT_URL)

export const chatEnv = () => ({
  url: (process.env.CHAT_URL || '').replace(/\/$/, ''),
  publicUrl: (process.env.CHAT_PUBLIC_URL || process.env.CHAT_URL || '').replace(/\/$/, ''),
  /** Опциональный fallback, если groupId не передан в запросе. */
  groupId: process.env.CHAT_GROUP_ID || '',
  groupName: process.env.CHAT_GROUP_NAME || 'группе',
})

const ROLE_BY_CHAT: Record<string, Role> = {
  admin: 'boss',
  moderator: 'senior',
  member: 'tester',
}

export interface ChatUser {
  tag: string
  name: string
  role: Role
  groupId: string
}

const cache = new Map<string, { user: ChatUser | null; until: number }>()

export async function resolveChatUser(
  token: string,
  groupIdInput?: string | null,
): Promise<ChatUser | null> {
  const { url, groupId: envGroupId } = chatEnv()
  const groupId = String(groupIdInput || envGroupId || '').trim()
  if (!url || !token || !groupId) return null

  const cacheKey = `${token}::${groupId}`
  const hit = cache.get(cacheKey)
  if (hit && hit.until > Date.now()) return hit.user

  let user: ChatUser | null = null
  try {
    const meRes = await fetch(`${url}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (meRes.ok) {
      const me = await meRes.json()
      const grRes = await fetch(`${url}/api/groups`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      })
      if (grRes.ok) {
        const groups = await grRes.json()
        const group = Array.isArray(groups)
          ? groups.find((g: { id: unknown }) => String(g.id) === String(groupId))
          : null
        const role = group ? ROLE_BY_CHAT[String(group.role)] : undefined
        if (role) {
          user = {
            tag: String(me.tag || me.username),
            name: String(me.displayName || me.username || me.tag),
            role,
            groupId: String(groupId),
          }
        }
      }
    }
  } catch {
    /* ignore */
  }

  cache.set(cacheKey, { user, until: Date.now() + 15_000 })
  if (cache.size > 500) cache.clear()
  return user
}
