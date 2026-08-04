'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { notifyActsChanged } from '@/components/defects-section'
import type { ProductType } from '@/lib/types'

export function ProductsPanel({ products }: { products: ProductType[] }) {
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('шт.')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [busy, setBusy] = useState(false)

  const call = async (path: string, method: string, body?: unknown) => {
    setBusy(true)
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const json = await res.json()
      if (!res.ok || json.success === false) throw new Error(json.error || 'Ошибка')
      toast.success(json.message || 'Готово')
      notifyActsChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!name.trim()) { toast.error('Укажите название изделия'); return }
    await call('/api/products', 'POST', { name: name.trim(), unit: unit.trim() || 'шт.' })
    setName('')
  }

  const active = products.filter(p => p.isActive !== false)
  const archived = products.filter(p => p.isActive === false)

  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold mb-3">Новое изделие</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Название</Label>
            <Input className="h-8 w-56" value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && create()} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Единица измерения</Label>
            <Input className="h-8 w-24" value={unit} onChange={e => setUnit(e.target.value)} />
          </div>
          <Button size="sm" onClick={create} disabled={busy}>Добавить</Button>
        </div>
      </section>

      <section className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Код</TableHead>
              <TableHead>Название</TableHead>
              <TableHead>Единица</TableHead>
              <TableHead className="w-56"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {active.map(p => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs text-muted-foreground">{p.code}</TableCell>
                <TableCell>
                  {editId === p.id ? (
                    <Input className="h-7 w-52" value={editName} autoFocus
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={async e => {
                        if (e.key === 'Enter') {
                          await call(`/api/products/${p.id}`, 'PUT', { name: editName.trim() })
                          setEditId(null)
                        }
                        if (e.key === 'Escape') setEditId(null)
                      }} />
                  ) : (
                    <span className="font-medium">{p.name}</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{p.unit}</TableCell>
                <TableCell className="text-right space-x-1.5">
                  {editId === p.id ? (
                    <>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy}
                        onClick={async () => { await call(`/api/products/${p.id}`, 'PUT', { name: editName.trim() }); setEditId(null) }}>
                        Сохранить
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                        onClick={() => setEditId(null)}>Отмена</Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                        onClick={() => { setEditId(p.id); setEditName(p.name) }}>Переименовать</Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground"
                        disabled={busy}
                        onClick={() => call(`/api/products/${p.id}`, 'PUT', { isActive: false })}>
                        В архив
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {active.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                Изделий пока нет — добавьте первое или импортируйте журнал
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </section>

      {archived.length > 0 && (
        <section className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-semibold mb-2">Архив</h3>
          <div className="flex flex-wrap gap-2">
            {archived.map(p => (
              <Badge key={p.id} variant="secondary" className="gap-2">
                {p.name}
                <button className="text-xs underline" disabled={busy}
                  onClick={() => call(`/api/products/${p.id}`, 'PUT', { isActive: true })}>
                  вернуть
                </button>
              </Badge>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
