'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import type { ActionLogEntry } from '@/lib/types'

const TYPE_LABELS: Record<string, string> = {
  CREATE_ACT: 'Приём',
  UPDATE_ACT: 'Изменение',
  CHANGE_STATUS: 'Смена статуса',
  DELETE_ACT: 'Удаление',
  CREATE_SHIPMENT: 'Отгрузка',
  CREATE_DEFECT: 'Несоответствие',
  UPDATE_DEFECT: 'Несоответствие',
  IMPORT_JOURNAL: 'Импорт Excel',
  EXPORT_REPORT: 'Экспорт',
  UPDATE_EMPLOYEE: 'Сотрудник',
  DELETE_EMPLOYEE: 'Сотрудник удалён',
}

const TYPE_COLORS: Record<string, string> = {
  CREATE_ACT: 'text-emerald-600 dark:text-emerald-400',
  CHANGE_STATUS: 'text-blue-600 dark:text-blue-400',
  DELETE_ACT: 'text-red-600 dark:text-red-400',
  CREATE_DEFECT: 'text-amber-600 dark:text-amber-400',
  UPDATE_DEFECT: 'text-amber-600 dark:text-amber-400',
  IMPORT_JOURNAL: 'text-violet-600 dark:text-violet-400',
  DELETE_EMPLOYEE: 'text-red-600 dark:text-red-400',
  UPDATE_EMPLOYEE: 'text-muted-foreground',
}

const localISO = (d: Date) => d.toLocaleDateString('sv')

export function ActivityPanel({ logs }: { logs: ActionLogEntry[] }) {
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [person, setPerson] = useState('all')
  const [preset, setPreset] = useState<'all' | 'today' | '7d' | '30d'>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const applyPreset = (p: typeof preset) => {
    setPreset(p)
    const now = new Date()
    const today = localISO(now)
    if (p === 'today') { setDateFrom(today); setDateTo(today) }
    else if (p === '7d') { setDateFrom(localISO(new Date(now.getTime() - 6 * 86400_000))); setDateTo(today) }
    else if (p === '30d') { setDateFrom(localISO(new Date(now.getTime() - 29 * 86400_000))); setDateTo(today) }
    else { setDateFrom(''); setDateTo('') }
  }

  const people = useMemo(
    () => [...new Set(logs.map(l => l.userId).filter(Boolean))].sort() as string[],
    [logs],
  )
  // Табельные удалённых сотрудников — берём прямо из журнала (записи об удалении),
  // чтобы помечать их подписи «нет в штате» без обращения к списку сотрудников.
  const deletedCodes = useMemo(
    () => new Set(logs
      .filter(l => l.actionType === 'DELETE_EMPLOYEE' && l.entityNumber)
      .map(l => l.entityNumber as string)),
    [logs],
  )
  const types = useMemo(
    () => [...new Set(logs.map(l => l.actionType))].sort(),
    [logs],
  )

  const filtered = useMemo(() => logs.filter(l => {
    if (type !== 'all' && l.actionType !== type) return false
    if (person !== 'all' && l.userId !== person) return false
    if (search) {
      const q = search.toLowerCase()
      const hay = `${l.description} ${l.entityNumber || ''} ${l.userId || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (dateFrom || dateTo) {
      const d = localISO(new Date(l.createdAt))
      if (dateFrom && d < dateFrom) return false
      if (dateTo && d > dateTo) return false
    }
    return true
  }), [logs, type, person, search, dateFrom, dateTo])

  const groups = useMemo(() => {
    const map = new Map<string, ActionLogEntry[]>()
    for (const l of filtered) {
      const day = localISO(new Date(l.createdAt))
      if (!map.has(day)) map.set(day, [])
      map.get(day)!.push(l)
    }
    return [...map.entries()]
  }, [filtered])

  const dayTitle = (day: string) => {
    const today = localISO(new Date())
    const yesterday = localISO(new Date(Date.now() - 86400_000))
    const base = new Date(day + 'T00:00').toLocaleDateString('ru-RU', {
      weekday: 'long', day: 'numeric', month: 'long',
    })
    if (day === today) return `Сегодня · ${base}`
    if (day === yesterday) return `Вчера · ${base}`
    return base
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Поиск: акт, описание, исполнитель…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8 w-64"
          />
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все действия</SelectItem>
              {types.map(t => (
                <SelectItem key={t} value={t}>{TYPE_LABELS[t] || t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={person} onValueChange={setPerson}>
            <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все исполнители</SelectItem>
              {people.map(pn => <SelectItem key={pn} value={pn}>{pn}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Период:</span>
          {([['all', 'Всё время'], ['today', 'Сегодня'], ['7d', '7 дней'], ['30d', '30 дней']] as const).map(([k, l]) => (
            <Button key={k} variant={preset === k ? 'default' : 'outline'} size="sm"
              className="h-7 px-2.5 text-xs" onClick={() => applyPreset(k)}>{l}</Button>
          ))}
          <span className="text-xs text-muted-foreground ml-1">с</span>
          <Input type="date" value={dateFrom} className="h-7 w-36 text-xs"
            onChange={e => { setDateFrom(e.target.value); setPreset('all') }} />
          <span className="text-xs text-muted-foreground">по</span>
          <Input type="date" value={dateTo} className="h-7 w-36 text-xs"
            onChange={e => { setDateTo(e.target.value); setPreset('all') }} />
          <span className="text-xs text-muted-foreground ml-auto tabular-nums">
            {filtered.length} записей
          </span>
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-10">
          Действий за выбранный период нет
        </p>
      ) : (
        groups.map(([day, list]) => (
          <section key={day} className="rounded-lg border bg-card overflow-hidden">
            <header className="border-b bg-muted/40 px-4 py-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold capitalize">{dayTitle(day)}</h3>
              <span className="text-xs text-muted-foreground tabular-nums">{list.length}</span>
            </header>
            <div className="divide-y">
              {list.map(l => (
                <div key={l.id} className="px-4 py-2 flex items-baseline gap-3 text-sm">
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0 w-12">
                    {new Date(l.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className={`text-xs font-medium shrink-0 w-28 ${TYPE_COLORS[l.actionType] || 'text-muted-foreground'}`}>
                    {TYPE_LABELS[l.actionType] || l.actionType}
                  </span>
                  <span className="min-w-0">
                    {l.description}
                    {l.userId && (
                      <Badge variant="secondary" className="ml-2">
                        {l.userId}
                        {deletedCodes.has(l.userId) && (
                          <span className="ml-1 text-[10px] text-muted-foreground">· нет в штате</span>
                        )}
                      </Badge>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
