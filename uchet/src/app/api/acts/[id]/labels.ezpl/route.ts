/* __uchetGroupWrapped */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildActEzpl, monthYearLabel } from '@/lib/godex-ezpl'
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGroupFromRequest(request, async () => {
  const { id } = await params
  const act = await db.act.findUnique({
    where: { id },
    include: { units: { orderBy: { serial: 'asc' }, select: { serial: true } } },
  })
  if (!act) return NextResponse.json({ success: false, error: 'Акт не найден' }, { status: 404 })

  const { searchParams } = new URL(request.url)
  const only = searchParams.get('serials')
  const subset = only ? new Set(only.split(',').map(s => s.trim()).filter(Boolean)) : null
  const serials = act.units.map(u => u.serial).filter(s => !subset || subset.has(s))

  if (serials.length === 0) {
    return NextResponse.json({ success: false, error: 'В акте нет серийных номеров' }, { status: 400 })
  }

  const ezpl = buildActEzpl(serials, { actNumber: act.actNumber, dateLabel: monthYearLabel() })

  return new NextResponse(ezpl, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="labels-${act.actNumber}.ezpl"`,
    },
  })
  })
}
