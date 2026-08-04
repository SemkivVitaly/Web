'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ACT_STATUSES, STATUS_LABELS } from '@/lib/statuses'
import type { Act, ActionLogEntry } from '@/lib/types'

const STAGE_COLOR: Record<string, string> = {
  accepted: 'bg-slate-500',
  input_control: 'bg-sky-500',
  in_progress: 'bg-blue-500',
  output_control: 'bg-violet-500',
  ready_to_ship: 'bg-amber-500',
  shipped: 'bg-emerald-500',
}

const isToday = (v?: string | null) => {
  if (!v) return false
  const d = new Date(v)
  const n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

function Clock() {
  const [t, setT] = useState('')
  useEffect(() => {
    const tick = () => setT(new Date().toLocaleTimeString('ru-RU'))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return <span className="tabular-nums font-mono">{t}</span>
}

interface Tile { label: string; value: string | number; tone?: 'ok' | 'warn' | 'bad'; sub?: string }

export default function MonitorPage() {
  const [acts, setActs] = useState<Act[]>([])
  const [logs, setLogs] = useState<ActionLogEntry[]>([])
  const [online, setOnline] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [wide, setWide] = useState(true)
  const [showEvents, setShowEvents] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)')
    const update = () => setWide(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (wide) { setShowEvents(false); return }
    const t = setInterval(() => setShowEvents(v => !v), 12000)
    return () => clearInterval(t)
  }, [wide])

  const load = useCallback(async () => {
    try {
      const [a, l] = await Promise.all([
        fetch('/api/acts').then(r => r.json()),
        fetch('/api/logs?limit=14').then(r => r.json()).catch(() => ({ data: [] })),
      ])
      if (a.success) setActs(a.data)
      const list = Array.isArray(l?.data) ? l.data : l?.data?.logs || []
      setLogs(list)
      setOnline(true)
      setUpdatedAt(new Date())
    } catch {
      setOnline(false)
    }
  }, [])

  useEffect(() => {
    load()
    timer.current = setInterval(load, 5000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [load])

  const totalQty = acts.reduce((s, a) => s + a.quantity, 0)
  const inWork = acts.filter(a => ['accepted', 'input_control', 'in_progress', 'output_control'].includes(a.status)).length
  const ready = acts.filter(a => a.status === 'ready_to_ship').length
  const repair = acts.reduce((s, a) => s + (a.repairQty || 0), 0)
  const analysis = acts.reduce((s, a) => s + (a.analysisQty || 0), 0)
  const overdue = acts.filter(a => a.plannedShipAt && a.status !== 'shipped' && new Date(a.plannedShipAt).getTime() < Date.now()).length
  const defectRate = totalQty ? (repair / totalQty) * 100 : 0

  const acceptedToday = acts.filter(a => isToday(a.actDate)).reduce((s, a) => s + a.quantity, 0)
  const shippedToday = acts.filter(a => isToday(a.actualShipAt)).reduce((s, a) => s + (a.shippedQty || a.quantity), 0)
  const shipped30 = acts
    .filter(a => a.actualShipAt && new Date(a.actualShipAt).getTime() >= Date.now() - 30 * 86400_000)
    .reduce((s, a) => s + (a.shippedQty || a.quantity), 0)

  const stageCounts = ACT_STATUSES.map(s => ({ status: s, count: acts.filter(a => a.status === s).length }))
  const maxStage = Math.max(1, ...stageCounts.map(s => s.count))

  const tiles: Tile[] = [
    { label: 'Принято сегодня', value: acceptedToday.toLocaleString('ru-RU'), sub: 'штук' },
    { label: 'Отгружено сегодня', value: shippedToday.toLocaleString('ru-RU'), tone: 'ok', sub: 'штук' },
    { label: 'Актов в работе', value: inWork },
    { label: 'К отгрузке', value: ready, tone: ready ? 'warn' : undefined },
    { label: 'В ремонте', value: repair.toLocaleString('ru-RU'), tone: repair ? 'warn' : undefined, sub: 'штук' },
    { label: 'На анализе', value: analysis.toLocaleString('ru-RU'), tone: analysis ? 'warn' : undefined, sub: 'штук' },
    { label: 'Просрочено', value: overdue, tone: overdue ? 'bad' : 'ok', sub: 'отгрузок' },
    { label: 'Процент брака', value: defectRate.toFixed(1) + '%', tone: defectRate > 5 ? 'bad' : defectRate > 2 ? 'warn' : 'ok' },
  ]

  const toneClass = (t?: Tile['tone']) =>
    t === 'bad' ? 'text-red-400' : t === 'warn' ? 'text-amber-400' : t === 'ok' ? 'text-emerald-400' : 'text-white'

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-6 lg:p-8 flex flex-col gap-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-4">
          <h1 className="text-[clamp(1.6rem,2.2vw,3.5rem)] font-bold tracking-tight">Живой монитор производства · УТК</h1>
          <span className="text-[clamp(10px,0.6vw,16px)] uppercase tracking-widest text-neutral-500">Только для локального использования</span>
        </div>
        <div className="flex items-center gap-5 text-[clamp(1rem,1.1vw,1.6rem)]">
          <span className={`flex items-center gap-2 ${online ? 'text-emerald-400' : 'text-red-400'}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
            {online ? 'на связи' : 'нет связи'}
          </span>
          <span className="text-neutral-400 text-[clamp(0.85rem,0.9vw,1.3rem)] tabular-nums">
            обновлено {updatedAt ? updatedAt.toLocaleTimeString('ru-RU') : '—'}
          </span>
          <span className="text-[clamp(1.6rem,2.2vw,3.5rem)] font-bold"><Clock /></span>
          <Link href="/" className="text-neutral-500 hover:text-neutral-300 underline text-sm">выход</Link>
        </div>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {tiles.map(t => (
          <div key={t.label} className="rounded-2xl bg-neutral-900 border border-neutral-800 px-6 py-5">
            <p className={`text-[clamp(2.5rem,4.2vw,7rem)] font-bold tabular-nums leading-none ${toneClass(t.tone)}`}>{t.value}</p>
            <p className="mt-3 text-neutral-400 text-[clamp(0.95rem,1.1vw,1.8rem)]">{t.label}{t.sub && <span className="text-neutral-600 text-[clamp(0.75rem,0.8vw,1.2rem)] ml-1.5">{t.sub}</span>}</p>
          </div>
        ))}
      </div>

      {!wide && (
        <div className="flex items-center justify-center gap-2 -my-2">
          <span className={`h-2 w-2 rounded-full ${!showEvents ? 'bg-neutral-300' : 'bg-neutral-700'}`} />
          <span className={`h-2 w-2 rounded-full ${showEvents ? 'bg-neutral-300' : 'bg-neutral-700'}`} />
          <span className="text-neutral-600 text-xs ml-1">{showEvents ? 'события' : 'поток'} · сменится сам</span>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 flex-1 min-h-0">
        <section className={`xl:col-span-2 rounded-2xl bg-neutral-900 border border-neutral-800 p-6 flex-col ${wide || !showEvents ? 'flex' : 'hidden'}`}>
          <h2 className="text-[clamp(1.1rem,1.3vw,2rem)] font-semibold text-neutral-300 mb-5">Поток по этапам техпроцесса</h2>
          <div className="flex flex-col gap-4 justify-center flex-1">
            {stageCounts.map(({ status, count }) => (
              <div key={status} className="flex items-center gap-4">
                <span className="w-[clamp(10rem,13vw,20rem)] shrink-0 text-[clamp(1rem,1.2vw,1.9rem)] text-neutral-300">{STATUS_LABELS[status]}</span>
                <div className="flex-1 h-[clamp(2rem,2.4vw,3.5rem)] rounded-lg bg-neutral-800 overflow-hidden">
                  <div className={`h-full ${STAGE_COLOR[status]} rounded-lg transition-all duration-500`}
                    style={{ width: `${Math.max(count ? 6 : 0, (count / maxStage) * 100)}%` }} />
                </div>
                <span className="w-[clamp(3rem,4vw,6rem)] text-right text-[clamp(1.4rem,1.8vw,3rem)] font-bold tabular-nums">{count}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={`rounded-2xl bg-neutral-900 border border-neutral-800 p-6 flex-col min-h-0 ${wide || showEvents ? 'flex' : 'hidden'}`}>
          <h2 className="text-[clamp(1.1rem,1.3vw,2rem)] font-semibold text-neutral-300 mb-4">Последние события</h2>
          <ul className="flex flex-col gap-2.5 overflow-hidden">
            {logs.length === 0 && <li className="text-neutral-600 text-lg">Событий пока нет</li>}
            {logs.map(l => (
              <li key={l.id} className="flex items-baseline gap-3 text-neutral-300">
                <span className="text-neutral-600 text-[clamp(0.8rem,0.85vw,1.25rem)] tabular-nums shrink-0 w-[clamp(3rem,3.5vw,5rem)] font-mono">
                  {new Date(l.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-[clamp(0.95rem,1.05vw,1.6rem)] leading-tight line-clamp-2">{l.description}</span>
              </li>
            ))}
          </ul>
          <div className="mt-auto pt-4 text-neutral-600 text-sm">
            Всего изделий в учёте: <b className="text-neutral-400 tabular-nums">{totalQty.toLocaleString('ru-RU')}</b>
            {' · '}за 30 дней отгружено <b className="text-neutral-400 tabular-nums">{shipped30.toLocaleString('ru-RU')}</b>
          </div>
        </section>
      </div>
    </div>
  )
}
