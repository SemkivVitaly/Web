/* __uchetGroupWrapped */
import { errMsg, errCode } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPin, requireRole } from '@/lib/auth'
import { ROLE_LABELS } from '@/lib/roles'
import { withGroupFromRequest } from '@/lib/group-context'

const roleLabel = (r: string) => ROLE_LABELS[r as keyof typeof ROLE_LABELS] || r

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'boss')
  if ('response' in auth) return auth.response
  const who = auth.session
  try {
    const { id } = await params
    const { code, name, role, pin, isActive, chatTag } = await request.json()

    const target = await db.employee.findUnique({ where: { id } })
    if (!target) return NextResponse.json({ success: false, error: 'Не найден' }, { status: 404 })

    // Нельзя оставить систему без единственного действующего начальника:
    // блокируем понижение роли и отключение последнего активного boss.
    const demoting = role !== undefined && role !== 'boss'
    const deactivating = isActive !== undefined && !Boolean(isActive)
    if (target.role === 'boss' && target.isActive && (demoting || deactivating)) {
      const otherBosses = await db.employee.count({
        where: { role: 'boss', isActive: true, id: { not: id } },
      })
      if (otherBosses === 0) {
        return NextResponse.json({
          success: false,
          error: 'Это единственный действующий начальник — нельзя понизить роль или отключить. Сначала назначьте другого начальника.',
        }, { status: 400 })
      }
    }
    // Себя нельзя отключить — иначе можно случайно потерять доступ к разделу.
    if (who.id === id && deactivating) {
      return NextResponse.json({
        success: false,
        error: 'Нельзя отключить самого себя.',
      }, { status: 400 })
    }

    const data: Record<string, unknown> = {}
    if (code !== undefined) {
      const c = String(code).trim()
      if (!c) return NextResponse.json({ success: false, error: 'Табельный код не может быть пустым' }, { status: 400 })
      data.code = c
    }
    if (name !== undefined) data.name = String(name).trim()
    if (role !== undefined) {
      if (!['tester', 'senior', 'boss'].includes(role)) {
        return NextResponse.json({ success: false, error: 'Неизвестная роль' }, { status: 400 })
      }
      data.role = role
    }
    if (pin !== undefined && pin !== '') {
      if (!/^\d{4,6}$/.test(String(pin))) {
        return NextResponse.json({ success: false, error: 'PIN — от 4 до 6 цифр' }, { status: 400 })
      }
      data.pin = hashPin(String(pin))
    }
    if (isActive !== undefined) data.isActive = Boolean(isActive)
    if (chatTag !== undefined) data.chatTag = String(chatTag).trim() || null
    const emp = await db.employee.update({ where: { id }, data })

    // Значимые изменения по сотруднику оставляют след в «Действиях»
    // (роль, отключение/возврат, смена табельного). Смена PIN не логируется.
    const notes: string[] = []
    if (data.role !== undefined && data.role !== target.role) {
      notes.push(`роль ${roleLabel(target.role)} → ${roleLabel(String(data.role))}`)
    }
    if (data.isActive !== undefined && data.isActive !== target.isActive) {
      notes.push(data.isActive ? 'возвращён в строй' : 'отключён')
    }
    if (data.code !== undefined && data.code !== target.code) {
      notes.push(`табельный ${target.code} → ${data.code}`)
    }
    if (notes.length > 0) {
      await db.actionLog.create({
        data: {
          actionType: 'UPDATE_EMPLOYEE',
          entityType: 'EMPLOYEE',
          entityId: id,
          entityNumber: emp.code,
          description: `Сотрудник ${emp.code} (${emp.name}): ${notes.join('; ')}`,
          userId: who.code,
        },
      }).catch(() => {})
    }

    return NextResponse.json({ success: true, message: `Сотрудник ${emp.code} обновлён` })
  } catch (e) {
    if (errCode(e) === 'P2002') {
      return NextResponse.json({ success: false, error: 'Такой табельный код или тег в чате уже заняты' }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'boss')
  if ('response' in auth) return auth.response
  const who = auth.session
  try {
    const { id } = await params
    const emp = await db.employee.findUnique({ where: { id } })
    if (!emp) return NextResponse.json({ success: false, error: 'Не найден' }, { status: 404 })

    if (who.id === id) {
      return NextResponse.json({
        success: false,
        error: 'Нельзя удалить самого себя.',
      }, { status: 400 })
    }
    if (emp.role === 'boss' && emp.isActive) {
      const otherBosses = await db.employee.count({
        where: { role: 'boss', isActive: true, id: { not: id } },
      })
      if (otherBosses === 0) {
        return NextResponse.json({
          success: false,
          error: 'Это единственный действующий начальник — нельзя удалить. Сначала назначьте другого начальника.',
        }, { status: 400 })
      }
    }

    await db.employee.delete({ where: { id } })
    await db.actionLog.create({
      data: {
        actionType: 'DELETE_EMPLOYEE',
        entityType: 'EMPLOYEE',
        entityId: id,
        entityNumber: emp.code,
        description: `Сотрудник ${emp.code} (${emp.name}, ${roleLabel(emp.role)}) удалён из системы. ` +
          `Подписи в истории под табельным ${emp.code} сохранены.`,
        userId: who.code,
      },
    }).catch(() => {})
    return NextResponse.json({ success: true, message: `Сотрудник ${emp.code} удалён` })
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}
