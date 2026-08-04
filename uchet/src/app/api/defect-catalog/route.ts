/* __uchetGroupWrapped */
import { errMsg } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  try {
    const { searchParams } = new URL(request.url)
    const productId = searchParams.get('productId')
    const rows = await db.defectCatalog.findMany({
      where: {
        isActive: true,
        ...(productId ? { OR: [{ productId }, { productId: null }] } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { text: 'asc' }],
    })
    return NextResponse.json({ success: true, data: rows })
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}

export async function POST(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'tester')
  if ('response' in auth) return auth.response
  try {
    const body = await request.json()
    const text = String(body.text ?? '').trim()
    if (!text) return NextResponse.json({ success: false, error: 'Пустая формулировка' }, { status: 400 })
    const dup = await db.defectCatalog.findFirst({ where: { text } })
    if (dup) return NextResponse.json({ success: true, data: dup, message: 'Уже есть в каталоге' })
    const row = await db.defectCatalog.create({
      data: { text, productId: body.productId || null },
    })
    return NextResponse.json({ success: true, data: row, message: 'Добавлено в каталог дефектов' })
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}

export async function DELETE(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'senior')
  if ('response' in auth) return auth.response
  try {
    const body = await request.json()
    if (!body.id) return NextResponse.json({ success: false, error: 'Не указан id' }, { status: 400 })
    await db.defectCatalog.update({ where: { id: String(body.id) }, data: { isActive: false } })
    return NextResponse.json({ success: true, message: 'Формулировка убрана из каталога' })
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
  })
}
