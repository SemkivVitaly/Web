'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { DEFECT_KINDS, DEFECT_STATES } from '@/lib/statuses'
import { sendOrQueue } from '@/lib/offline-queue'

export interface DefectRecord {
  id: string
  kind: string
  state: string
  quantity: number
  labelNumber?: string | null
  serial?: string | null
  designator?: string | null
  description?: string | null
  reportedBy?: string | null
  checkedBy?: string | null
  createdAt: string
  resolvedAt?: string | null
}

const STATE_COLORS: Record<string, string> = {
  in_repair: 'text-amber-600 dark:text-amber-400 border-amber-500/40',
  isolator: 'text-red-600 dark:text-red-400 border-red-500/40',
  on_analysis: 'text-blue-600 dark:text-blue-400 border-blue-500/40',
  awaiting_decision: 'text-rose-600 dark:text-rose-400 border-rose-500/40',
  returned: 'text-emerald-600 dark:text-emerald-400 border-emerald-500/40',
  deviation_approved: 'text-teal-600 dark:text-teal-400 border-teal-500/40',
}

const KIND_HINTS: Record<string, string> = {
  mass: 'Массовый дефект: будет сообщено разработчику, работа по нему — после решения',
  hardware: 'Изделие будет помещено в изолятор',
  analysis: 'Не диагностируется на месте — передаётся разработчику',
}

export function notifyActsChanged() {
  window.dispatchEvent(new Event('acts:refresh'))
}

interface LabelFormState {
  kind: string
  quantity: string
  labelNumber: string
  serial: string
  designator: string
  ncActNumber: string
  reportedBy: string
  description: string
}

