/* __uchetGroupWrapped */
import { errMsg, errCode } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  try {
    const { searchParams } = new URL(request.url);
    const number = searchParams.get('number');
    const active = searchParams.get('active');
    if (number || active) {
      let light = await db.act.findMany({
        where: number
          ? { actNumber: number.trim() }
          : { status: { not: 'shipped' } },
        orderBy: { createdAt: 'desc' },
        take: number ? 20 : 60,
        include: { product: { select: { id: true, name: true, code: true, unit: true } } },
      });

      if (number) {
        const units = await db.unit.findMany({
          where: { serial: number.trim() },
          select: { actId: true },
          take: 20,
        });
        const missing = units.map(u => u.actId).filter(aid => !light.some(a => a.id === aid));
        if (missing.length > 0) {
          const byserial = await db.act.findMany({
            where: { id: { in: missing } },
            include: { product: { select: { id: true, name: true, code: true, unit: true } } },
          });
          light = [...light, ...byserial];
        }
      }
      return NextResponse.json({ success: true, data: light });
    }

    const acts = await db.act.findMany({
      orderBy: { createdAt: 'desc' },
      include: { product: { select: { id: true, name: true, code: true, unit: true } } },
    });

    const logs = await db.actionLog.findMany({
      where: { actionType: { in: ['CREATE_ACT', 'CHANGE_STATUS'] }, actId: { not: null } },
      select: { actId: true, actionType: true, changes: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const transitions = new Map<string, Record<string, string>>();
    for (const log of logs) {
      if (!log.actId) continue;
      const map = transitions.get(log.actId) ?? {};
      if (log.actionType === 'CREATE_ACT') {
        if (!map.accepted) map.accepted = log.createdAt.toISOString();
      } else if (log.changes) {
        try {
          const to = JSON.parse(log.changes).to as string;
          if (to && !map[to]) map[to] = log.createdAt.toISOString();
        } catch {  }
      }
      transitions.set(log.actId, map);
    }

    const data = acts.map(a => {
      const map = { ...(transitions.get(a.id) ?? {}) };
      if (!map.accepted) map.accepted = a.actDate.toISOString();
      if (!map.ready_to_ship && a.plannedShipAt) map.ready_to_ship = a.plannedShipAt.toISOString();
      if (!map.shipped && a.actualShipAt) map.shipped = a.actualShipAt.toISOString();
      return { ...a, statusDates: map };
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
  })
}

export async function POST(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'senior');
  if ('response' in auth) return auth.response;
  const who = auth.session;
  try {
    const body = await request.json();
    const { actNumber: manualActNumber, actDate, actTime, actType, quantity, productId, employeeId, notes, source } = body;

    if (!actDate || !actTime || !actType || !quantity) {
      return NextResponse.json({ success: false, error: 'Заполните: дата, время, источник, количество' }, { status: 400 });
    }
    const qty = parseInt(quantity);
    if (!Number.isFinite(qty) || qty < 1) {
      return NextResponse.json({ success: false, error: 'Количество должно быть целым числом больше нуля' }, { status: 400 });
    }

    const clientKey = request.headers.get('Idempotency-Key') || null;
    if (clientKey) {
      const dup = await db.act.findUnique({ where: { clientKey } });
      if (dup) return NextResponse.json({ success: true, data: dup, message: `Акт ${dup.actNumber} создан` });
    }

    const serials: string[] = Array.isArray(body.serials)
      ? [...new Set(body.serials.map((s: unknown) => String(s ?? '').trim()).filter((s: string) => s.length > 0))] as string[]
      : [];
    if (serials.length > 0 && serials.length !== qty) {
      return NextResponse.json({
        success: false,
        error: `Отсканировано ${serials.length} серийных номеров, а количество указано ${qty}. ` +
          `Количество должно совпадать с числом серийников.`,
      }, { status: 400 });
    }

    const initialRepair = Math.max(0, parseInt(body.initialRepairQty) || 0);
    const initialAnalysis = Math.max(0, parseInt(body.initialAnalysisQty) || 0);
    if (initialRepair + initialAnalysis > qty) {
      return NextResponse.json({
        success: false,
        error: `В ремонте и на анализе (${initialRepair + initialAnalysis}) не может быть больше, чем изделий в акте (${qty})`,
      }, { status: 400 });
    }

    let actNumber = manualActNumber?.trim() || '';

    let resolvedProductId: string | null = productId || null;
    if (!resolvedProductId && actType) {
      let product = await db.productType.findFirst({ where: { name: String(actType).trim() } });
      if (!product) {
        product = await db.productType.create({
          data: { code: `PROD-${String(actType).trim()}`, name: String(actType).trim() },
        });
      }
      resolvedProductId = product.id;
    }

    const srcLabel = source || 'Склад';

    const purpose = String(body.purpose || 'Тестирование').trim() || 'Тестирование';
    let act;
    try {
      act = await db.$transaction(async (tx) => {
      if (!actNumber) {

        const generated = await tx.act.findMany({
          where: { actNumber: { startsWith: 'ACT-' } },
          select: { actNumber: true },
        });
        const num = generated.reduce((max, a) => {
          const n = parseInt(a.actNumber.slice(4));
          return Number.isFinite(n) && n > max ? n : max;
        }, 0) + 1;
        actNumber = `ACT-${num.toString().padStart(3, '0')}`;
      }
      return tx.act.create({
      data: {
        actNumber,
        clientKey,
        actDate: new Date(actDate),
        actTime,
        actType,
        quantity: qty,
        source: srcLabel,
        purpose,

        status: 'accepted',
        productId: resolvedProductId,
        employeeId: employeeId || null,
        notes: notes || null,

        takenBy: who.code,
        employeeName: who.name,

        repairQty: initialRepair,
        analysisQty: initialAnalysis,
        defects: {
          create: [
            ...(initialRepair > 0 ? [{
              kind: 'repeated',
              state: 'in_repair',
              quantity: initialRepair,
              description: `Принят уже в ремонте (источник: ${srcLabel})`,
              reportedBy: who.code,
            }] : []),
            ...(initialAnalysis > 0 ? [{
              kind: 'analysis',
              state: 'on_analysis',
              quantity: initialAnalysis,
              description: `Принят уже на анализе у разработчика (источник: ${srcLabel})`,
              reportedBy: who.code,
            }] : []),
          ],
        },

        units: { create: serials.map(serial => ({ serial, acceptedBy: who.code, acceptedAt: new Date(), unitState: 'accepted' })) },
      },
      });
      }, { maxWait: 15000, timeout: 15000 });
    } catch (e) {
      if (errCode(e) === 'P2002' && clientKey) {
        const dup = await db.act.findUnique({ where: { clientKey } });
        if (dup) return NextResponse.json({ success: true, data: dup, message: `Акт ${dup.actNumber} создан` });
      }
      throw e;
    }

    await db.actionLog.create({
      data: {
        actionType: 'CREATE_ACT',
        entityType: 'ACT',
        entityId: act.id,
        entityNumber: actNumber,
        actId: act.id,
        description: `Приём продукции: акт ${actNumber}, ${act.quantity} шт.` +
          (serials.length > 0 ? `, отсканировано серийных номеров: ${serials.length}` : '') +
          (initialRepair > 0 ? `, из них уже в ремонте: ${initialRepair}` : '') +
          (initialAnalysis > 0 ? `, уже на анализе: ${initialAnalysis}` : ''),
        userId: who.code,
      },
    }).catch(() => {});

    return NextResponse.json({ success: true, data: act, message: `Акт ${actNumber} создан` });
  } catch (error) {
    console.error('POST error:', error);
    return NextResponse.json({ success: false, error: errMsg(error) }, { status: 500 });
  }
  })
}
