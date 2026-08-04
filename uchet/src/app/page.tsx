'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { AppShell } from '@/components/app-shell'
import { JournalView } from '@/components/journal-view'
import { ActCard } from '@/components/act-card'
import type { Act } from '@/lib/types'
import { flushQueue, pendingCount } from '@/lib/offline-queue'

const JOURNAL_STATUS: Record<string, string> = {
  accepted: 'accepted',
  input_control: 'input-control',
  in_progress: 'in-work',
  output_control: 'output-control',
  ready_to_ship: 'ready-for-ship',
  shipped: 'shipped',

  stopped: 'stopped',
  cancelled: 'cancelled',
  completed: 'shipped',
}

const CACHE_KEY = 'uchet-local-copy-v1'

export default function JournalPage() {
  const [acts, setActs] = useState<Act[]>([])
  const [openActId, setOpenActId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [offlineSince, setOfflineSince] = useState<string | null>(null)
  const [syncInfo, setSyncInfo] = useState<{ enabled: boolean; lastWriteAt?: string | null; lastError?: string | null } | null>(null)

  const refresh = useCallback(async () => {

    try {
      if (pendingCount() > 0) {
        const { sent, dropped } = await flushQueue()
        if (sent > 0) toast.success(`Отправлено отложенных изменений: ${sent}`)
        for (const d of dropped) toast.error(`Отклонено сервером: ${d}`)
      }
    } catch {  }
    try {
      const a = await fetch('/api/acts').then(r => r.json())
      if (a.success) {
        setActs(a.data)
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), acts: a.data }))
        } catch {  }
      }
      setLoaded(true)
      setOfflineSince(null)
      fetch('/api/sync').then(r => r.json()).then(j => j.success && setSyncInfo(j.data)).catch(() => {})
    } catch {

      try {
        const raw = localStorage.getItem(CACHE_KEY)
        if (raw) {
          const cached = JSON.parse(raw)
          setActs(prev => (prev.length ? prev : cached.acts || []))
          setLoaded(true)
          setOfflineSince(cached.at)
        }
      } catch {  }
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const byId = params.get('actId')
    if (byId) { setOpenActId(byId); return }
    const target = params.get('act')
    if (!target) return
    fetch(`/api/acts?number=${encodeURIComponent(target)}`)
      .then(r => r.json())
      .then(j => {
        if (j.success && j.data.length > 0) {
          if (j.data.length > 1) toast.info(`Найдено актов с этим номером: ${j.data.length} — открыт первый`)
          setOpenActId(j.data[0].id)
        } else {
          toast.error(`Акт «${target}» не найден`)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) refresh()
    }, 15000)
    window.addEventListener('acts:refresh', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('acts:refresh', refresh)
    }
  }, [refresh])

  const productName = useCallback((a: Act) => a.product?.name || a.actType, [])

  const localDate = (v?: string | null) =>
    v ? new Date(v).toLocaleDateString('sv') : null
  const localTime = (v?: string | null) =>
    v ? new Date(v).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : null

  const journalEntries = useMemo(() => acts.map((a) => ({
    id: a.id,
    date: localDate(a.actDate) || '',
    time: a.actTime || '',
    product: productName(a),
    source: a.source || 'Склад',
    actNumber: a.actNumber,
    quantity: a.quantity,
    mismatchAct: a.ncActNumber || null,
    repairQty: a.repairQty || null,
    analysisQty: a.analysisQty || 0,
    status: (JOURNAL_STATUS[a.status] || 'in-work') as 'in-work',
    plannedShipDate: localDate(a.plannedShipAt),
    plannedShipTime: localTime(a.plannedShipAt),
    actualShipDate: localDate(a.actualShipAt),
    actualShipTime: localTime(a.actualShipAt),
    outputControlBy: a.outputControlBy || null,
    notes: a.notes || null,
    statusDates: Object.fromEntries(
      Object.entries(a.statusDates || {}).map(([k, v]) => [k, localDate(v) || '']),
    ),
  })), [acts, productName])

  const openAct = acts.find(a => a.id === openActId) || null

  return (
    <AppShell>
      {offlineSince && (
        <div className="rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-700 dark:text-amber-400 px-4 py-2 text-sm font-medium">
          Нет связи с сервером — показана локальная копия от{' '}
          {new Date(offlineSince).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.
          Просмотр и выгрузка CSV работают, изменения — нет. Данные обновятся сами, когда сервер вернётся.
        </div>
      )}

      <JournalView entries={journalEntries} isLoading={!loaded} onRowClick={setOpenActId} />

      <p className="text-xs text-muted-foreground">
        Данные обновляются автоматически каждые 15 секунд
        {syncInfo?.enabled && (
          <>
            {' · '}
            {syncInfo.lastError
              ? <span className="text-amber-600 dark:text-amber-400">Excel: {syncInfo.lastError}</span>
              : `общий Excel синхронизирован${syncInfo.lastWriteAt ? ' в ' + new Date(syncInfo.lastWriteAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''}`}
          </>
        )}
      </p>

      <ActCard
        act={openAct}
        productName={openAct ? productName(openAct) : undefined}
        open={!!openActId}
        onOpenChange={(v) => !v && setOpenActId(null)}
      />
    </AppShell>
  )
}
