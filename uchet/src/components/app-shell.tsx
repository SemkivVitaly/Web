'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTheme } from 'next-themes'
import { Moon, Sun, Download, RefreshCw, LogOut, MonitorPlay, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { ImportDialog } from '@/components/import-dialog'
import { pendingCount } from '@/lib/offline-queue'

const NAV = [
  { href: '/', label: 'Журнал' },
  { href: '/analytics', label: 'Аналитика' },
  { href: '/activity', label: 'Действия' },
  { href: '/products', label: 'Продукция' },
  { href: '/employees', label: 'Сотрудники', bossOnly: true },
]

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <Button variant="ghost" size="sm" className="w-9 px-0" aria-label="Тема" />
  return (
    <Button variant="ghost" size="sm" className="w-9 px-0" aria-label="Переключить тему"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
      {resolvedTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  )
}

function useEmbedMode() {
  const [embed, setEmbed] = useState(false)
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search)
      if (q.get('embed') === '1') {
        sessionStorage.setItem('uchet_embed', '1')
        setEmbed(true)
        return
      }
      setEmbed(sessionStorage.getItem('uchet_embed') === '1')
    } catch {
      setEmbed(false)
    }
  }, [])
  return embed
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const embed = useEmbedMode()
  const [me, setMe] = useState<{ code: string; name: string; role: string } | null>(null)
  const [chatCfg, setChatCfg] = useState<{ sso: boolean; publicUrl: string } | null>(null)
  const [editorEnabled, setEditorEnabled] = useState(false)
  const [pending, setPending] = useState(0)
  const [exporting, setExporting] = useState(false)

  const loadMe = useCallback(() => {
    fetch('/api/auth').then(r => r.json()).then(j => {
      setMe(j?.data?.me || null)
      setChatCfg(j?.data?.chat || null)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    loadMe()
    fetch('/api/onlyoffice/config').then(r => r.json()).then(j => setEditorEnabled(Boolean(j?.data?.enabled))).catch(() => {})
    const onQueue = () => setPending(pendingCount())
    onQueue()
    window.addEventListener('queue:changed', onQueue)
    return () => window.removeEventListener('queue:changed', onQueue)
  }, [loadMe])

  const exportJournal = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/journal/export')
      if (!res.ok) throw new Error('Ошибка экспорта')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `Журнал производства_${new Date().toISOString().slice(0, 10)}.xlsx`
      link.click()
      URL.revokeObjectURL(url)
      toast.success('Журнал выгружен')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-[1440px] px-4 h-12 flex items-center gap-3">
          <h1 className="text-sm font-semibold tracking-tight">
            {embed ? 'Точка сбора' : 'Производственный учёт · УТК'}
          </h1>
          {!embed && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground border rounded px-1.5 py-0.5 hidden md:inline">
              Только для локального использования
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Link href={embed ? '/accept?embed=1' : '/accept'}>
              <Button size="sm" className="gap-1.5 font-semibold">
                <Plus className="h-4 w-4" /> Принять акт
              </Button>
            </Link>
            {me ? (
              <span className="flex items-center gap-1.5 text-xs border rounded-full pl-2.5 pr-1 py-0.5">
                <b>{me.code}</b>
                <span className="text-muted-foreground hidden sm:inline">{me.name}</span>
                {!embed && (
                  <button
                    className="rounded-full p-1 hover:bg-muted text-muted-foreground hover:text-foreground"
                    title="Выйти"
                    aria-label="Выйти из системы"
                    onClick={async () => {
                      try { await fetch('/api/auth', { method: 'DELETE' }) } catch {  }
                      setMe(null)
                      toast.success('Вы вышли из системы')
                      window.dispatchEvent(new Event('acts:refresh'))
                    }}
                  ><LogOut className="h-3.5 w-3.5" /></button>
                )}
              </span>
            ) : (
              !embed && (
                <Link href="/login">
                  <Button variant="outline" size="sm">Войти</Button>
                </Link>
              )
            )}
            {pending > 0 && (
              <span className="text-xs font-medium text-amber-600 dark:text-amber-400 border border-amber-500/40 rounded-full px-2.5 py-1"
                title="Изменения, сделанные без связи с сервером; уйдут автоматически">
                Не отправлено: {pending}
              </span>
            )}
            {chatCfg?.sso && !embed && (
              <Button variant="outline" size="sm" onClick={() => {
                const url = chatCfg.publicUrl || `${location.protocol}//${location.hostname}:3780`
                window.open(url, '_blank')
              }}>Чат</Button>
            )}
            <Link href="/monitor">
              <Button variant="outline" size="sm" className="gap-1.5">
                <MonitorPlay className="h-3.5 w-3.5" /> Монитор
              </Button>
            </Link>
            <Link href="/shop">
              <Button variant="outline" size="sm">Цеховой экран</Button>
            </Link>
            {editorEnabled && (
              <Link href="/editor">
                <Button variant="outline" size="sm">Таблица</Button>
              </Link>
            )}
            <ImportDialog onImportComplete={() => window.dispatchEvent(new Event('acts:refresh'))} />
            <Button variant="outline" size="sm" className="gap-1.5" onClick={exportJournal} disabled={exporting}>
              {exporting
                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                : <Download className="h-3.5 w-3.5" />}
              Excel
            </Button>
            <ThemeToggle />
          </div>
        </div>
        <nav className="mx-auto max-w-[1440px] px-4 h-10 flex items-center gap-1">
          {NAV.filter(n => !n.bossOnly || me?.role === 'boss').map(n => {
            const active = pathname === n.href
            return (
              <Link key={n.href} href={n.href}
                className={`px-3 h-7 flex items-center rounded-md text-sm transition-colors ${
                  active
                    ? 'bg-secondary text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}>
                {n.label}
              </Link>
            )
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 py-4 space-y-4">
        {children}
        <footer className="flex items-center justify-end text-xs text-muted-foreground pt-2 pb-6">
          <span className="uppercase tracking-wide">Только для локального использования · внутренняя сеть предприятия</span>
        </footer>
      </main>
    </div>
  )
}
