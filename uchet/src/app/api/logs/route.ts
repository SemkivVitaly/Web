/* __uchetGroupWrapped */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: Request) {
  return withGroupFromRequest(request, async () => {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50') || 50, 1), 500);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0') || 0, 0);
    const actionType = searchParams.get('actionType');
    const entityType = searchParams.get('entityType');
    const actId = searchParams.get('actId');

    const where: Record<string, any> = {};
    if (actionType) where.actionType = actionType;
    if (entityType) where.entityType = entityType;
    if (actId) where.actId = actId;

    const [logs, total] = await Promise.all([
      db.actionLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          act: {
            select: { actNumber: true, actType: true },
          },
        },
      }),
      db.actionLog.count({ where }),
    ]);

    return NextResponse.json({
      success: true,
      data: logs,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении логов' },
      { status: 500 }
    );
  }
  })
}
