'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { ROLE_LABELS, type Role } from '@/lib/roles'

interface Emp { id: string; code: string; name: string; role: string }

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  )
}

function LoginInner() {
  const router = useRouter()
  const nextUrl = useSearchParams().get('next') || '/'
  const [employees, setEmployees] = useState<Emp[]>([])
  const [chat, setChat] = useState<{ sso: boolean; publicUrl: string } | null>(null)
  const [selected, setSelected] = useState<Emp | null>(null)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/auth').then(r => r.json()).then(j => {
      if (j.success) {
        setEmployees(j.data.employees)
        setChat(j.data.chat || null)
      }
    }).catch(() => toast.error('Сервер недоступен'))
  }, [])

  const submit = async (fullPin: string) => {
    if (!selected || busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: selected.id, pin: fullPin }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error)
      toast.success(`Вы вошли: ${json.message}`)
      router.push(nextUrl.startsWith('/') ? nextUrl : '/')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  const press = (d: string) => {
    if (busy) return
    if (d === '⌫') { setPin(p => p.slice(0, -1)); return }
    const next = (pin + d).slice(0, 6)
    setPin(next)
    if (next.length >= 4 && d === 'OK') return
  }

  return (
    <div className="min-h-screen bg-muted/30 flex flex-col items-center justify-center p-6">
      <h1 className="text-2xl font-bold mb-1">Производственный учёт УТК — вход</h1>
      <p className="text-xs uppercase tracking-wide text-muted-foreground mb-6">Только для локального использования</p>

      {!selected ? (
        <div className="w-full max-w-2xl">
          {chat?.sso && (
            <div className="mb-6 flex flex-col items-center gap-2">
              <button
                className="h-14 px-10 rounded-2xl bg-primary text-primary-foreground text-lg font-semibold active:scale-95 transition-transform"
                onClick={async () => {
                  try {
                    const res = await fetch('/api/auth/sso', { method: 'POST' })
                    const json = await res.json()
                    if (!json.success) {
                      if (json.needChatLogin) {
                        const url = chat.publicUrl || `${location.protocol}//${location.hostname}:3780`
                        toast.error(json.error)
                        window.open(url, '_blank')
                        return
                      }
                      throw new Error(json.error)
                    }
                    toast.success(`Вы вошли: ${json.message}`)
                    router.push(nextUrl.startsWith('/') ? nextUrl : '/')
                    router.refresh()
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : 'Ошибка')
                  }
                }}
              >
                Войти через аккаунт чата
              </button>
              <p className="text-xs text-muted-foreground max-w-md text-center">
                Как войти через чат: 1) откройте LocalChat и войдите там своим логином;
                2) вернитесь сюда и нажмите кнопку выше — учёт подхватит ваш вход из чата.
                Роль (участник / модератор / администратор) берётся из вашей роли в группе чата.
                Не состоите в группе — попросите администратора добавить. Или выберите себя ниже и войдите по PIN.
              </p>
            </div>
          )}
          <p className="text-muted-foreground text-center mb-4">Кто вы?</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {employees.map(e => (
              <button
                key={e.id}
                onClick={() => { setSelected(e); setPin('') }}
                className="rounded-2xl border bg-card p-5 text-left hover:border-primary hover:bg-primary/5 transition-colors min-h-[96px]"
              >
                <div className="text-2xl font-bold">{e.code}</div>
                <div className="text-sm mt-1">{e.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {ROLE_LABELS[e.role as Role] || e.role}
                </div>
              </button>
            ))}
          </div>
          {employees.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">Загрузка…</p>
          )}
        </div>
      ) : (
        <div className="w-full max-w-xs">
          <button className="text-sm text-muted-foreground hover:underline mb-3"
            onClick={() => { setSelected(null); setPin('') }}>← выбрать другого</button>
          <div className="rounded-2xl border bg-card p-5 text-center mb-4">
            <div className="text-2xl font-bold">{selected.code}</div>
            <div className="text-sm">{selected.name}</div>
            <div className="mt-3 text-3xl tracking-[0.5em] font-mono h-10">
              {'•'.repeat(pin.length) || <span className="text-muted-foreground text-base tracking-normal">введите PIN</span>}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {['1','2','3','4','5','6','7','8','9','⌫','0','OK'].map(d => (
              <button
                key={d}
                disabled={busy || (d === 'OK' && pin.length < 4)}
                onClick={() => (d === 'OK' ? submit(pin) : press(d))}
                className={`h-16 rounded-xl border text-2xl font-semibold transition-colors active:scale-95 ${
                  d === 'OK'
                    ? 'bg-primary text-primary-foreground disabled:opacity-40'
                    : 'bg-card hover:bg-muted'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-8 text-center max-w-sm">
        Просмотр журнала и статистики доступен без входа. Вход нужен, чтобы
        вносить изменения — подпись ставится автоматически.
      </p>
    </div>
  )
}
