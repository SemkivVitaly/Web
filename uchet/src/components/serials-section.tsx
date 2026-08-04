'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { sendOrQueue } from '@/lib/offline-queue'
import { UNIT_STAGES, stageForActStatus } from '@/lib/unit-stages'

interface Unit {
  id: string
  serial: string
  acceptedBy?: string | null
  inputControlBy?: string | null
  testedBy?: string | null
  outputControlBy?: string | null
  unitState?: string | null
}

const fieldFor = (key: string): keyof Unit =>
  ({ accepted: 'acceptedBy', input_control: 'inputControlBy', in_progress: 'testedBy', output_control: 'outputControlBy' } as const)[key] as keyof Unit

export function SerialsSection({ actId, quantity, actStatus }: { actId: string; quantity: number; actStatus?: string }) {
  const [units, setUnits] = useState<Unit[]>([])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const stage = actStatus ? stageForActStatus(actStatus) : null

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/acts/${actId}/units`)
      const j = await r.json()
      if (j.success) setUnits(j.data)
    } catch {  }
  }, [actId])
  useEffect(() => { load() }, [load])

  const add = async () => {
    const batch = [...new Set(value.split(/[\s;,]+/).map(s => s.trim()).filter(Boolean))]
    if (batch.length === 0 || busy) return
    setBusy(true)
    try {
      const r = await sendOrQueue(`/api/acts/${actId}/units`, {
        method: 'POST', body: { serials: batch },
      }, batch.length === 1 ? `Серийный номер ${batch[0]}` : `Серийные номера (${batch.length})`)
      if (r.queued) {
        toast.info('Нет связи — серийные номера сохранены и уйдут автоматически')
        setValue('')
        return
      }
      if (r.json?.needLogin) { toast.error('Войдите в систему, чтобы вносить изменения'); return }
      if (!r.ok) throw new Error(r.json?.error || 'Ошибка')
      if (r.json?.data?.added === 0) toast.info(r.json?.message || 'Дубли пропущены')
      setValue('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  const remove = async (serial: string) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await sendOrQueue(`/api/acts/${actId}/units`, {
        method: 'DELETE', body: { serial },
      }, `Удаление серийного номера ${serial}`)
      if (r.queued) {
        toast.info('Нет связи — удаление сохранено и уйдёт автоматически')
        setUnits(u => u.filter(x => x.serial !== serial))
        return
      }
      if (r.json?.needLogin) { toast.error('Войдите в систему, чтобы вносить изменения'); return }
      if (!r.ok) throw new Error(r.json?.error || 'Ошибка')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally { setBusy(false) }
  }

  const sign = async (serials: string[] | 'all') => {
    if (!stage || busy) return
    setBusy(true)
    try {
      const body = serials === 'all' ? { all: true } : { serials }
      const res = await fetch(`/api/acts/${actId}/units/sign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) throw new Error(j?.error || 'Ошибка')
      toast.success(j?.message || 'Подписано')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally { setBusy(false) }
  }

  const signedField = stage ? fieldFor(stage.key) : null
  const unsignedForStage = signedField ? units.filter(u => !u[signedField]).length : 0

  return (
    <section className="rounded-lg border">
      <header className="border-b px-4 py-2.5 flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold">
          Серийные номера · прослеживаемость
          <span className="ml-2 font-normal text-muted-foreground tabular-nums">{units.length} из {quantity}</span>
        </h3>
        {units.length > 0 && units.length < quantity && (
          <span className="text-xs text-amber-600 dark:text-amber-400">отсканированы не все изделия</span>
        )}
        {units.length > quantity && (
          <span className="text-xs text-red-600 dark:text-red-400">серийных номеров больше, чем изделий — проверьте</span>
        )}
      </header>
      <div className="p-4 space-y-3">
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); add() }}>
          <Input
            ref={inputRef}
            className="h-8"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="Сканируйте QR акта (все серийники сразу) или QR изделия и нажмите Enter"
          />
          <Button type="submit" size="sm" disabled={busy || !value.trim()}>Добавить</Button>
        </form>

        {stage && units.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <span>Текущий этап акта — <b>{stage.label}</b>.</span>
            <span className="text-muted-foreground">Не подписано: {unsignedForStage}</span>
            <Button size="sm" className="h-7 ml-auto" disabled={busy || unsignedForStage === 0}
              onClick={() => sign('all')}>
              Подписать все ({units.length})
            </Button>
          </div>
        )}

        {units.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-separate border-spacing-0">
              <thead>
                <tr className="text-muted-foreground text-left">
                  <th className="py-1 pr-3 font-medium">Серийник</th>
                  {UNIT_STAGES.map(s => (
                    <th key={s.key} className="py-1 px-2 font-medium whitespace-nowrap">{s.label}</th>
                  ))}
                  <th className="py-1 pl-2"></th>
                </tr>
              </thead>
              <tbody>
                {units.map(u => (
                  <tr key={u.id} className="border-t">
                    <td className="py-1 pr-3 font-mono">{u.serial}</td>
                    {UNIT_STAGES.map(s => {
                      const by = u[fieldFor(s.key)] as string | null | undefined
                      const isCurrent = stage?.key === s.key
                      return (
                        <td key={s.key} className="py-1 px-2 whitespace-nowrap">
                          {by ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">✓ {by}</span>
                          ) : isCurrent ? (
                            <button
                              className="rounded border px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-40"
                              disabled={busy}
                              onClick={() => sign([u.serial])}
                            >подписать</button>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      )
                    })}
                    <td className="py-1 pl-2 text-right">
                      <button className="rounded-full px-1 hover:bg-muted text-muted-foreground"
                        title="Удалить серийный номер" disabled={busy}
                        onClick={() => remove(u.serial)}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Серийные номера пока не внесены. По серийному номеру акт находится поиском на цеховом экране.
          </p>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground pt-1">
          <a className="underline hover:text-foreground" target="_blank" href={`/print/route-card/${actId}`}>
            Маршрутная карта (прослеживаемость по изделиям)
          </a>
          <a className="underline hover:text-foreground" target="_blank" href={`/print/serial-qr/${actId}?mode=godex`}>
            Этикетки Godex по шаблону (текст + QR)
          </a>
          <a className="underline hover:text-foreground" target="_blank" href={`/print/serial-qr/${actId}`}>
            QR-ярлыки листом A4
          </a>
          <a className="underline hover:text-foreground" href={`/api/acts/${actId}/labels.ezpl`}>
            Скачать EZPL для Godex (сетевая печать)
          </a>
        </div>
      </div>
    </section>
  )
}
