'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid,
  Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { STATUS_LABELS, ACT_STATUSES, DEFECT_KINDS } from '@/lib/statuses'
import type { Act } from '@/lib/types'

const LIGHT = { s1: '#2a78d6', s2: '#1baf7a', s3: '#eb6834', grid: '#e4e4e7', text: '#71717a' }
const DARK = { s1: '#3987e5', s2: '#199e70', s3: '#d95926', grid: '#27272a', text: '#a1a1aa' }

const EVENTS: [string, string][] = [
  ['accepted', 'Приёмка'],
  ['input_control', 'Входной контроль'],
  ['in_progress', 'Взятие в работу'],
  ['output_control', 'Выходной контроль'],
  ['ready_to_ship', 'К отгрузке'],
  ['shipped', 'Отгрузка'],
]

const FLOW_ORDER = ['accepted', 'input_control', 'in_progress', 'output_control', 'ready_to_ship', 'shipped']

const PERIODS = [
  { value: '7', label: '7 дней' },
  { value: '30', label: '30 дней' },
  { value: '90', label: '90 дней' },
  { value: 'all', label: 'Всё время' },
  { value: 'custom', label: 'Свой период' },
] as const

function Kpi({ label, value, unit, delta, goodWhenDown }: {
  label: string; value: string; unit?: string; delta?: number | null; goodWhenDown?: boolean
}) {
  const up = (delta ?? 0) > 0
  const good = delta != null && delta !== 0 && (goodWhenDown ? !up : up)
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold tabular-nums mt-0.5">
        {value}{unit && <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>}
      </p>
      {delta != null && Number.isFinite(delta) && (
        <p className={`text-xs tabular-nums mt-0.5 ${
          delta === 0 ? 'text-muted-foreground'
            : good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
        }`}>
          {delta === 0 ? 'как в прошлом периоде' : `${up ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)}% к прошлому периоду`}
        </p>
      )}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card">
      <header className="border-b px-4 py-2.5">
        <h3 className="text-sm font-semibold">{title}</h3>
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

export function AnalyticsPanel({ acts }: { acts: Act[] }) {
  const { resolvedTheme } = useTheme()
  const C = resolvedTheme === 'dark' ? DARK : LIGHT
  const [period, setPeriod] = useState<string>('30')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [product, setProduct] = useState<string>('all')
  const [source, setSource] = useState<string>('all')
  const [event, setEvent] = useState<string>('accepted')
  const [defectRows, setDefectRows] = useState<{ kind: string; quantity: number; createdAt: string; act?: { actType?: string } }[]>([])

  useEffect(() => {
    fetch('/api/defects').then(r => r.json())
      .then(j => { if (j.success) setDefectRows(j.data) }).catch(() => {})
  }, [])

  const range = useMemo((): { start: number; end: number } | null => {
    if (period === 'all') return null
    if (period === 'custom') {
      if (!from && !to) return null
      return {
        start: from ? new Date(from + 'T00:00:00').getTime() : 0,
        end: to ? new Date(to + 'T23:59:59').getTime() : Date.now() + 86400_000,
      }
    }
    const days = parseInt(period)
    return { start: Date.now() - days * 86400_000, end: Date.now() }
  }, [period, from, to])
  const inRange = (d: Date | null, r: { start: number; end: number } | null) =>
    d !== null && (r === null || (d.getTime() >= r.start && d.getTime() <= r.end))

  const eventDate = (a: Act, ev: string): Date | null => {
    const iso = a.statusDates?.[ev]
    if (iso) return new Date(iso)
    if (ev === 'accepted') return new Date(a.actDate)
    if (ev === 'shipped') return a.actualShipAt ? new Date(a.actualShipAt) : null
    if (ev === 'ready_to_ship') return a.plannedShipAt ? new Date(a.plannedShipAt) : null
    return null
  }

  const productNames = useMemo(
    () => [...new Set(acts.map(a => a.product?.name || a.actType))].sort((x, y) => x.localeCompare(y, 'ru')),
    [acts],
  )
  const sourceNames = useMemo(
    () => [...new Set(acts.map(a => (a as Act & { source?: string }).source || 'Склад'))].sort((x, y) => x.localeCompare(y, 'ru')),
    [acts],
  )

  const productFiltered = useMemo(() => {
    let list = product === 'all' ? acts : acts.filter(a => (a.product?.name || a.actType) === product)
    if (source !== 'all') {
      list = list.filter(a => ((a as Act & { source?: string }).source || 'Склад') === source)
    }
    return list
  }, [acts, product, source])
  const filtered = useMemo(
    () => productFiltered.filter(a => inRange(eventDate(a, event), range)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [productFiltered, range, event],
  )

  const kpis = useMemo(() => {
    const calc = (r: { start: number; end: number } | null) => {
      const acc = productFiltered.filter(a => inRange(eventDate(a, 'accepted'), r))
      const sh = productFiltered.filter(a => inRange(eventDate(a, 'shipped'), r))
      const accQty = acc.reduce((s, a) => s + a.quantity, 0)
      const shQty = sh.reduce((s, a) => s + (a.shippedQty || a.quantity), 0)
      const defQty = acc.reduce((s, a) => s + (a.repairQty || 0) + (a.analysisQty || 0), 0)
      const cycles = sh
        .filter(a => a.actualShipAt)
        .map(a => (new Date(a.actualShipAt!).getTime() - new Date(a.actDate).getTime()) / 86400_000)
        .filter(d => d >= 0 && d <= 365)
      return {
        accQty, shQty,
        defRate: accQty > 0 ? (defQty / accQty) * 100 : null,
        cycle: cycles.length ? cycles.reduce((s, v) => s + v, 0) / cycles.length : null,
      }
    }
    const cur = calc(range)
    const prev = range ? calc({ start: range.start - (range.end - range.start), end: range.start }) : null
    const delta = (a: number | null, b: number | null | undefined) =>
      a != null && b != null && b !== 0 ? ((a - b) / b) * 100 : null
    return {
      cur,
      dAcc: delta(cur.accQty, prev?.accQty),
      dSh: delta(cur.shQty, prev?.shQty),
      dDef: delta(cur.defRate, prev?.defRate),
      dCycle: delta(cur.cycle, prev?.cycle),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productFiltered, range])

  const byKind = useMemo(() => {
    let rows = defectRows
    if (product !== 'all') rows = rows.filter(d => d.act?.actType === product)
    rows = rows.filter(d => inRange(new Date(d.createdAt), range))
    const m = new Map<string, number>()
    for (const d of rows) m.set(d.kind, (m.get(d.kind) || 0) + d.quantity)
    return Object.keys(DEFECT_KINDS)
      .map(k => ({ name: DEFECT_KINDS[k], count: m.get(k) || 0 }))
      .filter(r => r.count > 0)
      .sort((x, y) => y.count - x.count)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defectRows, product, range])

  const exportCsv = () => {
    const esc = (v: unknown) => {
      const t = String(v ?? '')
      return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
    }
    const head = ['Номер акта', 'Изделие', 'Источник', 'Назначение', 'Количество', 'Статус', 'Принят', 'Отгружен (факт)', 'В ремонте', 'На анализе', 'Отгружено штук']
    const lines = filtered.map(a => [
      a.actNumber, a.product?.name || a.actType, (a as Act & { source?: string }).source || '',
      (a as Act & { purpose?: string }).purpose || '', a.quantity, STATUS_LABELS[a.status] || a.status,
      new Date(a.actDate).toLocaleDateString('ru-RU'),
      a.actualShipAt ? new Date(a.actualShipAt).toLocaleDateString('ru-RU') : '',
      a.repairQty || 0, a.analysisQty || 0, a.shippedQty || 0,
    ].map(esc).join(';'))
    const blob = new Blob(['\uFEFF' + [head.join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `аналитика-${new Date().toLocaleDateString('sv')}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const flowDays = period === 'all' ? 90 : parseInt(period)
  const flow = useMemo(() => {
    const days: Record<string, { accepted: number; shipped: number }> = {}
    for (let i = flowDays - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000)

      days[d.toLocaleDateString('sv')] = { accepted: 0, shipped: 0 }
    }
    for (const a of filtered) {
      const ev = eventDate(a, event)
      if (ev) {
        const key = ev.toLocaleDateString('sv')
        if (days[key]) days[key].accepted += a.quantity
      }
      const sh = eventDate(a, 'shipped')
      if (sh) {
        const key = sh.toLocaleDateString('sv')
        if (days[key]) days[key].shipped += a.shippedQty || a.quantity
      }
    }
    const evLabel = EVENTS.find(e => e[0] === event)?.[1] || 'Событие'
    return Object.entries(days).map(([day, v]) => ({
      day: day.slice(8) + '.' + day.slice(5, 7),
      [evLabel]: v.accepted,
      Отгружено: v.shipped,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, flowDays, event])

  const byStatus = useMemo(() =>
    [...ACT_STATUSES, 'stopped']
      .map(s => ({ name: STATUS_LABELS[s] || s, count: filtered.filter(a => a.status === s).length, key: s }))
      .filter(r => r.count > 0),
  [filtered])

  const byProduct = useMemo(() => {
    const m = new Map<string, { qty: number; repair: number; analysis: number }>()
    for (const a of filtered) {
      const k = a.product?.name || a.actType
      const row = m.get(k) || { qty: 0, repair: 0, analysis: 0 }
      row.qty += a.quantity
      row.repair += a.repairQty || 0
      row.analysis += a.analysisQty || 0
      m.set(k, row)
    }
    return [...m.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((x, y) => y.qty - x.qty)
      .slice(0, 8)
  }, [filtered])

  const cycleByProduct = useMemo(() => {
    const m = new Map<string, number[]>()
    for (const a of filtered) {
      if (!a.actualShipAt) continue
      const days = (new Date(a.actualShipAt).getTime() - new Date(a.actDate).getTime()) / 86400_000
      if (days < 0 || days > 365) continue
      const k = a.product?.name || a.actType
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(days)
    }
    return [...m.entries()]
      .map(([name, arr]) => ({ name, days: +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1) }))
      .sort((x, y) => y.days - x.days)
      .slice(0, 8)
  }, [filtered])

  const stageDurations = useMemo(() => {
    const sums = new Map<string, { total: number; n: number }>()
    for (const a of filtered) {
      const dates = FLOW_ORDER
        .map(st => ({ st, d: eventDate(a, st) }))
        .filter(x => x.d !== null) as { st: string; d: Date }[]
      for (let i = 0; i + 1 < dates.length; i++) {
        const days = (dates[i + 1].d.getTime() - dates[i].d.getTime()) / 86400_000
        if (days < 0 || days > 365) continue
        const label = `${STATUS_LABELS[dates[i].st]} → ${STATUS_LABELS[dates[i + 1].st]}`
        const row = sums.get(label) ?? { total: 0, n: 0 }
        row.total += days
        row.n += 1
        sums.set(label, row)
      }
    }
    return [...sums.entries()]
      .map(([name, { total, n }]) => ({ name, days: +(total / n).toFixed(1), n }))
      .sort((x, y) => y.days - x.days)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered])

  const byTester = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of filtered) {
      if (!a.outputControlBy) continue
      m.set(a.outputControlBy, (m.get(a.outputControlBy) || 0) + 1)
    }
    return [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 10)
  }, [filtered])

  const axis = { stroke: C.text, fontSize: 11 }
  const tooltipStyle = {
    borderRadius: 8, border: `1px solid ${C.grid}`, fontSize: 12,
    background: resolvedTheme === 'dark' ? '#18181b' : '#ffffff',
    color: resolvedTheme === 'dark' ? '#fafafa' : '#18181b',
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PERIODS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={event} onValueChange={setEvent}>
          <SelectTrigger className="h-8 w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            {EVENTS.map(([v, l]) => <SelectItem key={v} value={v}>По событию: {l}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={product} onValueChange={setProduct}>
          <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все изделия</SelectItem>
            {productNames.map(pn => <SelectItem key={pn} value={pn}>{pn}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все источники</SelectItem>
            {sourceNames.map(sn => <SelectItem key={sn} value={sn}>{sn}</SelectItem>)}
          </SelectContent>
        </Select>
        {period === 'custom' && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            с <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="h-8 rounded-md border bg-transparent px-2 text-xs" />
            по <input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="h-8 rounded-md border bg-transparent px-2 text-xs" />
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {filtered.length} актов · {filtered.reduce((s, a) => s + a.quantity, 0).toLocaleString('ru-RU')} штук
        </span>
        <button
          className="ml-auto h-8 rounded-md border px-3 text-xs hover:bg-muted"
          onClick={exportCsv}
          title="Скачать данные выбранного периода для отчёта"
        >
          Выгрузить данные (CSV)
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Принято за период" value={kpis.cur.accQty.toLocaleString('ru-RU')} unit="штук" delta={kpis.dAcc} />
        <Kpi label="Отгружено за период" value={kpis.cur.shQty.toLocaleString('ru-RU')} unit="штук" delta={kpis.dSh} />
        <Kpi label="Уровень несоответствий" value={kpis.cur.defRate != null ? kpis.cur.defRate.toFixed(1) : '—'}
          unit="%" delta={kpis.dDef} goodWhenDown />
        <Kpi label="Средний цикл до отгрузки" value={kpis.cur.cycle != null ? kpis.cur.cycle.toFixed(1) : '—'}
          unit="дней" delta={kpis.dCycle} goodWhenDown />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <Panel title={`${EVENTS.find(e => e[0] === event)?.[1]} и отгрузка по дням, штук (${period === 'all' ? '90 дней' : PERIODS.find(o => o.value === period)?.label})`}>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={flow} margin={{ top: 16, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="day" {...axis} tickLine={false} axisLine={false}
                  interval={Math.max(1, Math.floor(flowDays / 12))} />
                <YAxis {...axis} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Area type="monotone" dataKey={EVENTS.find(e => e[0] === event)?.[1] || 'Событие'}
                  stroke={C.s1} strokeWidth={2} fill={C.s1} fillOpacity={0.12} dot={false} />
                <Area type="monotone" dataKey="Отгружено" stroke={C.s2} strokeWidth={2}
                  fill={C.s2} fillOpacity={0.12} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
            <div className="flex gap-4 justify-end text-xs text-muted-foreground -mt-1">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: C.s1 }} />
                {EVENTS.find(e => e[0] === event)?.[1]}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: C.s2 }} />Отгружено
              </span>
            </div>
          </Panel>
        </div>

        <Panel title="Акты по статусам">
          {byStatus.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Нет данных за период</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(48 * byStatus.length, 96)}>
              <BarChart data={byStatus} layout="vertical" margin={{ top: 0, right: 40, left: 24, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" {...axis} width={110} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: C.grid, opacity: 0.4 }} />
                <Bar dataKey="count" name="Актов" fill={C.s1} radius={[0, 4, 4, 0]} barSize={18}
                  label={{ position: 'right', fill: C.text, fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Объём по изделиям, штук">
          {byProduct.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Нет данных за период</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(48 * byProduct.length, 96)}>
              <BarChart data={byProduct} layout="vertical" margin={{ top: 0, right: 48, left: 24, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" {...axis} width={90} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: C.grid, opacity: 0.4 }} />
                <Bar dataKey="qty" name="Штук" fill={C.s1} radius={[0, 4, 4, 0]} barSize={18}
                  label={{ position: 'right', fill: C.text, fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Ремонт и анализ по изделиям, штук">
          {byProduct.every(r => !r.repair && !r.analysis) ? (
            <p className="text-sm text-muted-foreground text-center py-8">Дефектов за период нет</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(48 * byProduct.length, 96)}>
              <BarChart data={byProduct.filter(r => r.repair || r.analysis)} layout="vertical"
                margin={{ top: 0, right: 40, left: 24, bottom: 16 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" {...axis} width={90} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: C.grid, opacity: 0.4 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="repair" name="В ремонте" fill={C.s3} radius={[0, 4, 4, 0]} barSize={12} />
                <Bar dataKey="analysis" name="На анализе" fill={C.s1} radius={[0, 4, 4, 0]} barSize={12} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Несоответствия по типам, штук">
          {byKind.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Ярлыков за период нет</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(44 * byKind.length, 96)}>
              <BarChart data={byKind} layout="vertical" margin={{ top: 0, right: 40, left: 24, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" {...axis} width={130} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: C.grid, opacity: 0.4 }} />
                <Bar dataKey="count" name="Штук" fill={C.s3} radius={[0, 4, 4, 0]} barSize={16}
                  label={{ position: 'right', fill: C.text, fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Средний цикл: от приёмки до отгрузки, дней">
          {cycleByProduct.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Нет отгрузок за период</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(48 * cycleByProduct.length, 96)}>
              <BarChart data={cycleByProduct} layout="vertical" margin={{ top: 0, right: 48, left: 24, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" {...axis} width={90} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: C.grid, opacity: 0.4 }} />
                <Bar dataKey="days" name="Дней" fill={C.s2} radius={[0, 4, 4, 0]} barSize={18}
                  label={{ position: 'right', fill: C.text, fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Среднее время между этапами, дней">
          {stageDurations.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              Появится по мере смены статусов через сайт
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(44 * stageDurations.length, 96)}>
              <BarChart data={stageDurations} layout="vertical" margin={{ top: 0, right: 48, left: 24, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" {...axis} width={210} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: C.grid, opacity: 0.4 }} />
                <Bar dataKey="days" name="Дней" fill={C.s3} radius={[0, 4, 4, 0]} barSize={16}
                  label={{ position: 'right', fill: C.text, fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>

        <Panel title="Выходной контроль по тестировщикам, актов">
          {byTester.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Нет данных за период</p>
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(40 * byTester.length, 96)}>
              <BarChart data={byTester} layout="vertical" margin={{ top: 0, right: 40, left: 12, bottom: 0 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" {...axis} width={64} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: C.grid, opacity: 0.4 }} />
                <Bar dataKey="count" name="Актов" fill={C.s1} radius={[0, 4, 4, 0]} barSize={14}
                  label={{ position: 'right', fill: C.text, fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>
    </div>
  )
}
