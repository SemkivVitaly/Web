'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { STATUS_LABELS, DEFECT_KINDS, nextStep, ACT_STATUSES } from '@/lib/statuses'
import { ROLE_LABELS, type Role, atLeast } from '@/lib/roles'
import { sendOrQueue, flushQueue, pendingCount } from '@/lib/offline-queue'
import { stageForActStatus } from '@/lib/unit-stages'

interface ShopUnit {
  serial: string
  acceptedBy?: string | null
  inputControlBy?: string | null
  testedBy?: string | null
  outputControlBy?: string | null
}
const unitFieldFor = (key: string): keyof ShopUnit =>
  ({ accepted: 'acceptedBy', input_control: 'inputControlBy', in_progress: 'testedBy', output_control: 'outputControlBy' } as const)[key] as keyof ShopUnit

interface ShopAct {
  id: string
  actNumber: string
  actType: string
  quantity: number
  status: string
  repairQty?: number
  analysisQty?: number
  notes?: string | null
  product?: { id?: string; name: string } | null
}
interface Me { code: string; name: string; role: string }

const STATUS_COLORS: Record<string, string> = {
  accepted: 'bg-slate-500',
  input_control: 'bg-sky-600',
  in_progress: 'bg-blue-600',
  output_control: 'bg-violet-600',
  ready_to_ship: 'bg-amber-500',
  shipped: 'bg-emerald-600',
}

