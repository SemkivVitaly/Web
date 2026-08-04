'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { ROLE_LABELS, type Role } from '@/lib/roles'

interface Emp { id: string; code: string; name: string; role: string; isActive: boolean; chatTag?: string | null }

export function EmployeesPanel() {
  const [list, setList] = useState<Emp[] | null>(null)
  const [denied, setDenied] = useState(false)
  const [form, setForm] = useState({ code: '', name: '', role: 'tester', pin: '', chatTag: '' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/employees')
      if (res.status === 401 || res.status === 403) { setDenied(true); return }
      const json = await res.json()
      if (json.success) setList(json.data)
    } catch {  }
  }, [])
  useEffect(() => { load() }, [load])

  const call = async (path: string, method: string, body: unknown) => {
    setBusy(true)
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error)
      toast.success(json.message || 'Готово')
      await load()
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
      return false
    } finally {
      setBusy(false)
    }
  }

  if (denied) {
    return (
      <p className="text-sm text-muted-foreground text-center py-10">
        Управление сотрудниками доступно только начальнику. Войдите под
        учёткой начальника.
      </p>
    )
  }
  if (!list) return <p className="text-sm text-muted-foreground text-center py-10">Загрузка…</p>

  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold mb-3">Новый сотрудник</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Код</Label>
            <Input className="h-8 w-24" value={form.code} placeholder="Т-25"
              onChange={e => setForm(f => ({ ...f, code: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Имя</Label>
            <Input className="h-8 w-44" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Роль</Label>
            <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
              <SelectTrigger className="h-8 w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(ROLE_LABELS).map(([v, l]) => (
                  <SelectItem key={v} value={v}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">PIN (4–6 цифр)</Label>
            <Input className="h-8 w-28" value={form.pin} inputMode="numeric"
              onChange={e => setForm(f => ({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 6) }))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Тег в чате (для входа через чат)</Label>
            <Input className="h-8 w-40" value={form.chatTag} placeholder="ivanov"
              onChange={e => setForm(f => ({ ...f, chatTag: e.target.value.trim() }))} />
          </div>
          <Button size="sm" disabled={busy}
            onClick={async () => {
              if (await call('/api/employees', 'POST', form)) setForm({ code: '', name: '', role: 'tester', pin: '', chatTag: '' })
            }}>
            Добавить
          </Button>
        </div>
      </section>

      <p className="text-xs text-muted-foreground px-1">
        Вход через чат: впишите тег (логин в чате) нужному человеку в колонку «Тег в чате» —
        тогда он войдёт под своим табельным, без метки <code>chat:логин</code>. Код, имя, роль и PIN
        любого сотрудника меняются прямо в таблице.
      </p>
      <section className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-28">Код</TableHead>
              <TableHead>Имя</TableHead>
              <TableHead>Тег в чате</TableHead>
              <TableHead>Роль</TableHead>
              <TableHead className="w-72"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map(e => (
              <TableRow key={e.id} className={e.isActive ? '' : 'opacity-50'}>
                <TableCell>
                  <Input className="h-7 w-24 text-xs font-mono font-semibold" defaultValue={e.code}
                    disabled={busy}
                    onBlur={ev => {
                      const v = ev.target.value.trim()
                      if (v && v !== e.code) call(`/api/employees/${e.id}`, 'PUT', { code: v })
                    }} />
                </TableCell>
                <TableCell>
                  <Input className="h-7 w-40 text-xs" defaultValue={e.name}
                    disabled={busy}
                    onBlur={ev => {
                      const v = ev.target.value.trim()
                      if (v && v !== e.name) call(`/api/employees/${e.id}`, 'PUT', { name: v })
                    }} />
                </TableCell>
                <TableCell>
                  <Input className="h-7 w-32 text-xs font-mono" defaultValue={e.chatTag || ''} placeholder="—"
                    disabled={busy}
                    onBlur={ev => {
                      const v = ev.target.value.trim()
                      if (v !== (e.chatTag || '')) call(`/api/employees/${e.id}`, 'PUT', { chatTag: v })
                    }} />
                </TableCell>
                <TableCell>
                  <Select value={e.role} disabled={busy}
                    onValueChange={v => call(`/api/employees/${e.id}`, 'PUT', { role: v })}>
                    <SelectTrigger className="h-7 w-48 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(ROLE_LABELS).map(([v, l]) => (
                        <SelectItem key={v} value={v}>{l}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right space-x-1.5 whitespace-nowrap">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy}
                    onClick={() => {
                      const pin = window.prompt(`Новый PIN для ${e.code} (4–6 цифр):`)
                      if (pin) call(`/api/employees/${e.id}`, 'PUT', { pin })
                    }}>
                    Сменить PIN
                  </Button>
                  {e.isActive ? (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" disabled={busy}
                      onClick={() => call(`/api/employees/${e.id}`, 'PUT', { isActive: false })}>
                      Отключить
                    </Button>
                  ) : (
                    <>
                      <Badge variant="secondary" className="gap-1.5">
                        отключён
                        <button className="underline text-xs" disabled={busy}
                          onClick={() => call(`/api/employees/${e.id}`, 'PUT', { isActive: true })}>
                          вернуть
                        </button>
                      </Badge>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" disabled={busy}
                        onClick={() => {
                          if (window.confirm(`Удалить сотрудника ${e.code} безвозвратно? Подписи в истории останутся.`)) {
                            call(`/api/employees/${e.id}`, 'DELETE', undefined)
                          }
                        }}>
                        Удалить
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  )
}
