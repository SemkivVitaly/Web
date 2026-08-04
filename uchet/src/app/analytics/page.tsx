'use client'

import { useCallback, useEffect, useState } from 'react'
import { AppShell } from '@/components/app-shell'
import { AnalyticsPanel } from '@/components/analytics-panel'
import type { Act } from '@/lib/types'

export default function AnalyticsPage() {
  const [acts, setActs] = useState<Act[]>([])

  const load = useCallback(() => {
    fetch('/api/acts').then(r => r.json()).then(j => { if (j.success) setActs(j.data) }).catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) load()
    }, 30000)
    window.addEventListener('acts:refresh', load)
    return () => { clearInterval(timer); window.removeEventListener('acts:refresh', load) }
  }, [load])

  return (
    <AppShell>
      <AnalyticsPanel acts={acts} />
    </AppShell>
  )
}