export default function ShopPage() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [act, setAct] = useState<ShopAct | null>(null)
  const [candidates, setCandidates] = useState<ShopAct[]>([])
  const [activeActs, setActiveActs] = useState<ShopAct[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [defectMode, setDefectMode] = useState(false)
  const [defect, setDefect] = useState({ kind: 'new', quantity: '1', labelNumber: '', serial: '', designator: '', description: '' })
  const [catalog, setCatalog] = useState<{ id: string; text: string }[]>([])
  const [pending, setPending] = useState(0)
  const [online, setOnline] = useState(true)
  const [units, setUnits] = useState<ShopUnit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const loadUnits = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/acts/${id}/units`)
      const j = await r.json()
      if (j.success) setUnits(j.data)
    } catch {  }
  }, [])

  const loadActive = useCallback(async () => {
    try {
      const r = await fetch('/api/acts?active=1')
      const j = await r.json()
      if (j.success) {
        setActiveActs(j.data)
        setOnline(true)
      }
    } catch { setOnline(false) }
  }, [])

  useEffect(() => {
    fetch('/api/auth')
      .then(r => r.json())
      .then(j => setMe(j.data?.me ?? null))
      .catch(() => setMe(null))
    loadActive()
    const sync = () => setPending(pendingCount())
    sync()
    window.addEventListener('queue:changed', sync)
    const t = setInterval(() => {
      flushQueue().then(({ sent, dropped }) => {
        sync()
        if (sent > 0) toast.success(`Отправлено отложенных изменений: ${sent}`)
        for (const label of dropped) toast.error(`Сервер отклонил отложенное изменение: ${label}`)
      })
      loadActive()
    }, 20000)
    return () => { window.removeEventListener('queue:changed', sync); clearInterval(t) }
  }, [loadActive])

  const refreshAct = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/acts/${id}`)
      const j = await r.json()
      if (j.success) setAct(prev => (prev && prev.id === id ? { ...prev, ...j.data } : prev))
    } catch {  }
    loadUnits(id)
  }, [loadUnits])

  useEffect(() => {
    if (act?.id) loadUnits(act.id)
    else setUnits([])
  }, [act?.id, loadUnits])

  const signStage = async (serials: string[] | 'all') => {
    if (!act || busy) return
    setBusy(true)
    try {
      const body = serials === 'all' ? { all: true } : { serials }
      const r = await sendOrQueue(`/api/acts/${act.id}/units/sign`, { method: 'POST', body },
        `Отметка изделий (${act.actNumber})`)
      if (r.queued) { toast.info('Нет связи — отметка сохранена и уйдёт автоматически'); return }
      if (r.json?.needLogin) { toast.error('Вход истёк — войдите заново'); setMe(null); return }
      if (!r.ok) throw new Error(r.json?.error || 'Ошибка')
      toast.success(r.json?.message || 'Отмечено')
      await loadUnits(act.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally { setBusy(false) }
  }

  const search = async (raw: string) => {
    const num = raw.trim()
    if (!num) return
    setBusy(true)
    try {
      const r = await fetch(`/api/acts?number=${encodeURIComponent(num)}`)
      const j = await r.json()
      const found: ShopAct[] = j.success ? j.data : []
      if (found.length === 0) {
        toast.error(`Акт «${num}» не найден`)
      } else if (found.length === 1) {
        setAct(found[0]); setCandidates([]); setQuery('')
      } else {
        setCandidates(found); setQuery('')
      }
    } catch {

      const found = activeActs.filter(a => a.actNumber === num)
      if (found.length === 1) { setAct(found[0]); setQuery('') }
      else if (found.length > 1) { setCandidates(found); setQuery('') }
      else toast.error('Нет связи с сервером — акт не найден в локальном списке')
    } finally { setBusy(false) }
  }

  const fireEvent = async (type: 'next' | 'retest', label: string) => {
    if (!act || busy) return
    setBusy(true)
    try {
      const r = await sendOrQueue(`/api/acts/${act.id}/events`, {
        method: 'POST', body: { type, expectedFrom: act.status },
      }, `${label} — акт ${act.actNumber}`)
      if (r.queued) {
        toast.info('Нет связи — действие сохранено и уйдёт автоматически')

        const target = type === 'retest' ? 'in_progress' : nextStep(act.status)
        if (target) setAct({ ...act, status: target })
        return
      }
      if (r.json?.needLogin) { toast.error('Вход истёк — войдите заново'); setMe(null); return }
      if (!r.ok) throw new Error(r.json?.error || 'Ошибка')
      toast.success(`Акт ${act.actNumber}: ${r.json?.message || 'готово'}`)
      await refreshAct(act.id)
      loadActive()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally { setBusy(false) }
  }

  const saveDefect = async () => {
    if (!act || busy) return
    const qty = parseInt(defect.quantity) || 1
    setBusy(true)
    try {
      const r = await sendOrQueue('/api/defects', {
        method: 'POST',
        body: {
          actId: act.id, kind: defect.kind, quantity: qty,
          labelNumber: defect.labelNumber || null,
          serial: defect.serial.trim() || null,
          designator: defect.designator.trim() || null,
          description: defect.description || null,
        },
      }, `Ярлык несоответствия — акт ${act.actNumber}`)
      if (r.queued) {
        toast.info('Нет связи — ярлык сохранён и уйдёт автоматически')
        setDefectMode(false)
        setDefect({ kind: 'new', quantity: '1', labelNumber: '', serial: '', designator: '', description: '' })
        return
      }
      if (r.json?.needLogin) { toast.error('Вход истёк — войдите заново'); setMe(null); return }
      if (!r.ok) throw new Error(r.json?.error || 'Ошибка')
      toast.success(r.json?.message || 'Готово')
      setDefectMode(false)
      setDefect({ kind: 'new', quantity: '1', labelNumber: '', serial: '', designator: '', description: '' })
      await refreshAct(act.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally { setBusy(false) }
  }

  if (me === undefined) {
    return <Shell><p className="text-center text-xl text-muted-foreground py-24">Загрузка…</p></Shell>
  }

  if (me === null) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-6 py-16">
          <p className="text-2xl text-center">Для работы на цеховом экране нужно войти</p>
          <Link href="/login?next=/shop"
            className="h-20 px-16 rounded-2xl bg-primary text-primary-foreground text-3xl font-bold flex items-center active:scale-95 transition-transform">
            Войти
          </Link>
          <Link href="/" className="text-muted-foreground underline text-lg">Полная версия сайта</Link>
        </div>
      </Shell>
    )
  }

  if (candidates.length > 0) {
    return (
      <Shell me={me} pending={pending} online={online}>
        <p className="text-xl mb-4">Найдено несколько актов с этим номером — выберите:</p>
        <div className="grid gap-3">
          {candidates.map(a => (
            <button key={a.id} onClick={() => { setAct(a); setCandidates([]) }}
              className="rounded-2xl border-2 bg-card p-5 text-left active:scale-[0.99] transition-transform">
              <span className="text-2xl font-bold">Акт {a.actNumber}</span>
              <span className="ml-4 text-xl">{a.product?.name || a.actType}</span>
              <span className="ml-4 text-xl text-muted-foreground">{a.quantity} штук</span>
              <span className={`ml-4 inline-block px-3 py-1 rounded-full text-white text-base ${STATUS_COLORS[a.status] || 'bg-slate-400'}`}>
                {STATUS_LABELS[a.status] || a.status}
              </span>
            </button>
          ))}
        </div>
        <BackButton onClick={() => setCandidates([])} />
      </Shell>
    )
  }

  if (act) {
    const next = nextStep(act.status)
    const canRetest = act.status === 'output_control' || act.status === 'ready_to_ship'
    const stage = stageForActStatus(act.status)
    const stageField = stage ? unitFieldFor(stage.key) : null
    const signedCount = stageField ? units.filter(u => u[stageField]).length : 0
    const hasUnits = units.length > 0
    const stageComplete = !stage || !hasUnits || signedCount >= units.length
    const canSignStage = Boolean(stage && me && atLeast(me.role, stage.minRole))
    const nextBlocked = Boolean(next && stage && hasUnits && !stageComplete)
    return (
      <Shell me={me} pending={pending} online={online}>
        <div className="rounded-2xl border-2 bg-card p-6 mb-5">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h2 className="text-3xl font-bold">{act.product?.name || act.actType} · акт {act.actNumber}</h2>
            <span className="text-2xl text-muted-foreground tabular-nums">{act.quantity} штук</span>
          </div>
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            {ACT_STATUSES.map((s, i) => (
              <span key={s}
                className={`px-4 py-2 rounded-full text-lg ${
                  s === act.status
                    ? `${STATUS_COLORS[s]} text-white font-semibold`
                    : ACT_STATUSES.indexOf(act.status as typeof s) > i
                      ? 'bg-muted text-muted-foreground line-through'
                      : 'bg-muted text-muted-foreground'
                }`}>
                {STATUS_LABELS[s]}
              </span>
            ))}
          </div>
          {((act.repairQty || 0) > 0 || (act.analysisQty || 0) > 0) && (
            <p className="mt-3 text-lg">
              {(act.repairQty || 0) > 0 && <span className="text-amber-600 dark:text-amber-400 mr-5">В ремонте: {act.repairQty}</span>}
              {(act.analysisQty || 0) > 0 && <span className="text-blue-600 dark:text-blue-400">На анализе: {act.analysisQty}</span>}
            </p>
          )}
        </div>

        {stage && hasUnits && (
          <div className="rounded-2xl border-2 bg-card p-5 mb-5">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
              <h3 className="text-2xl font-bold">
                {stage.label} по изделиям
                <span className={`ml-3 text-xl tabular-nums ${stageComplete ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                  {signedCount} / {units.length}
                </span>
              </h3>
              {canSignStage && !stageComplete && (
                <button disabled={busy} onClick={() => signStage('all')}
                  className="h-14 px-6 rounded-2xl bg-primary text-primary-foreground text-xl font-bold active:scale-[0.98] transition-transform disabled:opacity-50">
                  Отметить все
                </button>
              )}
            </div>
            {act.status === 'in_progress' && (
              <p className="text-base text-muted-foreground mb-3">
                Функциональный тест: запустите Wi-Fi-инструмент на ПК, затем отметьте прошедшие изделия ниже.
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {units.map(u => {
                const done = stageField ? u[stageField] : null
                return (
                  <div key={u.serial}
                    className={`flex items-center justify-between gap-2 rounded-xl border-2 px-4 py-3 ${done ? 'border-emerald-500/50 bg-emerald-500/5' : 'bg-background'}`}>
                    <span className="font-mono text-xl">{u.serial}</span>
                    {done ? (
                      <span className="text-emerald-600 dark:text-emerald-400 text-lg font-semibold whitespace-nowrap">✓ {String(done)}</span>
                    ) : canSignStage ? (
                      <button disabled={busy} onClick={() => signStage([u.serial])}
                        className="h-11 px-5 rounded-xl border-2 text-lg font-semibold active:scale-95 transition-transform disabled:opacity-50">
                        Отметить
                      </button>
                    ) : (
                      <span className="text-muted-foreground">ждёт</span>
                    )}
                  </div>
                )
              })}
            </div>
            {!stageComplete && (
              <p className="text-base text-amber-600 dark:text-amber-400 mt-3">
                Пока не отмечены все изделия, акт не перейдёт на следующий этап.
              </p>
            )}
          </div>
        )}

        {!defectMode ? (
          <div className="grid gap-4">
            {next ? (
              <button disabled={busy || nextBlocked} onClick={() => fireEvent('next', `Шаг «${STATUS_LABELS[next]}»`)}
                className="h-24 rounded-2xl bg-primary text-primary-foreground text-3xl font-bold active:scale-[0.98] transition-transform disabled:opacity-50">
                {busy ? 'Сохранение…'
                  : nextBlocked ? <>Сначала отметьте все изделия ({signedCount}/{units.length})</>
                  : <>Следующий шаг: {STATUS_LABELS[next]}</>}
              </button>
            ) : (
              <p className="text-2xl text-center text-emerald-600 dark:text-emerald-400 py-6">
                Акт отгружен — техпроцесс завершён
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button disabled={busy} onClick={() => {
                setDefectMode(true)
                fetch(`/api/defect-catalog${act.product?.id ? `?productId=${act.product.id}` : ''}`)
                  .then(r => r.json()).then(j => { if (j.success) setCatalog(j.data) }).catch(() => {})
              }}
                className="h-20 rounded-2xl border-2 border-amber-500 text-amber-600 dark:text-amber-400 text-2xl font-semibold active:scale-[0.98] transition-transform disabled:opacity-50">
                Ярлык несоответствия
              </button>
              {canRetest && (
                <button disabled={busy} onClick={() => fireEvent('retest', 'Возврат на перетест')}
                  className="h-20 rounded-2xl border-2 text-2xl font-semibold active:scale-[0.98] transition-transform disabled:opacity-50">
                  Вернуть в работу (перетест)
                </button>
              )}
            </div>
            <BackButton onClick={() => { setAct(null); setDefectMode(false); setTimeout(() => inputRef.current?.focus(), 50) }} label="← Другой акт" />
          </div>
        ) : (
          <div className="rounded-2xl border-2 bg-card p-6 grid gap-5">
            <h3 className="text-2xl font-bold">Ярлык несоответствия — акт {act.actNumber}</h3>
            <div>
              <p className="text-lg text-muted-foreground mb-2">Тип дефекта</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {Object.entries(DEFECT_KINDS).map(([k, label]) => (
                  <button key={k} onClick={() => setDefect(d => ({ ...d, kind: k }))}
                    className={`h-16 rounded-xl border-2 text-xl font-semibold transition-colors ${
                      defect.kind === k ? 'bg-primary text-primary-foreground border-primary' : 'bg-card'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-lg text-muted-foreground mb-2">Номер ярлыка</p>
                <input value={defect.labelNumber}
                  onChange={e => setDefect(d => ({ ...d, labelNumber: e.target.value }))}
                  className="h-16 w-full rounded-xl border-2 bg-background px-4 text-2xl" />
              </div>
              <div>
                <p className="text-lg text-muted-foreground mb-2">Количество</p>
                <input value={defect.quantity} inputMode="numeric"
                  onChange={e => setDefect(d => ({ ...d, quantity: e.target.value.replace(/\D/g, '') }))}
                  className="h-16 w-full rounded-xl border-2 bg-background px-4 text-2xl tabular-nums" />
              </div>
            </div>
            <div>
              <p className="text-lg text-muted-foreground mb-2">Серийный номер изделия (скан, необязательно)</p>
              <input value={defect.serial}
                onChange={e => setDefect(d => ({ ...d, serial: e.target.value }))}
                className="h-16 w-full rounded-xl border-2 bg-background px-4 text-2xl font-mono" />
            </div>
            <div>
              <p className="text-lg text-muted-foreground mb-2">Описание (подсказки — из каталога типовых дефектов)</p>
              <input value={defect.description} list="shop-defect-catalog"
                onChange={e => setDefect(d => ({ ...d, description: e.target.value }))}
                className="h-16 w-full rounded-xl border-2 bg-background px-4 text-xl" />
              <datalist id="shop-defect-catalog">
                {catalog.map(c => <option key={c.id} value={c.text} />)}
              </datalist>
            </div>
            <div>
              <p className="text-lg text-muted-foreground mb-2">Десигнатор (позиция на плате, необязательно)</p>
              <input value={defect.designator}
                onChange={e => setDefect(d => ({ ...d, designator: e.target.value }))}
                className="h-16 w-full rounded-xl border-2 bg-background px-4 text-2xl font-mono" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <button disabled={busy} onClick={saveDefect}
                className="h-20 rounded-2xl bg-primary text-primary-foreground text-2xl font-bold active:scale-[0.98] transition-transform disabled:opacity-50">
                {busy ? 'Сохранение…' : 'Зафиксировать'}
              </button>
              <button disabled={busy} onClick={() => setDefectMode(false)}
                className="h-20 rounded-2xl border-2 text-2xl font-semibold active:scale-[0.98] transition-transform">
                Отмена
              </button>
            </div>
          </div>
        )}
      </Shell>
    )
  }

  return (
    <Shell me={me} pending={pending} online={online}>
      <form className="flex gap-3 mb-6"
        onSubmit={e => { e.preventDefault(); search(query) }}>
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Номер акта, штрих-код или серийный номер"
          className="h-20 flex-1 rounded-2xl border-2 bg-card px-6 text-3xl"
        />
        <button type="submit" disabled={busy || !query.trim()}
          className="h-20 px-10 rounded-2xl bg-primary text-primary-foreground text-2xl font-bold disabled:opacity-40 active:scale-[0.98] transition-transform">
          Найти
        </button>
      </form>

      <p className="text-lg text-muted-foreground mb-3">Акты в работе (не отгруженные) — нажмите, чтобы открыть:</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {activeActs.map(a => (
          <button key={a.id} onClick={() => setAct(a)}
            className="rounded-2xl border-2 bg-card p-4 text-left active:scale-[0.99] transition-transform min-h-[88px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-bold">Акт {a.actNumber}</span>
              <span className={`px-3 py-1 rounded-full text-white text-sm ${STATUS_COLORS[a.status] || 'bg-slate-400'}`}>
                {STATUS_LABELS[a.status] || a.status}
              </span>
            </div>
            <div className="text-lg mt-1">{a.product?.name || a.actType} · {a.quantity} штук</div>
          </button>
        ))}
        {activeActs.length === 0 && (
          <p className="text-muted-foreground text-lg col-span-2">
            {online ? 'Все акты отгружены.' : 'Нет связи с сервером — список пуст.'}
          </p>
        )}
      </div>
    </Shell>
  )
}

function Shell({ children, me, pending = 0, online = true }: {
  children: React.ReactNode
  me?: Me | null
  pending?: number
  online?: boolean
}) {
  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-card px-5 py-3 flex items-center justify-between gap-3 flex-wrap sticky top-0 z-10">
        <h1 className="text-xl font-bold">
          Цеховой экран
          <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground font-normal align-middle">Только для локального использования</span>
        </h1>
        <div className="flex items-center gap-4 text-lg">
          {!online && <span className="text-amber-600 dark:text-amber-400 font-semibold">нет связи</span>}
          {pending > 0 && <span className="text-amber-600 dark:text-amber-400">в очереди: {pending}</span>}
          {me && (
            <span>
              <span className="font-bold">{me.code}</span>
              <span className="text-muted-foreground ml-2">{ROLE_LABELS[me.role as Role] || me.role}</span>
            </span>
          )}
          <Link href="/" className="text-muted-foreground underline">Полная версия</Link>
        </div>
      </header>
      <main className="max-w-4xl mx-auto p-5">{children}</main>
    </div>
  )
}

function BackButton({ onClick, label = '← Назад' }: { onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick}
      className="mt-5 h-16 px-8 rounded-2xl border-2 text-xl font-semibold active:scale-[0.98] transition-transform">
      {label}
    </button>
  )
}
