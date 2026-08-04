'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { ACT_STATUSES, STATUS_LABELS, canTransition, nextStep } from '@/lib/statuses'
import type { Act, ActionLogEntry } from '@/lib/types'
import { DefectsSection, notifyActsChanged } from '@/components/defects-section'
import { SerialsSection } from '@/components/serials-section'
import { sendOrQueue } from '@/lib/offline-queue'

const FLOW: string[] = ['accepted', 'input_control', 'in_progress', 'output_control', 'ready_to_ship', 'shipped']

function StatusFlow({ status }: { status: string }) {
  const idx = FLOW.indexOf(status)
  return (
    <div className="flex items-center gap-1 flex-wrap" aria-label={`Статус: ${STATUS_LABELS[status] || status}`}>
      {FLOW.map((s, i) => (
        <div key={s} className="flex items-center gap-1" title={STATUS_LABELS[s]}>
          <div className={`h-1.5 w-8 rounded-full ${
            i < idx ? 'bg-primary/60' : i === idx ? 'bg-primary' : 'bg-muted'
          }`} />
        </div>
      ))}
      <span className="ml-2 text-xs text-muted-foreground">{STATUS_LABELS[status] || status}</span>
    </div>
  )
}

const fmtDT = (v?: string | null) =>
  v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