export function DefectsSection({ actId, ncActNumber, productId }: { actId: string; ncActNumber?: string | null; productId?: string | null }) {
  const [defects, setDefects] = useState<DefectRecord[]>([])
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [edit, setEdit] = useState({ kind: 'new', labelNumber: '', quantity: '1', serial: '', designator: '', reportedBy: '', description: '' })

  const emptyForm: LabelFormState = {
    kind: 'new', quantity: '1', labelNumber: '', serial: '', designator: '', ncActNumber: ncActNumber || '', reportedBy: '', description: '',
  }
  const [form, setForm] = useState(emptyForm)

  const [actSerials, setActSerials] = useState<string[]>([])
  const [catalog, setCatalog] = useState<{ id: string; text: string }[]>([])
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/defects?actId=${actId}`)
      const json = await res.json()
      if (json.success) setDefects(json.data)
      const ur = await fetch(`/api/acts/${actId}/units`)
      const uj = await ur.json()
      if (uj.success) setActSerials(uj.data.map((u: { serial: string }) => u.serial))
      const cr = await fetch(`/api/defect-catalog${productId ? `?productId=${productId}` : ''}`)
      const cj = await cr.json()
      if (cj.success) setCatalog(cj.data)
    } catch {  }
  }, [actId, productId])

  useEffect(() => { load() }, [load])

  const submit = async () => {
    if (saving) return
    setSaving(true)
    try {
      const r = await sendOrQueue('/api/defects', {
        method: 'POST',
        body: {
          actId,
          kind: form.kind,
          quantity: parseInt(form.quantity) || 1,
          labelNumber: form.labelNumber || undefined,
          serial: form.serial || undefined,
          designator: form.designator || undefined,
          ncActNumber: form.ncActNumber || undefined,
          reportedBy: form.reportedBy || undefined,
          description: form.description || undefined,
        },
      }, `Ярлык ${form.labelNumber || ''} (${DEFECT_KINDS[form.kind]})`)
      if (r.queued) {
        toast.info('Нет связи — ярлык сохранён на этом ПК и уйдёт автоматически')
        setShowForm(false)
        return
      }
      if (r.json?.needLogin) {
        toast.error('Войдите в систему (кнопка «Войти» в шапке)')
        return
      }
      if (!r.ok) throw new Error(r.json?.error || 'Ошибка')
      toast[form.kind === 'mass' ? 'warning' : 'success'](r.json?.message || 'Готово')
      setForm({ ...emptyForm, ncActNumber: form.ncActNumber })
      setShowForm(false)
      await load()
      notifyActsChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setSaving(false)
    }
  }

  const patch = async (id: string, body: Record<string, unknown>, done?: () => void) => {
    try {
      const r = await sendOrQueue(`/api/defects/${id}`, { method: 'PUT', body }, 'Правка ярлыка')
      if (r.queued) {
        toast.info('Нет связи — правка сохранена на этом ПК и уйдёт автоматически')
        done?.()
        return
      }
      if (!r.ok) throw new Error(r.json?.error || 'Ошибка')
      toast.success(r.json?.message || 'Готово')
      done?.()
      await load()
      notifyActsChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  const remove = async (d: DefectRecord) => {
    const name = d.labelNumber ? `ярлык ${d.labelNumber}` : 'этот ярлык'
    if (!window.confirm(`Удалить ${name}? Количество будет снято со счётчиков акта.`)) return
    try {
      const res = await fetch(`/api/defects/${d.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!json.success) throw new Error(json.error)
      toast.success(json.message)
      setEditId(null)
      await load()
      notifyActsChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    }
  }

  const startEdit = (d: DefectRecord) => {
    setEditId(d.id)
    setEdit({
      kind: d.kind,
      labelNumber: d.labelNumber || '',
      quantity: String(d.quantity),
      serial: d.serial || '',
      designator: d.designator || '',
      reportedBy: d.reportedBy || '',
      description: d.description || '',
    })
  }

  const openCount = defects.filter(d => d.state !== 'returned' && d.state !== 'deviation_approved').length

  return (
    <section className="rounded-lg border">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          {ncActNumber ? `Акт несоответствия № ${ncActNumber}` : 'Несоответствия'}
          {openCount > 0 && <Badge variant="destructive">{openCount} откр.</Badge>}
        </h3>
        <Button size="sm" variant={showForm ? 'secondary' : 'outline'} onClick={() => setShowForm(v => !v)}>
          {showForm ? 'Скрыть' : 'Добавить ярлык'}
        </Button>
      </header>

      <div className="p-4 space-y-3">
        {showForm && (
          <div className="rounded-md border bg-muted/40 p-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Тип дефекта</Label>
                <Select value={form.kind} onValueChange={(v) => setForm(f => ({ ...f, kind: v }))}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(DEFECT_KINDS).map(([v, l]) => (
                      <SelectItem key={v} value={v}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {form.kind === 'mass' ? (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Затронуто изделий (партия)</Label>
                  <Input className="h-8" type="number" min="1" value={form.quantity}
                    onChange={(e) => setForm(f => ({ ...f, quantity: e.target.value }))} />
                </div>
              ) : (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Количество</Label>
                  <Input className="h-8" value="1 изделие" disabled readOnly
                    title="Один ярлык несоответствия оформляется на один серийный номер" />
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Номер ярлыка</Label>
                <Input className="h-8" value={form.labelNumber} placeholder="Я-77"
                  onChange={(e) => setForm(f => ({ ...f, labelNumber: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Номер акта несоответствия</Label>
                <Input className="h-8" value={form.ncActNumber} placeholder="№ акта"
                  onChange={(e) => setForm(f => ({ ...f, ncActNumber: e.target.value }))} />
              </div>
              <div className="space-y-1 col-span-2">
                <Label className="text-xs text-muted-foreground">
                  {form.kind === 'mass'
                    ? 'Серийный номер изделия (если известен)'
                    : 'Серийный номер изделия — один ярлык на один серийник'}
                </Label>
                <Input className="h-8" value={form.serial} list={`serials-${actId}`}
                  placeholder={actSerials.length ? 'выберите из отсканированных' : 'скан или ввод'}
                  onChange={(e) => setForm(f => ({ ...f, serial: e.target.value }))} />
                <datalist id={`serials-${actId}`}>
                  {actSerials.map(sn => <option key={sn} value={sn} />)}
                </datalist>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1 col-span-2 sm:col-span-1">
                <Label className="text-xs text-muted-foreground">Десигнатор (позиция на плате)</Label>
                <Input className="h-8" value={form.designator} placeholder="C10"
                  onChange={(e) => setForm(f => ({ ...f, designator: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Причина / что обнаружено
                {catalog.length > 0 && <span className="ml-1">(подсказки — из каталога типовых дефектов)</span>}
              </Label>
              <Input className="h-8" list={`defect-catalog-${actId}`} value={form.description}
                onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} />
              <datalist id={`defect-catalog-${actId}`}>
                {catalog.map(c => <option key={c.id} value={c.text} />)}
              </datalist>
              {form.description.trim() && !catalog.some(c => c.text === form.description.trim()) && (
                <button type="button" className="text-xs text-muted-foreground underline"
                  onClick={async () => {
                    const r = await fetch('/api/defect-catalog', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ text: form.description.trim(), productId: productId || null }),
                    })
                    const j = await r.json()
                    if (j.success) { toast.success(j.message); load() } else toast.error(j.error)
                  }}>
                  Сохранить формулировку в каталог
                </button>
              )}
            </div>
            {KIND_HINTS[form.kind] && (
              <p className="text-xs font-medium text-amber-600 dark:text-amber-400">{KIND_HINTS[form.kind]}</p>
            )}
            <Button size="sm" onClick={submit} disabled={saving} className="w-full">
              {saving ? 'Сохранение…' : 'Зафиксировать ярлык'}
            </Button>
          </div>
        )}

        {defects.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-1.5">Несоответствий нет</p>
        ) : (
          <ul className="space-y-2">
            {defects.map(d => (
              <li key={d.id} className="rounded-md border px-3 py-2">
                {editId === d.id ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Номер ярлыка</Label>
                        <Input className="h-8" value={edit.labelNumber}
                          onChange={e => setEdit(f => ({ ...f, labelNumber: e.target.value }))} />
                      </div>
                      {edit.kind === 'mass' && (
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground">Затронуто изделий (партия)</Label>
                          <Input className="h-8" type="number" min="1" value={edit.quantity}
                            onChange={e => setEdit(f => ({ ...f, quantity: e.target.value }))} />
                        </div>
                      )}
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Тестировщик</Label>
                        <Input className="h-8" value={edit.reportedBy} placeholder="Т-25"
                          onChange={e => setEdit(f => ({ ...f, reportedBy: e.target.value }))} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Серийный номер изделия</Label>
                        <Input className="h-8" value={edit.serial} list={`serials-${actId}`}
                          onChange={e => setEdit(f => ({ ...f, serial: e.target.value }))} />
                      </div>
                      <div className="space-y-1 col-span-2">
                        <Label className="text-xs text-muted-foreground">Десигнатор (позиция на плате)</Label>
                        <Input className="h-8" value={edit.designator} placeholder="C10"
                          onChange={e => setEdit(f => ({ ...f, designator: e.target.value }))} />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Причина</Label>
                      <Textarea rows={2} value={edit.description}
                        onChange={e => setEdit(f => ({ ...f, description: e.target.value }))} />
                    </div>
                    <div className="flex gap-2 items-center">
                      <Button size="sm" onClick={() => patch(d.id, {
                        labelNumber: edit.labelNumber,
                        quantity: parseInt(edit.quantity) || 1,
                        serial: edit.serial,
                        designator: edit.designator,
                        reportedBy: edit.reportedBy,
                        description: edit.description,
                      }, () => setEditId(null))}>Сохранить</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditId(null)}>Отмена</Button>
                      <Button size="sm" variant="ghost"
                        className="ml-auto text-red-600 dark:text-red-400 hover:text-red-700"
                        onClick={() => remove(d)}>Удалить</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">
                          {d.labelNumber ? `Ярлык ${d.labelNumber}` : DEFECT_KINDS[d.kind] || d.kind}
                        </span>
                        {d.labelNumber && (
                          <span className="text-xs text-muted-foreground">{DEFECT_KINDS[d.kind] || d.kind}</span>
                        )}
                        <Badge variant="outline" className={STATE_COLORS[d.state] || ''}>
                          {DEFECT_STATES[d.state] || d.state}
                        </Badge>
                        {(d.kind === 'mass' || d.quantity > 1) && (
                          <span className="text-xs text-muted-foreground tabular-nums">{d.quantity} штук</span>
                        )}
                        {d.serial && (
                          <span className="text-xs font-mono rounded border px-1.5 py-0.5">{d.serial}</span>
                        )}
                        {d.designator && (
                          <span className="text-xs text-muted-foreground">десигнатор {d.designator}</span>
                        )}
                      </div>
                      {d.description && <p className="text-xs text-muted-foreground mt-1">{d.description}</p>}
                      <p className="text-[11px] text-muted-foreground/70 tabular-nums mt-0.5">
                        {new Date(d.createdAt).toLocaleString('ru-RU')}
                        {d.reportedBy ? ` · ${d.reportedBy}` : ''}
                        {d.checkedBy
                          ? <span className="text-emerald-600 dark:text-emerald-400"> · проверил {d.checkedBy}</span>
                          : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Select value={d.state} onValueChange={(v) => patch(d.id, { state: v })}>
                        <SelectTrigger className="h-7 w-44 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {Object.entries(DEFECT_STATES).map(([v, l]) => (
                            <SelectItem key={v} value={v}>{l}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!d.checkedBy && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                          title="Подпись проверяющего (второе лицо ярлыка) — старший тестировщик или начальник"
                          onClick={() => patch(d.id, { confirmCheck: true })}>Проверить</Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                        onClick={() => startEdit(d)}>Изменить</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
