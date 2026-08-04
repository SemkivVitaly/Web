'use client'

interface QueuedMutation {
  id: string
  path: string
  method: string
  body?: string
  at: string
  label: string
}

const KEY = 'uchet-pending-v1'
const newId = () =>
  (crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)

const load = (): QueuedMutation[] => {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]') as QueuedMutation[]

    let changed = false
    for (const m of list) if (!m.id) { m.id = newId(); changed = true }
    if (changed) localStorage.setItem(KEY, JSON.stringify(list))
    return list
  } catch { return [] }
}
const save = (q: QueuedMutation[]) => {
  try { localStorage.setItem(KEY, JSON.stringify(q)) } catch {  }
  window.dispatchEvent(new Event('queue:changed'))
}
const removeByIds = (ids: Set<string>) => {
  save(load().filter(m => !ids.has(m.id)))
}

export const pendingCount = (): number => load().length

const headersFor = (key: string, hasBody: boolean): Record<string, string> => {
  const h: Record<string, string> = { 'Idempotency-Key': key }
  if (hasBody) h['Content-Type'] = 'application/json'
  return h
}

export interface ApiJson {
  success?: boolean
  error?: string
  message?: string
  needLogin?: boolean
  data?: { id?: string; actNumber?: string; added?: number; skipped?: number; total?: number; [key: string]: unknown }
}

export async function sendOrQueue(
  path: string,
  init: { method: string; body?: unknown },
  label: string,
): Promise<{ queued: boolean; ok?: boolean; json?: ApiJson }> {
  const body = init.body !== undefined ? JSON.stringify(init.body) : undefined
  const key = newId()
  const enqueue = () => {
    const q = load()
    q.push({ id: key, path, method: init.method, body, at: new Date().toISOString(), label })
    save(q)
    return { queued: true as const }
  }
  if (pendingCount() > 0) {
    const r = enqueue()

    flushQueue().catch(() => {})
    return r
  }
  try {
    const res = await fetch(path, {
      method: init.method,
      headers: headersFor(key, body !== undefined),
      body,
    })
    const json = await res.json().catch(() => ({}))
    return { queued: false, ok: res.ok && json.success !== false, json }
  } catch {
    return enqueue()
  }
}

let flushing = false

async function flushInner(): Promise<{ sent: number; dropped: string[] }> {
  const q = load()
  if (!q.length) return { sent: 0, dropped: [] }
  let sent = 0
  const dropped: string[] = []
  const done = new Set<string>()
  for (const item of q) {
    try {
      const res = await fetch(item.path, {
        method: item.method,
        headers: headersFor(item.id, item.body !== undefined),
        body: item.body,
      })
      if (res.ok) {
        sent++
        done.add(item.id)
      } else if (res.status === 401 || res.status >= 500) {

        break
      } else {
        dropped.push(item.label)
        done.add(item.id)
      }
    } catch {
      break
    }
  }
  if (done.size) removeByIds(done)
  return { sent, dropped }
}

export async function flushQueue(): Promise<{ sent: number; dropped: string[] }> {
  if (flushing) return { sent: 0, dropped: [] }
  flushing = true
  try {

    if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks?.request) {
      return await navigator.locks.request(
        'uchet-flush-v1',
        { ifAvailable: true },
        async (lock) => (lock ? flushInner() : { sent: 0, dropped: [] }),
      )
    }
    return await flushInner()
  } finally {
    flushing = false
  }
}
