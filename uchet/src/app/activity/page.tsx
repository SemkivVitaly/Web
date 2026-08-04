'use client'

import { useCallback, useEffect, useState } from 'react'
import { AppShell } from '@/components/app-shell'
import { ActivityPanel } from '@/components/activity-panel'
import type { ActionLogEntry } from '@/lib/types'

export default function ActivityPage() {
  const [logs, setLogs] = useState<ActionLogEntry[]>([])

  const load = useCallback(() => {
    fetch('/api/logs?limit=400').then(r => r.json()).then(j => {
      if (j?.success) setLogs(Array.isArray(j.data) ? j.data : j.data?.logs || [])
    }).catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) load()
    }, 15000)
    window.addEventListener('acts:refresh', load)
    return () => { clearInterval(timer); window.removeEventListener('acts:refresh', load) }
  }, [load])

  return (
    <AppShell>
      <ActivityPanel logs={logs} />
    </AppShell>
  )
}
