'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

const MSG_TYPE = 'localchat-uchet-sso'

/**
 * Страница входа из iframe LocalChat: ждёт postMessage с JWT и groupId,
 * вызывает SSO и открывает журнал без PIN.
 */
export default function EmbedPage() {
  return (
    <Suspense>
      <EmbedInner />
    </Suspense>
  )
}

function EmbedInner() {
  const router = useRouter()
  const params = useSearchParams()
  const groupIdParam = params.get('groupId') || ''
  const [status, setStatus] = useState('Ожидание входа из чата…')
  const [error, setError] = useState<string | null>(null)
  const done = useRef(false)

  useEffect(() => {
    const onMessage = async (ev: MessageEvent) => {
      const data = ev.data
      if (!data || data.type !== MSG_TYPE) return
      if (done.current) return
      const token = String(data.token || '')
      const groupId = String(data.groupId || groupIdParam || '')
      if (!token || !groupId) {
        setError('Не получены токен или группа из чата')
        return
      }
      done.current = true
      setStatus('Вход…')
      try {
        const res = await fetch('/api/auth/sso', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ groupId, token }),
          credentials: 'include',
        })
        const json = await res.json()
        if (!json.success) throw new Error(json.error || 'Ошибка входа')
        setStatus('Готово')
        router.replace('/?embed=1')
        router.refresh()
      } catch (e) {
        done.current = false
        setError(e instanceof Error ? e.message : 'Ошибка входа')
      }
    }
    window.addEventListener('message', onMessage)
    // Сигнал родителю, что iframe готов принять SSO
    try {
      window.parent?.postMessage({ type: 'localchat-uchet-ready', groupId: groupIdParam }, '*')
    } catch {
      /* ignore */
    }
    return () => window.removeEventListener('message', onMessage)
  }, [groupIdParam, router])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 bg-muted/30">
      <h1 className="text-xl font-semibold">Точка сбора</h1>
      {error ? (
        <p className="text-sm text-destructive text-center max-w-md">{error}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{status}</p>
      )}
    </div>
  )
}
