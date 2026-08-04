'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AppShell } from '@/components/app-shell'
import { notifyActsChanged } from '@/components/defects-section'
import { sendOrQueue } from '@/lib/offline-queue'
import { SOURCES } from '@/lib/sources'
import type { ProductType } from '@/lib/types'

const EMPTY = {
  actNumber: '', product: '', quantity: '', source: 'Склад', notes: '',
  initialRepairQty: '', initialAnalysisQty: '', serials: '',
  purpose: 'Тестирование',
}

export default function AcceptPage() {
  const [products, setProducts] = useState<ProductType[]>([])
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [lastAccepted, setLastAccepted] = useState<{ id?: string; actNumber: string } | null>(null)

  useEffect(() => {
    fetch('/api/products').then(r => r.json()).then(j => {
      if (j.success) setProducts(Array.isArray(j.data) ? j.data : j.data?.products || [])
    }).catch(() => {})
  }, [])

  const scannedSerials = [...new Set(
    form.serials.split(/[\s;,]+/).map(s => s.trim()).filter(Boolean)
  )]
  const effectiveQuantity = scannedSerials.length > 0 ? String(scannedSerials.length) : form.quantity

  const submit = async () => {
    if (!form.actNumber.trim() || !form.product.trim() || !effectiveQuantity) {
      toast.error('Заполните: номер акта, изделие, количество (или отсканируйте серийники)')
      return
    }
    const qty = parseInt(effectiveQuantity)
    if (!Number.isFinite(qty) || qty < 1) {
      toast.error('Количество должно быть целым числом больше нуля')
      return
    }
    const repair = parseInt(form.initialRepairQty) || 0
    const analysis = parseInt(form.initialAnalysisQty) || 0
    if (repair + analysis > qty) {
      toast.error(`В ремонте и на анализе (${repair + analysis}) не может быть больше, чем изделий в акте (${qty})`)
      return
    }
    setSaving(true)
    try {
      const now = new Date()
      const known = products.find(p => p.name === form.product.trim())
      const accepted = form.actNumber.trim()
      const r = await sendOrQueue('/api/acts', {
        method: 'POST',
        body: {
          actNumber: accepted,
          actDate: now.toLocaleDateString('sv'),
          actTime: now.toTimeString().slice(0, 5),
          actType: form.product.trim(),
          productId: known?.id,
          quantity: qty,
          source: form.source,
          purpose: form.purpose,
          notes: form.notes.trim() || undefined,
          initialRepairQty: repair || undefined,
          initialAnalysisQty: analysis || undefined,
          serials: scannedSerials.length > 0 ? scannedSerials : undefined,
        },
      }, `Приём акта ${accepted}`)
      if (r.queued) {
        toast.info('Нет связи — акт сохранён на этом ПК и уйдёт автоматически')
        setForm(EMPTY)
        setLastAccepted({ actNumber: accepted })
        return
      }
      if (r.json?.needLogin) {
        toast.error('Войдите в систему (кнопка «Войти» в шапке)')
        return
      }
      if (!r.ok) throw new Error(r.json?.error || 'Ошибка')
      toast.success(r.json?.message || 'Готово')
      setForm(EMPTY)
      setLastAccepted({ id: r.json?.data?.id, actNumber: accepted })
      notifyActsChanged()
      document.getElementById('accept-act-number')?.focus()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppShell>
      <div className="max-w-5xl">
        <div className="mb-4">
          <h2 className="text-xl font-bold">Приём продукции</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Акт создаётся в статусе «Принят», подпись «принял» ставится по вашему входу; следующий шаг — входной контроль.
          </p>
        </div>

        {lastAccepted && (
          <div className="mb-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-sm flex items-center gap-3 flex-wrap">
            <span>Акт <b>{lastAccepted.actNumber}</b> принят.</span>
            {lastAccepted.id && (
              <Link className="underline font-medium" href={`/?actId=${lastAccepted.id}`}>Открыть карточку</Link>
            )}
            <Link className="underline text-muted-foreground" href="/">К журналу</Link>
            <span className="text-muted-foreground">Форма очищена — можно принимать следующий акт.</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <section className="rounded-lg border bg-card p-4 space-y-4">
            <h3 className="text-sm font-semibold">Реквизиты акта</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Номер акта</Label>
                <Input id="accept-act-number" value={form.actNumber} autoFocus
                  onChange={e => setForm(f => ({ ...f, actNumber: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  Количество, штук{scannedSerials.length > 0 && ' — из серийников'}
                </Label>
                <Input type="number" min="1" value={effectiveQuantity}
                  readOnly={scannedSerials.length > 0}
                  onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Изделие</Label>
                <Input list="accept-products" value={form.product}
                  onChange={e => setForm(f => ({ ...f, product: e.target.value }))} />
                <datalist id="accept-products">
                  {products.map(p => <option key={p.id} value={p.name} />)}
                </datalist>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Источник</Label>
                <Select value={form.source} onValueChange={v => setForm(f => ({ ...f, source: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Назначение акта</Label>
              <Select value={form.purpose} onValueChange={v => setForm(f => ({ ...f, purpose: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['Тестирование', 'Инспекция', 'Ремонт', 'Анализ'].map(s => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Примечание</Label>
              <Input value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>

            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-medium">
                Принят с несоответствиями? <span className="text-muted-foreground font-normal">
                (бывает при источниках «Возврат», «Инспекция» — часть изделий
                уже в ремонте или на анализе у разработчика)</span>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Из них уже в ремонте</Label>
                  <Input type="number" min="0" placeholder="0"
                    value={form.initialRepairQty}
                    onChange={e => setForm(f => ({ ...f, initialRepairQty: e.target.value }))} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Из них уже на анализе</Label>
                  <Input type="number" min="0" placeholder="0"
                    value={form.initialAnalysisQty}
                    onChange={e => setForm(f => ({ ...f, initialAnalysisQty: e.target.value }))} />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                На каждое число автоматически создаётся ярлык несоответствия —
                дальше он ведётся как обычно в карточке акта.
              </p>
            </div>
          </section>

          <section className="rounded-lg border bg-card p-4 space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Серийные номера изделий</h3>
              {scannedSerials.length > 0 && (
                <span className="text-xs rounded-full border border-emerald-500/50 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 tabular-nums">
                  отсканировано: {scannedSerials.length}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Сканируйте QR акта — все серийники попадут сюда сразу, количество посчитается само.
              Можно сканировать и по одному. Дубли убираются автоматически.
              Поле можно оставить пустым и внести серийники позже в карточке акта.
            </p>
            <textarea
              className="w-full min-h-64 rounded-md border bg-transparent px-3 py-2 text-sm font-mono"
              placeholder="SN0001&#10;SN0002&#10;SN0003"
              value={form.serials}
              onChange={e => setForm(f => ({ ...f, serials: e.target.value }))}
            />
            {form.serials && (
              <Button variant="ghost" size="sm" onClick={() => setForm(f => ({ ...f, serials: '' }))}>
                Очистить серийники
              </Button>
            )}
          </section>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button size="lg" className="px-10 font-semibold" onClick={submit} disabled={saving}>
            {saving ? 'Сохранение…' : 'Принять'}
          </Button>
          <Link href="/">
            <Button variant="ghost" size="lg">Отмена</Button>
          </Link>
        </div>
      </div>
    </AppShell>
  )
}
