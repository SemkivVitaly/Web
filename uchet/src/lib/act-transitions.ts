import { db } from '@/lib/db'
import { ACT_STATUSES, STATUS_LABELS, canTransition } from '@/lib/statuses'
import { atLeast, type Session } from '@/lib/auth'
import { stageForActStatus } from '@/lib/unit-stages'

const FLOW: string[] = ['accepted', 'input_control', 'in_progress', 'output_control', 'ready_to_ship', 'shipped']
const isForward = (from: string, to: string) => FLOW.indexOf(to) > FLOW.indexOf(from)

export interface TransitionResult {
  ok: boolean
  error?: string
  status?: number
  act?: unknown
}

export async function applyStatusChange(
  actId: string,
  to: string,
  who: Session,
  comment?: string,
  expectedFrom?: string,
): Promise<TransitionResult> {
  if (!(ACT_STATUSES as readonly string[]).includes(to)) {
    return { ok: false, error: `Неизвестный статус «${to}»`, status: 400 }
  }
  const act = await db.act.findUnique({ where: { id: actId } })
  if (!act) return { ok: false, error: 'Акт не найден', status: 404 }
  if (expectedFrom && act.status !== expectedFrom) {
    return { ok: false, error: 'Статус акта уже изменился — обновите страницу', status: 409 }
  }
  if (act.status === to) return { ok: false, error: 'Акт уже в этом статусе', status: 400 }

  const allowed = canTransition(act.status, to)
  const override = !allowed && atLeast(who.role, 'senior')
  if (!allowed && !override) {
    return {
      ok: false,
      status: 400,
      error: `Переход «${STATUS_LABELS[act.status] || act.status}» → «${STATUS_LABELS[to] || to}» не по техпроцессу. Обход может выполнить старший тестировщик или начальник.`,
    }
  }

  if (to === 'shipped' && !atLeast(who.role, 'senior')) {
    return {
      ok: false,
      status: 403,
      error: 'Отгрузку выполняет старший тестировщик или начальник.',
    }
  }

  // Гейт прослеживаемости: уйти ВПЕРЁД с этапа можно только когда каждый
  // серийник этого этапа подписан (кто смотрел/сделал). Обход техпроцесса
  // (старший/начальник) гейт снимает — на случай нештатных ситуаций.
  const leaving = stageForActStatus(act.status)
  if (leaving && isForward(act.status, to) && !override) {
    const total = await db.unit.count({ where: { actId } })
    if (total > 0) {
      const done = await db.unit.count({ where: { actId, [leaving.byField]: { not: null } } })
      if (done < total) {
        return {
          ok: false,
          status: 400,
          error: `Этап «${leaving.label}» не завершён: подписано ${done} из ${total} изделий. ` +
            `Отметьте оставшиеся серийники, иначе акт дальше не пойдёт.`,
        }
      }
    }
  }

  const data: Record<string, unknown> = { status: to }
  if (to === 'output_control') data.outputControlBy = who.code
  if (to === 'ready_to_ship' && !act.plannedShipAt) data.plannedShipAt = new Date()
  if (to === 'shipped' && !act.actualShipAt) data.actualShipAt = new Date()

  const guardStatus = expectedFrom ?? act.status
  const res = await db.act.updateMany({ where: { id: actId, status: guardStatus }, data })
  if (res.count === 0) {
    return { ok: false, error: 'Статус акта уже изменился — обновите страницу', status: 409 }
  }
  const updated = await db.act.findUnique({ where: { id: actId } })

  await db.actionLog.create({
    data: {
      actionType: 'CHANGE_STATUS',
      entityType: 'ACT',
      entityId: actId,
      entityNumber: act.actNumber,
      actId,
      description:
        `Акт ${act.actNumber}: ${STATUS_LABELS[act.status] || act.status} → ${STATUS_LABELS[to] || to}` +
        (override ? ' (обход техпроцесса)' : '') +
        (comment ? ` — ${comment}` : ''),
      changes: JSON.stringify({ from: act.status, to, override }),
      userId: who.code,
    },
  }).catch(() => {})

  return { ok: true, act: updated }
}
