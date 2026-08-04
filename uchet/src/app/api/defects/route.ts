/* __uchetGroupWrapped */
import { errMsg, errCode, isUserError } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { DEFECT_KINDS, initialDefectState } from '@/lib/statuses'
import { requireRole } from '@/lib/auth'
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  try {
    const { searchParams } = new URL(request.url)
    const actId = searchParams.get('actId')
    const open = searchParams.get('open')

    const defects = await db.defect.findMany({
      where: {
        ...(actId ? { actId } : {}),
        ...(open === '1' || open === 'true' ? { state: { notIn: ['returned', 'deviation_approved'] } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { act: { select: { actNumber: true, actType: true } } },
    })
    return NextResponse.json({ success: true, data: defects })
  } catch (error) {
    return NextResponse.json({ success: false, error: errMsg(error) }, { status: 500 })
  }
  })
}

export async function POST(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'tester')
  if ('response' in auth) return auth.response
  const who = auth.session
  try {
    const body = await request.json()
    const { actId, kind, quantity, labelNumber, ncActNumber, description, reportedBy } = body
    const serial = String(body.serial ?? '').trim() || null
    const designator = String(body.designator ?? '').trim() || null

    if (!actId || !kind) {
      return NextResponse.json({ success: false, error: 'Укажите акт и тип дефекта' }, { status: 400 })
    }
    if (!DEFECT_KINDS[kind]) {
      return NextResponse.json({ success: false, error: 'Неизвестный тип дефекта' }, { status: 400 })
    }

    const clientKey = request.headers.get('Idempotency-Key') || null
    if (clientKey) {
      const dup = await db.defect.findUnique({ where: { clientKey } })
      if (dup) return NextResponse.json({ success: true, data: dup, message: 'Дефект зафиксирован' })
    }

    const act = await db.act.findUnique({ where: { id: actId } })
    if (!act) {
      return NextResponse.json({ success: false, error: 'Акт не найден' }, { status: 404 })
    }

    if (serial) {
      const unit = await db.unit.findFirst({ where: { actId, serial } })
      const unitCount = await db.unit.count({ where: { actId } })
      if (unitCount > 0 && !unit) {
        return NextResponse.json({
          success: false,
          error: `Серийного номера ${serial} нет среди отсканированных в акте ${act.actNumber}`,
        }, { status: 400 })
      }
    }

    // Один ярлык несоответствия = один серийный номер. Количество имеет смысл
    // только у массового дефекта (партийное сообщение разработчику, без ярлыка).
    const qty = kind === 'mass' ? (parseInt(quantity) || 1) : 1
    if (!Number.isFinite(qty) || qty < 1) {
      return NextResponse.json({ success: false, error: 'Количество должно быть целым числом больше нуля' }, { status: 400 })
    }

    let defect
    try {
      defect = await db.$transaction(async (tx) => {
        const fresh = await tx.act.findUnique({ where: { id: actId }, select: { quantity: true, repairQty: true, analysisQty: true } })
        if (!fresh) throw new Error('Акт не найден')
        const busy = (fresh.repairQty || 0) + (fresh.analysisQty || 0)
        if (busy + qty > fresh.quantity) {
          const e: Error & { userError?: boolean } = new Error(
            `Несоответствий больше, чем изделий: в акте ${fresh.quantity} штук, ` +
            `уже в ремонте и на анализе ${busy}, добавить можно не больше ${Math.max(0, fresh.quantity - busy)}`)
          e.userError = true
          throw e
        }
        const created = await tx.defect.create({
          data: {
            actId, kind, clientKey,
            state: initialDefectState(kind),
            quantity: qty,
            labelNumber: labelNumber || null,
            serial, designator,
            description: description || null,
            reportedBy: reportedBy || who.code,
          },
        })
        await tx.act.update({
          where: { id: actId },
          data: {
            ...(kind === 'analysis'
              ? { analysisQty: { increment: qty } }
              : { repairQty: { increment: qty } }),
            ...(ncActNumber ? { ncActNumber } : {}),
          },
        })
        return created
      }, { maxWait: 15000, timeout: 15000 })
    } catch (e) {
      if (errCode(e) === 'P2002' && clientKey) {
        const dup = await db.defect.findUnique({ where: { clientKey } })
        if (dup) return NextResponse.json({ success: true, data: dup, message: 'Дефект зафиксирован' })
      }
      if (isUserError(e)) return NextResponse.json({ success: false, error: errMsg(e) }, { status: 400 })
      throw e
    }

    await db.actionLog.create({
      data: {
        actionType: 'CREATE_DEFECT',
        entityType: 'DEFECT',
        entityId: defect.id,
        entityNumber: act.actNumber,
        actId,
        description:
          kind === 'mass'
            ? `Массовый дефект в акте ${act.actNumber} — сообщено разработчику, ожидание решения`
            : `Дефект (${DEFECT_KINDS[kind]}) в акте ${act.actNumber}: ${qty} шт.`,
        userId: who.code,
      },
    })

    return NextResponse.json({
      success: true,
      data: defect,
      message:
        kind === 'mass'
          ? `Массовый дефект: сообщено разработчику, ожидание решения`
          : `Дефект зафиксирован (${DEFECT_KINDS[kind]})`,
    })
  } catch (error) {
    console.error('POST defect error:', error)
    return NextResponse.json({ success: false, error: errMsg(error) }, { status: 500 })
  }
  })
}
