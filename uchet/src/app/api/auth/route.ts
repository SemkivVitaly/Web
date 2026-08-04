import { errMsg } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  ensureSeedEmployee,
  getSession,
  hashPin,
  setAuthCookies,
  clearAuthCookies,
} from '@/lib/auth'
import { chatSsoEnabled, chatEnv } from '@/lib/chat-sso'
import { withGroupFromRequest, readGroupId } from '@/lib/group-context'

/* __uchetGroupWrapped */

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
    await ensureSeedEmployee()
    const employees = await db.employee.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true, role: true },
      orderBy: { code: 'asc' },
    })
    return NextResponse.json({
      success: true,
      data: {
        me: getSession(request),
        employees,
        chat: {
          sso: chatSsoEnabled(),
          publicUrl: chatEnv().publicUrl,
          groupName: chatEnv().groupName,
          groupId: readGroupId(request),
        },
      },
    })
  })
}

export async function POST(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
    try {
      const { employeeId, pin } = await request.json()
      const emp = await db.employee.findUnique({ where: { id: employeeId } })
      if (!emp || !emp.isActive || emp.pin !== hashPin(String(pin || ''))) {
        return NextResponse.json({ success: false, error: 'Неверный PIN' }, { status: 401 })
      }
      const groupId = readGroupId(request)
      const res = NextResponse.json({
        success: true,
        data: { code: emp.code, name: emp.name, role: emp.role },
        message: `${emp.code} · ${emp.name}`,
      })
      setAuthCookies(res, emp, groupId)
      return res
    } catch (e) {
      return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
    }
  })
}

export async function DELETE() {
  const res = NextResponse.json({ success: true })
  clearAuthCookies(res)
  return res
}
