/* __uchetGroupWrapped */
import type { Prisma } from '@prisma/client'
import { errMsg } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { DEFECT_STATES, isResolvedDefectState } from '@/lib/statuses'
import { requireRole, atLeast } from '@/lib/auth'
import { withGroupFromRequest } from '@/lib/group-context'

const counterField = (kind: string) => (kind === 'analysis' ? 'analysisQty' : 'repairQty')

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'tester')
  if ('response' in auth) return auth.response
  try {
    const { id } = await params
    const body = await request.json()
    const { state, labelNumber, description, reportedBy, quantity, serial, designator } = body
    const who = auth.session

    if (body.confirmCheck !== undefined && !atLeast(who.role, 'senior')) {
      return NextResponse.json({
        success: false,
        error: 'Подтверждение проверяющего ставит старший тестировщик или начальник',
      }, { status: 403 })
    }

    if (state !== undefined && !DEFECT_STATES[state]) {
      return NextResponse.json({ success: false, error: 'Неизвестное состояние' }, { status: 400 })
    }
    // «Отклонение разрешено» — это формальное разрешение на использование
    // несоответствующего изделия. Такое решение принимает старший/начальник,
    // как и подтверждение проверяющего.
    if (state === 'deviation_approved' && !atLeast(who.role, 'senior')) {
      return NextResponse.json({
        success: false,
        error: 'Решение «Отклонение разрешено» принимает старший тестировщик или начальник',
      }, { status: 403 })
    }

    const defect = await db.defect.findUnique({ where: { id }, include: { act: true } })
    if (!defect) {
      return NextResponse.json({ success: false, error: 'Не найден' }, { status: 404 })
    }

    if (serial !== undefined && String(serial).trim()) {
      const s = String(serial).trim()
      const unitCount = await db.unit.count({ where: { actId: defect.actId } })
      if (unitCount > 0) {
        const unit = await db.unit.findFirst({ where: { actId: defect.actId, serial: s } })
        if (!unit) {
          return NextResponse.json({
            success: false,
            error: `Серийного номера ${s} нет среди отсканированных в акте ${defect.act.actNumber}`,
          }, { status: 400 })
        }
      }
    }

    const newState = state ?? defect.state
    // Один ярлык = один серийник: количество редактируется только у массового дефекта.
    const newQty = defect.kind === 'mass'
      ? (quantity !== undefined ? Math.max(1, parseInt(quantity) || 1) : defect.quantity)
      : 1

    const field = counterField(defect.kind)
    const before = isResolvedDefectState(defect.state) ? 0 : defect.quantity
    const after = isResolvedDefectState(newState) ? 0 : newQty
    const delta = after - before

    if (delta > 0) {
      const busy = (defect.act.repairQty || 0) + (defect.act.analysisQty || 0)
      if (busy + delta > defect.act.quantity) {
        return NextResponse.json({
          success: false,
          error: `Несоответствий больше, чем изделий: в акте ${defect.act.quantity} штук, ` +
            `уже в ремонте и на анализе ${busy}`,
        }, { status: 400 })
      }
    }

    const ops: Prisma.PrismaPromise<unknown>[] = [
      db.defect.update({
        where: { id },
        data: {
          state: newState,
          quantity: newQty,
          resolvedAt: isResolvedDefectState(newState) ? (defect.resolvedAt ?? new Date()) : null,
          ...(labelNumber !== undefined ? { labelNumber: labelNumber || null } : {}),
          ...(serial !== undefined ? { serial: String(serial).trim() || null } : {}),
          ...(designator !== undefined ? { designator: String(designator).trim() || null } : {}),
          ...(description !== undefined ? { description: description || null } : {}),
          ...(reportedBy !== undefined ? { reportedBy: reportedBy || null } : {}),
          ...(body.confirmCheck === true ? { checkedBy: who.code } : {}),
          ...(body.confirmCheck === false ? { checkedBy: null } : {}),
        },
      }),
    ]
    if (delta !== 0) {

      ops.push(db.act.update({
        where: { id: defect.actId },
        data: { [field]: delta > 0 ? { increment: delta } : { decrement: -delta } },
      }))
    }
    const [updated] = await db.$transaction(ops) as [{ labelNumber: string | null }]

    await db.actionLog.create({
      data: {
        actionType: 'UPDATE_DEFECT',
        entityType: 'DEFECT',
        entityId: id,
        entityNumber: defect.act.actNumber,
        actId: defect.actId,
        description:
          state !== undefined && state !== defect.state
            ? `Ярлык ${updated.labelNumber || ''} в акте ${defect.act.actNumber}: ${DEFECT_STATES[newState]}`
            : `Ярлык ${updated.labelNumber || ''} в акте ${defect.act.actNumber}: данные изменены`,
      },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      data: updated,
      message: body.confirmCheck === true
        ? `Проверено: ${who.code}`
        : state !== undefined ? DEFECT_STATES[newState] : 'Сохранено',
    })
  } catch (error) {
    return NextResponse.json({ success: false, error: errMsg(error) }, { status: 500 })
  }
  })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'senior')
  if ('response' in auth) return auth.response
  const who = auth.session
  try {
    const { id } = await params
    const defect = await db.defect.findUnique({ where: { id }, include: { act: true } })
    if (!defect) {
      return NextResponse.json({ success: false, error: 'Не найден' }, { status: 404 })
    }
    const ops: Prisma.PrismaPromise<unknown>[] = [db.defect.delete({ where: { id } })]
    if (!isResolvedDefectState(defect.state)) {
      const field = counterField(defect.kind)
      ops.push(db.act.update({
        where: { id: defect.actId },
        data: { [field]: { decrement: defect.quantity } },
      }))
    }
    await db.$transaction(ops)
    await db.actionLog.create({
      data: {
        actionType: 'DELETE_DEFECT',
        entityType: 'DEFECT',
        entityId: id,
        entityNumber: defect.act.actNumber,
        actId: defect.actId,
        description: `Ярлык${defect.labelNumber ? ` №${defect.labelNumber}` : ''} удалён из акта ${defect.act.actNumber}` +
          ` (${defect.quantity} шт., состояние: ${defect.state}${defect.serial ? `, серийник ${defect.serial}` : ''})`,
        userId: who.code,
      },
    }).catch(() => {})
    return NextResponse.json({ success: true, message: 'Ярлык удалён' })
  } catch (error) {
    return NextResponse.json({ success: false, error: errMsg(error) }, { status: 500 })
  }
  })
}
