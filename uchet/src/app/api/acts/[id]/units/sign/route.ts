/* __uchetGroupWrapped */
import { errMsg } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole, atLeast } from '@/lib/auth'
import { stageByKey, stageForActStatus } from '@/lib/unit-stages'
import { withGroupFromRequest } from '@/lib/group-context'

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

    const act = await db.act.findUnique({ where: { id }, select: { actNumber: true, status: true } })
    if (!act) return NextResponse.json({ success: false, error: 'Акт не найден' }, { status: 404 })

    const stage = body.stage ? stageByKey(String(body.stage)) : stageForActStatus(act.status)
    if (!stage) {
      return NextResponse.json({
        success: false,
        error: `На стадии «${act.status}» подпись изделий не предусмотрена`,
      }, { status: 400 })
    }
    if (!atLeast(who.role, stage.minRole)) {
      return NextResponse.json({
        success: false,
        error: `Этап «${stage.label}» подписывает ${stage.minRole === 'senior' ? 'старший техник или начальник' : 'тестировщик и выше'}`,
      }, { status: 403 })
    }

    const all = body.all === true
    const serials: string[] = Array.isArray(body.serials)
      ? [...new Set(body.serials.map((s: unknown) => String(s ?? '').trim()).filter((s: string) => s.length > 0))] as string[]
      : []
    if (!all && serials.length === 0) {
      return NextResponse.json({ success: false, error: 'Не указаны серийные номера' }, { status: 400 })
    }

    const where = all ? { actId: id } : { actId: id, serial: { in: serials } }
    const now = new Date()
    const res = await db.unit.updateMany({
      where,
      data: { [stage.byField]: who.code, [stage.atField]: now, unitState: stage.key },
    })

    await db.actionLog.create({
      data: {
        actionType: 'SIGN_UNITS',
        entityType: 'ACT',
        entityId: id,
        entityNumber: act.actNumber,
        actId: id,
        description: `Акт ${act.actNumber}, этап «${stage.label}»: подписано изделий — ${res.count}` +
          (all ? ' (все)' : ` (${serials.join(', ')})`),
        userId: who.code,
      },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      data: { signed: res.count, stage: stage.key, by: who.code, at: now.toISOString() },
      message: `${stage.label}: подписано ${res.count} шт.`,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}