interface ActCardProps {
  act: Act | null
  productName?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ActCard({ act, productName, open, onOpenChange }: ActCardProps) {
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [history, setHistory] = useState<ActionLogEntry[]>([])
  const [myRole, setMyRole] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!open) { setConfirmDelete(false); return }
    fetch('/api/auth').then(r => r.json())
      .then(j => setMyRole(j?.data?.me?.role ?? null))
      .catch(() => setMyRole(null))
  }, [open])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (act) setStatus(act.status)
  }, [act?.id])

  const actId = act?.id
  const loadHistory = useCallback(async () => {
    if (!actId) return
    try {
      const res = await fetch(`/api/logs?actId=${actId}&limit=50`)
      const json = await res.json()
      const list = Array.isArray(json.data) ? json.data : json.data?.logs || []
      setHistory(list)
    } catch {  }
  }, [actId])

  useEffect(() => { if (open) loadHistory() }, [open, loadHistory])

  if (!act) return null

  const applyStatus = async () => {
    if (saving || status === act.status) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = { status, expectedFrom: act.status }
      const r = await sendOrQueue(`/api/acts/${act.id}`, { method: 'PUT', body },
        `Статус «${STATUS_LABELS[status] || status}» для акта ${act.actNumber}`)
      if (r.queued) {
        toast.info('Нет связи — изменение сохранено на этом ПК и уйдёт автоматически')
        return
      }
      if (r.json?.needLogin) {
        toast.error('Войдите в систему (кнопка «Войти» в шапке) — подпись ставится автоматически')
        return
      }
      if (!r.ok) throw new Error(r.json?.error || 'Ошибка')
      toast.success(`${STATUS_LABELS[status] || status}: акт ${act.actNumber}`)
      notifyActsChanged()
      loadHistory()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setSaving(false)
    }
  }

  const facts: [string, string][] = [
    ['Принят', `${new Date(act.actDate).toLocaleDateString('ru-RU')} ${act.actTime || ''}`],
    ['Источник', (act as Act & { source?: string }).source || 'Склад'],
    ['Назначение', (act as Act & { purpose?: string }).purpose || 'Тестирование'],
    ['Принял (с источника)', act.takenBy || '—'],
    ['Выходной контроль', act.outputControlBy || '—'],
    ['К отгрузке (план)', fmtDT(act.plannedShipAt)],
    ['Отгружен (факт)', fmtDT(act.actualShipAt)],
  ]

  const statusHistory = history.filter(h => h.actionType === 'CHANGE_STATUS' || h.actionType === 'CREATE_ACT')

  const deleteAct = async () => {
    if (saving) return
    setSaving(true)
    try {
      const r = await fetch(`/api/acts/${act.id}`, { method: 'DELETE' })
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || 'Ошибка')
      toast.success(j?.message || `Акт ${act.actNumber} удалён`)
      onOpenChange(false)
      notifyActsChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setSaving(false)
      setConfirmDelete(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(96vw,1100px)] w-[96vw] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-3 flex-wrap">
            <span>{productName || act.actType} · акт {act.actNumber}</span>
            <span className="text-sm font-normal text-muted-foreground tabular-nums">{act.quantity} штук</span>
          </DialogTitle>
        </DialogHeader>

        <StatusFlow status={act.status} />

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm mt-1">
          {facts.map(([k, v]) => (
            <div key={k}>
              <p className="text-xs text-muted-foreground">{k}</p>
              <p className="tabular-nums">{v}</p>
            </div>
          ))}
        </div>
        <div className="flex gap-4 text-sm flex-wrap">
          {(act.repairQty || 0) > 0 && <span className="text-amber-600 dark:text-amber-400">В ремонте: {act.repairQty}</span>}
          {(act.analysisQty || 0) > 0 && <span className="text-blue-600 dark:text-blue-400">На анализе: {act.analysisQty}</span>}
          {(act.shippedQty || 0) > 0 && <span className="text-emerald-600 dark:text-emerald-400">Отгружено: {act.shippedQty}</span>}
        </div>
        {act.notes && <p className="text-sm text-muted-foreground border-l-2 pl-3">{act.notes}</p>}

        <section className="rounded-lg border">
          <header className="border-b px-4 py-2.5">
            <h3 className="text-sm font-semibold">Смена статуса</h3>
          </header>
          <div className="p-4 flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Новый статус</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ACT_STATUSES.map(s => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s]}
                      {s !== act.status && !canTransition(act.status, s) ? ' — не по техпроцессу' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" onClick={applyStatus} disabled={saving || status === act.status}>
              {saving ? 'Сохранение…' : 'Применить'}
            </Button>
            {nextStep(act.status) && (
              <Button size="sm" variant="secondary" disabled={saving}
                onClick={() => { setStatus(nextStep(act.status)!) }}>
                Следующий шаг: {STATUS_LABELS[nextStep(act.status)!]}
              </Button>
            )}
            <p className="text-xs text-muted-foreground basis-full">
              Подпись исполнителя ставится автоматически по вашему входу.
              Переход «не по техпроцессу» доступен старшему тестировщику и начальнику.
            </p>
          </div>
        </section>

        <DefectsSection actId={act.id} ncActNumber={act.ncActNumber} productId={act.productId} />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Печатные формы:</span>
          <a className="underline hover:text-foreground" target="_blank" href={`/print/labels/${act.id}`}>
            Ярлыки несоответствия (3 на лист)
          </a>
          <a className="underline hover:text-foreground" target="_blank" href={`/print/nc-act/${act.id}`}>
            Акт несоответствия
          </a>
          <a className="underline hover:text-foreground" target="_blank" href={`/print/withdrawal/${act.id}`}>
            Акт изъятия (изолятор)
          </a>
        </div>

        <SerialsSection actId={act.id} quantity={act.quantity} actStatus={act.status} />

        {myRole === 'boss' && (
          <div className="flex items-center justify-end gap-2 text-sm">
            {confirmDelete ? (
              <>
                <span className="text-muted-foreground">
                  Акт, его серийники и ярлыки будут удалены из системы (след останется в «Действиях»).
                </span>
                <Button size="sm" variant="destructive" disabled={saving} onClick={deleteAct}>
                  {saving ? 'Удаление…' : 'Да, удалить акт'}
                </Button>
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => setConfirmDelete(false)}>
                  Отмена
                </Button>
              </>
            ) : (
              <button
                className="text-xs text-muted-foreground underline hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
              >
                Удалить акт из системы (начальник)
              </button>
            )}
          </div>
        )}

        <section className="rounded-lg border">
          <header className="border-b px-4 py-2.5">
            <h3 className="text-sm font-semibold">История: кто и когда</h3>
          </header>
          <div className="p-2">
            {statusHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-2">
                История появится после первой смены статуса
              </p>
            ) : (
              <ul className="divide-y">
                {statusHistory.map(h => (
                  <li key={h.id} className="px-2 py-1.5 text-sm flex items-baseline gap-3">
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0 w-24">
                      {new Date(h.createdAt).toLocaleString('ru-RU', {
                        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                    <span className="min-w-0">
                      {h.description}
                      {h.userId && <Badge variant="secondary" className="ml-2">{h.userId}</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}
