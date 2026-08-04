/* __uchetGroupWrapped */
import { errMsg } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { applyStatusChange } from '@/lib/act-transitions';
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  try {
    const shipments = await db.shipment.findMany({
      orderBy: { createdAt: 'desc' },
      include: { act: { select: { actNumber: true, actType: true, quantity: true, employeeName: true } } },
    });
    return NextResponse.json({ success: true, data: shipments });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
  })
}

export async function POST(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'senior');
  if ('response' in auth) return auth.response;
  try {
    const body = await request.json();
    const { actId, shipmentDate, shipmentTime, employeeName, notes, needsAnalysis, needsRepair } = body;

    if (!actId) {
      return NextResponse.json({ success: false, error: 'Укажите акт' }, { status: 400 });
    }

    const act = await db.act.findUnique({ where: { id: actId } });
    if (!act) {
      return NextResponse.json({ success: false, error: 'Акт не найден' }, { status: 404 });
    }

    const last = await db.shipment.findFirst({ orderBy: { createdAt: 'desc' }, select: { shipmentNumber: true } });
    const num = last?.shipmentNumber ? (parseInt(last.shipmentNumber.split('-')[1]) || 0) + 1 : 1;
    const shipmentNumber = `SHP-${num.toString().padStart(3, '0')}`;

    const shipment = await db.shipment.create({
      data: {
        shipmentNumber,
        actId,
        shipmentDate: shipmentDate ? new Date(shipmentDate) : new Date(),
        shipmentTime: shipmentTime || new Date().toTimeString().slice(0, 5),
        employeeName: employeeName || null,
        notes: notes || null,
        needsAnalysis: needsAnalysis || false,
        needsRepair: needsRepair || false,
      },
    });

    if (act.status !== 'shipped') {
      const res = await applyStatusChange(actId, 'shipped', auth.session, `Отгрузка ${shipmentNumber}`);
      if (!res.ok) console.error('shipment: не удалось сменить статус акта:', res.error);
    }

    return NextResponse.json({
      success: true,
      data: shipment,
      message: `Отгрузка ${shipmentNumber} создана`
    });
  } catch (error) {
    console.error('POST shipment error:', error);
    return NextResponse.json({ success: false, error: errMsg(error) }, { status: 500 });
  }
  })
}

export async function PATCH(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'senior');
  if ('response' in auth) return auth.response;
  try {
    const body = await request.json();
    const { id, needsAnalysis, needsRepair, notes } = body;

    if (!id) {
      return NextResponse.json({ success: false, error: 'Укажите ID отгрузки' }, { status: 400 });
    }

    const existing = await db.shipment.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ success: false, error: 'Отгрузка не найдена' }, { status: 404 });
    }

    const updateData: Record<string, any> = {};
    if (typeof needsAnalysis === 'boolean') updateData.needsAnalysis = needsAnalysis;
    if (typeof needsRepair === 'boolean') updateData.needsRepair = needsRepair;
    if (notes !== undefined) updateData.notes = notes;

    const shipment = await db.shipment.update({
      where: { id },
      data: updateData,
    });

    const changes: string[] = [];
    if (needsAnalysis === false && existing.needsAnalysis) changes.push('снято с анализа');
    if (needsAnalysis === true && !existing.needsAnalysis) changes.push('направлено на анализ');
    if (needsRepair === false && existing.needsRepair) changes.push('снято с ремонта');
    if (needsRepair === true && !existing.needsRepair) changes.push('направлено на ремонт');

    return NextResponse.json({
      success: true,
      data: shipment,
      message: changes.length > 0
        ? `Отгрузка ${shipment.shipmentNumber}: ${changes.join(', ')}`
        : `Отгрузка ${shipment.shipmentNumber} обновлена`
    });
  } catch (error) {
    console.error('PATCH shipment error:', error);
    return NextResponse.json({ success: false, error: errMsg(error, 'Ошибка обновления') }, { status: 500 });
  }
  })
}
