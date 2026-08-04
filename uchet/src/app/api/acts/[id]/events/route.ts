/* __uchetGroupWrapped */
import { errMsg } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { applyStatusChange } from '@/lib/act-transitions'
import { STATUS_LABELS, nextStep } from '@/lib/statuses'
import { withGroupFromRequest } from '@/lib/group-context'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'tester')
  if ('response' in auth) return auth.response
  try {
    const { id } = await params
    const body = await request.json()

    let target: string | null = null
    if (body.type === 'next') {
      const act = await db.act.findUnique({ where: { id }, select: { status: true } })
      if (!act) return NextResponse.json({ success: false, error: 'Акт не найден' }, { status: 404 })
      target = nextStep(act.status)
      if (!target) {
        return NextResponse.json({ success: false, error: 'Акт уже в конечном статусе' }, { status: 400 })
      }
    } else if (body.type === 'retest') {
      target = 'in_progress'
    } else if (body.type === 'to' && body.status) {
      target = String(body.status)
    } else {
      return NextResponse.json({ success: false, error: 'Неизвестный тип события' }, { status: 400 })
    }

    const expectedFrom = body.expectedFrom ? String(body.expectedFrom) : undefined
    const result = await applyStatusChange(id, target, auth.session, body.comment, expectedFrom)
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status || 400 })
    }
    return NextResponse.json({
      success: true,
      data: result.act,
      message: `${STATUS_LABELS[target] || target}`,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}
