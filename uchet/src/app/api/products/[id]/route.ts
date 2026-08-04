/* __uchetGroupWrapped */
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

    const product = await db.productType.findUnique({
      where: { id },
      include: {
        _count: { select: { acts: true } }
      }
    })

    if (!product) {
      return NextResponse.json(
        { success: false, error: 'Продукция не найдена' },
        { status: 404 }
      )
    }

    const stats = await db.act.aggregate({
      where: { productId: id },
      _sum: { quantity: true },
      _count: { id: true }
    })

    const statusStats = await db.act.groupBy({
      by: ['status'],
      where: { productId: id },
      _count: { id: true },
      _sum: { quantity: true }
    })

    return NextResponse.json({
      success: true,
      data: {
        ...product,
        stats: {
          totalActs: stats._count.id,
          totalQuantity: stats._sum.quantity || 0,
          byStatus: statusStats
        }
      }
    })
  } catch (error) {
    console.error('Error fetching product:', error)
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении данных о продукции' },
      { status: 500 }
    )
  }
  })
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'senior')
  if ('response' in auth) return auth.response
  try {
    const { id } = await params
    const body = await request.json()
    const { name, sku, category, unit, description, isActive, sortOrder } = body

    const existing = await db.productType.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Продукция не найдена' },
        { status: 404 }
      )
    }

    const oldValues = { ...existing }

    const updateData: Record<string, unknown> = {}
    if (name !== undefined) updateData.name = name.trim()
    if (sku !== undefined) updateData.sku = sku?.trim() || null
    if (category !== undefined) updateData.category = category?.trim() || null
    if (unit !== undefined) updateData.unit = unit?.trim() || 'шт.'
    if (description !== undefined) updateData.description = description?.trim() || null
    if (isActive !== undefined) updateData.isActive = Boolean(isActive)
    if (sortOrder !== undefined) updateData.sortOrder = Number(sortOrder)

    const product = await db.productType.update({
      where: { id },
      data: updateData
    })

    const changes: string[] = []
    if (name && name !== oldValues.name) changes.push(`название: "${oldValues.name}" → "${name}"`)
    if (sku !== undefined && sku !== oldValues.sku) changes.push(`артикул: "${oldValues.sku || '-'}" → "${sku || '-'}"`)
    if (isActive !== undefined && isActive !== oldValues.isActive) {
      changes.push(`статус: "${oldValues.isActive ? 'активен' : 'архивирован'}" → "${isActive ? 'активен' : 'архивирован'}"`)
    }

    if (changes.length > 0) {
      await db.actionLog.create({
        data: {
          actionType: 'UPDATE_PRODUCT',
          entityType: 'PRODUCT',
          entityId: product.id,
          entityNumber: product.code,
          description: `Изменена продукция ${product.code}: ${changes.join(', ')}`,
          changes: JSON.stringify({ before: oldValues, after: product })
        }
      })
    }

    return NextResponse.json({
      success: true,
      data: product,
      message: `Продукция "${product.name}" обновлена`
    })
  } catch (error) {
    console.error('Error updating product:', error)
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении продукции' },
      { status: 500 }
    )
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
  try {
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const force = searchParams.get('force') === 'true'

    const existing = await db.productType.findUnique({
      where: { id },
      include: { _count: { select: { acts: true } } }
    })

    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Продукция не найдена' },
        { status: 404 }
      )
    }

    if (existing._count.acts > 0 && !force) {

      const archived = await db.productType.update({
        where: { id },
        data: { isActive: false }
      })

      await db.actionLog.create({
        data: {
          actionType: 'ARCHIVE_PRODUCT',
          entityType: 'PRODUCT',
          entityId: archived.id,
          entityNumber: archived.code,
          description: `Продукция "${archived.name}" архивирована (${existing._count.acts} связанных актов)`
        }
      })

      return NextResponse.json({
        success: true,
        data: archived,
        message: `Продукция архивирована (есть ${existing._count.acts} связанных актов). Используйте force=true для полного удаления.`,
        archived: true
      })
    }

    await db.productType.delete({ where: { id } })

    await db.actionLog.create({
      data: {
        actionType: 'DELETE_PRODUCT',
        entityType: 'PRODUCT',
        entityId: existing.id,
        entityNumber: existing.code,
        description: `Удалена продукция: ${existing.name} (${existing.code})`
      }
    })

    return NextResponse.json({
      success: true,
      message: `Продукция "${existing.name}" удалена`
    })
  } catch (error) {
    console.error('Error deleting product:', error)
    return NextResponse.json(
      { success: false, error: 'Ошибка при удалении продукции' },
      { status: 500 }
    )
  }
  })
}
