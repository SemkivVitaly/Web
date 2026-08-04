/* __uchetGroupWrapped */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  try {
    const { searchParams } = new URL(request.url)
    const includeInactive = searchParams.get('includeInactive') === 'true'
    const withStats = searchParams.get('withStats') === 'true'

    const where: Record<string, unknown> = {}
    if (!includeInactive) {
      where.isActive = true
    }

    const products = await db.productType.findMany({
      where,
      orderBy: { sortOrder: 'asc' }
    })

    let productsWithStats = products
    if (withStats) {
      productsWithStats = await Promise.all(
        products.map(async (product) => {
          const actsCount = await db.act.count({
            where: { productId: product.id }
          })
          const totalQuantity = await db.act.aggregate({
            where: { productId: product.id },
            _sum: { quantity: true }
          })
          return {
            ...product,
            _count: { acts: actsCount },
            _sum: { quantity: totalQuantity._sum.quantity || 0 }
          }
        })
      )
    }

    return NextResponse.json({
      success: true,
      data: productsWithStats,
      count: productsWithStats.length
    })
  } catch (error) {
    console.error('Error fetching products:', error)
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении списка продукции' },
      { status: 500 }
    )
  }
  })
}

export async function POST(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'tester')
  if ('response' in auth) return auth.response
  try {
    const body = await request.json()
    const { name, sku, category, unit, description, sortOrder } = body

    if (!name || name.trim() === '') {
      return NextResponse.json(
        { success: false, error: 'Название продукции обязательно' },
        { status: 400 }
      )
    }

    const existingCodes = await db.productType.findMany({ select: { code: true } })
    const nextNumber = existingCodes.reduce((max, p) => {
      const match = p.code.match(/^PROD-(\d+)$/)
      const n = match ? parseInt(match[1]) : 0
      return n > max ? n : max
    }, 0) + 1
    const code = `PROD-${String(nextNumber).padStart(3, '0')}`

    const product = await db.productType.create({
      data: {
        code,
        name: name.trim(),
        sku: sku?.trim() || null,
        category: category?.trim() || null,
        unit: unit?.trim() || 'шт.',
        description: description?.trim() || null,
        sortOrder: typeof sortOrder === 'number' ? sortOrder : 0
      }
    })

    await db.actionLog.create({
      data: {
        actionType: 'CREATE_PRODUCT',
        entityType: 'PRODUCT',
        entityId: product.id,
        entityNumber: product.code,
        description: `Создан тип продукции: ${product.name} (${product.code})`
      }
    })

    return NextResponse.json({
      success: true,
      data: product,
      message: `Продукция "${product.name}" успешно создана`
    }, { status: 201 })
  } catch (error) {
    console.error('Error creating product:', error)

    if (error instanceof Error && 'code' in error && error.code === 'P2002') {
      return NextResponse.json(
        { success: false, error: 'Продукция с таким кодом уже существует' },
        { status: 409 }
      )
    }

    return NextResponse.json(
      { success: false, error: 'Ошибка при создании продукции' },
      { status: 500 }
    )
  }
  })
}

export async function PUT(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'tester')
  if ('response' in auth) return auth.response
  try {
    const body = await request.json()
    const { items } = body

    if (!Array.isArray(items)) {
      return NextResponse.json(
        { success: false, error: 'Неверный формат данных' },
        { status: 400 }
      )
    }

    for (const item of items) {
      await db.productType.update({
        where: { id: item.id },
        data: { sortOrder: item.sortOrder }
      })
    }

    return NextResponse.json({
      success: true,
      message: 'Порядок сортировки обновлён'
    })
  } catch (error) {
    console.error('Error updating product order:', error)
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении порядка' },
      { status: 500 }
    )
  }
  })
}
