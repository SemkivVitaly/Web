import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { db, withGroupDb } from '@/lib/db'
import { signJwt, verifyJwt } from '@/lib/onlyoffice'
import { GROUP_COOKIE } from '@/lib/group-context'

import { ROLE_LABELS, atLeast, type Role } from '@/lib/roles'
export { ROLE_LABELS, atLeast }
export type { Role }

function resolveSecret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET
  try {
    const dir = fs.existsSync('/app/data') ? '/app/data' : path.join(process.cwd(), 'db')
    const file = path.join(dir, '.auth-secret')
    if (fs.existsSync(file)) {
      const s = fs.readFileSync(file, 'utf8').trim()
      if (s.length >= 32) return s
    }
    const fresh = crypto.randomBytes(32).toString('hex')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, fresh, { mode: 0o600 })
    return fresh
  } catch {
    return crypto.randomBytes(32).toString('hex')
  }
}
const SECRET = resolveSecret()
export const SESSION_COOKIE = 'uchet_session'
const SESSION_HOURS = 12

export const hashPin = (pin: string): string =>
  crypto.createHash('sha256').update(`uchet:${pin}`).digest('hex')

export interface Session {
  id: string
  code: string
  name: string
  role: Role
  groupId?: string
  exp: number
}

export function createSessionToken(
  emp: { id: string; code: string; name: string; role: string },
  groupId?: string | null,
): string {
  const session: Session = {
    id: emp.id,
    code: emp.code,
    name: emp.name,
    role: emp.role as Role,
    groupId: groupId ? String(groupId) : undefined,
    exp: Date.now() + SESSION_HOURS * 3600_000,
  }
  return signJwt(session, SECRET)
}

export function getSession(request: NextRequest): Session | null {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (!token || !verifyJwt(token, SECRET)) return null
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
    ) as Session
    if (!payload.exp || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export function setAuthCookies(
  res: NextResponse,
  emp: { id: string; code: string; name: string; role: string },
  groupId?: string | null,
) {
  res.cookies.set(SESSION_COOKIE, createSessionToken(emp, groupId), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 12 * 3600,
  })
  if (groupId) {
    res.cookies.set(GROUP_COOKIE, String(groupId), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 3600,
    })
  }
}

export function clearAuthCookies(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  res.cookies.set(GROUP_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
}

export async function requireRole(
  request: NextRequest,
  min: Role = 'tester',
): Promise<{ session: Session } | { response: NextResponse }> {
  const session = getSession(request)
  if (!session) {
    return {
      response: NextResponse.json(
        { success: false, error: 'Войдите в систему, чтобы вносить изменения', needLogin: true },
        { status: 401 },
      ),
    }
  }

  const run = async () => {
    const emp = await db.employee
      .findUnique({
        where: { id: session.id },
        select: { code: true, name: true, role: true, isActive: true },
      })
      .catch(() => null)
    if (!emp || !emp.isActive) {
      return {
        response: NextResponse.json(
          { success: false, error: 'Учётная запись отключена — войдите заново', needLogin: true },
          { status: 401 },
        ),
      } as const
    }
    const live: Session = {
      ...session,
      code: emp.code,
      name: emp.name,
      role: emp.role as Role,
    }
    if (!atLeast(live.role, min)) {
      return {
        response: NextResponse.json(
          { success: false, error: `Недостаточно прав (нужна роль: ${ROLE_LABELS[min]})` },
          { status: 403 },
        ),
      } as const
    }
    return { session: live } as const
  }

  // Если вызывающий уже внутри withGroupFromRequest — ALS активен.
  // Иначе подхватываем groupId из сессии/cookie.
  const groupId =
    session.groupId ||
    request.cookies.get(GROUP_COOKIE)?.value ||
    request.headers.get('x-uchet-group-id')
  if (groupId) return withGroupDb(groupId, run)
  return run()
}

export async function ensureSeedEmployee(): Promise<void> {
  const count = await db.employee.count()
  if (count === 0) {
    await db.employee.create({
      data: { code: 'АДМ', name: 'Администратор', role: 'boss', pin: hashPin('1234') },
    })
  }
}

/** Создаёт или обновляет сотрудника по тегу чата (без ручной привязки). */
export async function upsertEmployeeFromChat(chatUser: {
  tag: string
  name: string
  role: Role
}): Promise<{ id: string; code: string; name: string; role: string }> {
  let emp = await db.employee.findUnique({ where: { chatTag: chatUser.tag } })
  if (emp) {
    if (emp.role !== chatUser.role || emp.name !== chatUser.name || !emp.isActive) {
      emp = await db.employee.update({
        where: { id: emp.id },
        data: { role: chatUser.role, name: chatUser.name, isActive: true },
      })
    }
    return emp
  }

  const legacy = await db.employee.findUnique({ where: { code: `chat:${chatUser.tag}` } })
  if (legacy) {
    return db.employee.update({
      where: { id: legacy.id },
      data: {
        chatTag: chatUser.tag,
        role: chatUser.role,
        name: chatUser.name,
        isActive: true,
      },
    })
  }

  const base = `LC-${chatUser.tag}`.replace(/[^\wа-яА-ЯёЁ-]/gi, '_').slice(0, 24)
  let code = base || `LC-${Date.now().toString(36)}`
  let n = 0
  while (await db.employee.findUnique({ where: { code } })) {
    n += 1
    code = `${base}-${n}`.slice(0, 32)
  }

  return db.employee.create({
    data: {
      code,
      chatTag: chatUser.tag,
      name: chatUser.name,
      role: chatUser.role,
      pin: hashPin(crypto.randomBytes(16).toString('hex')),
      isActive: true,
    },
  })
}
