/* __uchetGroupWrapped */
import { errMsg, errCode } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPin, requireRole } from '@/lib/auth'
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'boss')
  if ('response' in auth) return auth.response
  const employees = await db.employee.findMany({
    select: { id: true, code: true, name: true, role: true, isActive: true, chatTag: true, createdAt: true },
    orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
  })
  return NextResponse.json({ success: true, data: employees })
  })
}

export async function POST(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'boss')
  if ('response' in auth) return auth.response
  try {
    const { code, name, role, pin, chatTag } = await request.json()
    if (!code?.trim() || !name?.trim() || !pin) {
      return NextResponse.json({ success: false, error: 'Заполните: код, имя, PIN' }, { status: 400 })
    }
    if (!['tester', 'senior', 'boss'].includes(role)) {
      return NextResponse.json({ success: false, error: 'Неизвестная роль' }, { status: 400 })
    }
    if (!/^\d{4,6}$/.test(String(pin))) {
      return NextResponse.json({ success: false, error: 'PIN — от 4 до 6 цифр' }, { status: 400 })
    }
    const emp = await db.employee.create({
      data: { code: code.trim(), name: name.trim(), role, pin: hashPin(String(pin)), chatTag: chatTag?.trim() || null },
    })
    return NextResponse.json({ success: true, data: { id: emp.id }, message: `Сотрудник ${emp.code} добавлен` })
  } catch (e) {
    if (errCode(e) === 'P2002') {
      return NextResponse.json({ success: false, error: 'Такой код уже есть' }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}
