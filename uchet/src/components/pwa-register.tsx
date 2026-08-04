'use client'

import { useEffect } from 'react'

export function PwaRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    navigator.serviceWorker.getRegistrations().then(regs => {
      for (const r of regs) {
        const url = r.active?.scriptURL || r.waiting?.scriptURL || r.installing?.scriptURL || ''
        if (url && !url.endsWith('/sw.js')) r.unregister()
      }
    }).catch(() => {})
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }, [])
  return null
}
