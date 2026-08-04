/* __uchetGroupWrapped */
import { errMsg } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGroupFromRequest(request, async () => {
  try {
    const { id } = await params
    const units = await db.unit.findMany({
      where: { actId: id },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ success: true, data: units })
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'tester')
  if ('response' in auth) return auth.response
  const who = auth.session
  try {
    const { id } = await params
    const body = await request.json()
    const raw: unknown[] = Array.isArray(body.serials) ? body.serials : [body.serial]
    const serials = [...new Set(
      raw.map(s => String(s ?? '').trim()).filter(s => s.length > 0)
    )]
    if (serials.length === 0) {
      return NextResponse.json({ success: false, error: 'Серийные номера не указаны' }, { status: 400 })
    }

    const act = await db.act.findUnique({ where: { id }, select: { actNumber: true, quantity: true, status: true } })
    if (!act) return NextResponse.json({ success: false, error: 'Акт не найден' }, { status: 404 })
    if (act.status === 'shipped') {
      return NextResponse.json({
        success: false,
        error: `Акт ${act.actNumber} уже отгружен — серийные номера менять нельзя`,
      }, { status: 400 })
    }

    let fresh: string[] = []
    let knownCount = 0
    try {
      await db.$transaction(async (tx) => {
        const existing = await tx.unit.findMany({
          where: { actId: id, serial: { in: serials } },
          select: { serial: true },
        })
        const known = new Set(existing.map(u => u.serial))
        knownCount = known.size
        fresh = serials.filter(s => !known.has(s))
        if (fresh.length === 0) return
        const current = await tx.unit.count({ where: { actId: id } })
        if (current + fresh.length > act.quantity) {
          throw new Error(
            `Серийных номеров больше, чем изделий: в акте ${act.quantity} штук, ` +
            `уже отсканировано ${current}, добавить можно не больше ${Math.max(0, act.quantity - current)}`,
          )
        }
        await tx.unit.createMany({ data: fresh.map(serial => ({ actId: id, serial, acceptedBy: who.code, acceptedAt: new Date(), unitState: 'accepted' })) })
      })
    } catch (txError) {
      return NextResponse.json({ success: false, error: errMsg(txError) }, { status: 400 })
    }
    const known = { size: knownCount }

    if (fresh.length > 0) {
      await db.actionLog.create({
        data: {
          actionType: 'ADD_UNITS',
          entityType: 'ACT',
          entityId: id,
          entityNumber: act.actNumber,
          actId: id,
          description: `Акт ${act.actNumber}: добавлено серийных номеров — ${fresh.length}` +
            (known.size > 0 ? ` (пропущено дублей: ${known.size})` : ''),
          userId: who.code,
        },
      }).catch(() => {})
    }

    const total = await db.unit.count({ where: { actId: id } })
    return NextResponse.json({
      success: true,
      data: { added: fresh.length, skipped: known.size, total },
      message: fresh.length > 0
        ? `Добавлено: ${fresh.length}${known.size ? `, дублей пропущено: ${known.size}` : ''}`
        : 'Все эти серийные номера уже есть в акте',
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'tester')
  if ('response' in auth) return auth.response
  const who = auth.session
  try {
    const { id } = await params
    const body = await request.json()
    const serial = String(body.serial ?? '').trim()
    if (!serial) return NextResponse.json({ success: false, error: 'Серийный номер не указан' }, { status: 400 })

    const act = await db.act.findUnique({ where: { id }, select: { actNumber: true, status: true } })
    if (!act) return NextResponse.json({ success: false, error: 'Акт не найден' }, { status: 404 })
    if (act.status === 'shipped' && who.role !== 'boss') {
      return NextResponse.json({
        success: false,
        error: `Акт ${act.actNumber} уже отгружен — серийные номера может менять только начальник`,
      }, { status: 400 })
    }

    const linkedDefect = await db.defect.findFirst({
      where: { actId: id, serial },
      select: { labelNumber: true, state: true },
    })
    if (linkedDefect) {
      return NextResponse.json({
        success: false,
        error: `На серийный номер ${serial} заведён ярлык несоответствия` +
          (linkedDefect.labelNumber ? ` №${linkedDefect.labelNumber}` : '') +
          ' — сначала исправьте или удалите ярлык, иначе порвётся прослеживаемость',
      }, { status: 400 })
    }

    const removed = await db.unit.deleteMany({ where: { actId: id, serial } })
    if (removed.count === 0) {
      return NextResponse.json({ success: false, error: 'Такого серийного номера нет в акте' }, { status: 404 })
    }
    await db.actionLog.create({
      data: {
        actionType: 'REMOVE_UNIT',
        entityType: 'ACT',
        entityId: id,
        entityNumber: act.actNumber,
        actId: id,
        description: `Акт ${act.actNumber}: удалён серийный номер ${serial}`,
        userId: who.code,
      },
    }).catch(() => {})
    return NextResponse.json({ success: true, message: `Серийный номер ${serial} удалён` })
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}
