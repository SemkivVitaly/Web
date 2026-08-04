'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  History,
  Filter,
  Download,
  Printer,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Search,
  FileSpreadsheet,
  Package,
  Truck,
  Wrench,
  ClipboardCheck,
  Clock,
  CheckCircle2,
  AlertCircle,
  Eye,
  Layers,
  Calculator,
  Calendar,
  Warehouse,
  AlertTriangle,
  Microscope
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { ACT_STATUSES, STATUS_LABELS } from '@/lib/statuses'

interface JournalEntry {
  id: string
  date: string
  time: string
  product: string
  source: string
  actNumber: number | string
  quantity: number
  mismatchAct?: number | string | null
  repairQty?: number | null
  analysisQty?: number | null
  status: JournalStatus
  plannedShipDate?: string | null
  plannedShipTime?: string | null
  actualShipDate?: string | null
  actualShipTime?: string | null
  outputControlBy?: string | null
  notes?: string | null
  statusDates?: Record<string, string>
}

type JournalStatus =
  | 'accepted'
  | 'in-work'
  | 'input-control'
  | 'ready-for-ship'
  | 'output-control'
  | 'shipped'
  | 'stopped'
  | 'cancelled'

const STATUS_CONFIG: Record<JournalStatus, { label: string; color: string; icon: React.ReactNode }> = {
  'accepted': { label: 'Принят', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', icon: <Package className="h-3 w-3" /> },
  'in-work': { label: 'В работе', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400', icon: <Clock className="h-3 w-3" /> },
  'input-control': { label: 'Входной контроль', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400', icon: <Eye className="h-3 w-3" /> },
  'ready-for-ship': { label: 'К отгрузке', color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400', icon: <Package className="h-3 w-3" /> },
  'output-control': { label: 'Выходной контроль', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400', icon: <ClipboardCheck className="h-3 w-3" /> },
  'shipped': { label: 'Отгружен', color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400', icon: <Truck className="h-3 w-3" /> },
  'stopped': { label: 'Остановлен', color: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400', icon: <Clock className="h-3 w-3" /> },
  'cancelled': { label: 'Отменён', color: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300', icon: <Clock className="h-3 w-3" /> }
}

const DEMO_JOURNAL_ENTRIES: JournalEntry[] = [

  { id: '1', date: '2026-07-23', time: '11:37', product: 'Плата А1', source: 'Склад', actNumber: 1311, quantity: 30, status: 'in-work' },
  { id: '2', date: '2026-07-23', time: '11:37', product: 'Плата Д5', source: 'Монтаж', actNumber: 14123, quantity: 10, status: 'input-control' },
  { id: '3', date: '2026-07-23', time: '11:37', product: 'Контроллер В3', source: 'Лакировка', actNumber: 4312, quantity: 30, status: 'ready-for-ship', plannedShipDate: '2026-07-26', plannedShipTime: '15:30', actualShipDate: '2026-07-28', notes: 'Партия укомплектована' },
  { id: '4', date: '2026-07-23', time: '11:37', product: 'Модуль Б2', source: 'Инспекция', actNumber: 15123, quantity: 20, status: 'ready-for-ship' },
  { id: '5', date: '2026-07-23', time: '11:37', product: 'Датчик Г4', source: 'Инспекция', actNumber: 13312, quantity: 60, status: 'output-control', notes: 'Перетест' },

  { id: '6', date: '2026-07-17', time: '10:33', product: 'Контроллер В3', source: 'Инспекция', actNumber: 5644, quantity: 3, mismatchAct: 326, repairQty: 1, analysisQty: 0, status: 'shipped', plannedShipDate: '2026-07-17', plannedShipTime: '19:03', actualShipDate: '2026-07-20', actualShipTime: '10:00', outputControlBy: 'T-25', notes: 'Партия укомплектована' },
  { id: '7', date: '2026-07-17', time: '10:33', product: 'Модуль Б2', source: 'Склад', actNumber: 5647, quantity: 12, mismatchAct: 327, repairQty: 6, analysisQty: 0, status: 'shipped', plannedShipDate: '2026-07-18', plannedShipTime: '20:03', actualShipDate: '2026-07-19', actualShipTime: '12:00', outputControlBy: 'T-26', notes: 'Партия укомплектована' },
  { id: '8', date: '2026-07-18', time: '14:00', product: 'Контроллер В3', source: 'Склад', actNumber: 5705, quantity: 4, mismatchAct: 331, repairQty: 1, analysisQty: 0, status: 'shipped', plannedShipDate: '2026-07-19', plannedShipTime: '21:03', actualShipDate: '2026-07-20', actualShipTime: '10:00', outputControlBy: 'T-11', notes: 'Партия укомплектована' },
  { id: '9', date: '2026-07-18', time: '17:00', product: 'Контроллер В3', source: 'Монтаж', actNumber: 5709, quantity: 9, mismatchAct: null, repairQty: null, analysisQty: null, status: 'shipped', plannedShipDate: '2026-07-20', plannedShipTime: '22:03', actualShipDate: '2026-07-20', actualShipTime: '14:50', outputControlBy: 'T-1', notes: 'Партия укомплектована' },
  { id: '10', date: '2026-07-20', time: '16:45', product: 'Модуль Б2', source: 'Монтаж', actNumber: 5838, quantity: 18, mismatchAct: null, repairQty: null, analysisQty: null, status: 'shipped', plannedShipDate: '2026-07-21', plannedShipTime: '23:03', actualShipDate: '2026-07-21', actualShipTime: '09:35', outputControlBy: 'T-2', notes: 'Партия укомплектована' },
  { id: '11', date: '2026-07-20', time: '19:00', product: 'Контроллер В3', source: 'Монтаж', actNumber: 5852, quantity: 8, mismatchAct: null, repairQty: null, analysisQty: null, status: 'shipped', plannedShipDate: '2026-07-21', plannedShipTime: '10:00', actualShipDate: '2026-07-21', actualShipTime: '10:05', outputControlBy: 'T-1', notes: 'Партия укомплектована' }
]

interface RawJournalImport {
  id?: string
  date: string
  time?: string
  product: string
  source?: string
  actNumber: number | string
  quantity: number
  mismatchAct?: number | string | null
  repairQty?: number | null
  analysisQty?: number | null
  status?: string
  plannedShipDate?: string | null
  plannedShipTime?: string | null
  actualShipDate?: string | null
  actualShipTime?: string | null
  outputControlBy?: string | null
  notes?: string | null
}

export function transformRawToJournalEntry(raw: RawJournalImport, index: number): JournalEntry {

  const statusMap: Record<string, JournalStatus> = {
    'в работе': 'in-work',
    'in-work': 'in-work',
    'work': 'in-work',
    'входной контроль': 'input-control',
    'input-control': 'input-control',
    'input': 'input-control',
    'к отгрузке': 'ready-for-ship',
    'ready-for-ship': 'ready-for-ship',
    'ready': 'ready-for-ship',
    'к отгружен': 'ready-for-ship',
    'выходной контроль': 'output-control',
    'output-control': 'output-control',
    'output': 'output-control',
    'отгружен': 'shipped',
    'shipped': 'shipped',
    'done': 'shipped',
  }

  const normalizedStatus = (raw.status || 'in-work').toLowerCase().trim()

  return {
    id: raw.id || String(index + 1),
    date: raw.date,
    time: raw.time || '00:00',
    product: raw.product,
    source: raw.source?.trim() || 'Склад',
    actNumber: raw.actNumber,
    quantity: raw.quantity,
    mismatchAct: raw.mismatchAct ?? null,
    repairQty: raw.repairQty ?? null,
    analysisQty: raw.analysisQty ?? 0,
    status: statusMap[normalizedStatus] || 'in-work' as JournalStatus,
    plannedShipDate: raw.plannedShipDate || null,
    plannedShipTime: raw.plannedShipTime || null,
    actualShipDate: raw.actualShipDate || null,
    actualShipTime: raw.actualShipTime || null,
    outputControlBy: raw.outputControlBy || null,
    notes: raw.notes || null,
  }
}

export function transformBatchToJournal(rawEntries: RawJournalImport[]): JournalEntry[] {
  return rawEntries.map((raw, index) => transformRawToJournalEntry(raw, index))
}

interface ProductSummary {
  productName: string
  totalQuantity: number
  totalRepairQty: number
  totalAnalysisQty: number
  totalShipped: number
  actsCount: number
  acts: { actNumber: number | string; quantity: number; repairQty?: number | null }[]
}

interface JournalViewProps {
  entries?: JournalEntry[]
  isLoading?: boolean
  onRowClick?: (id: string) => void
}

export function JournalView({ entries = DEMO_JOURNAL_ENTRIES, isLoading = false, onRowClick }: JournalViewProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [serialHint, setSerialHint] = useState<string | null>(null)

  const lookupAct = useCallback(async (q: string): Promise<string | null> => {
    const term = q.trim()
    if (term.length < 3) return null
    try {
      const r = await fetch(`/api/acts?number=${encodeURIComponent(term)}`)
      const j = await r.json()
      if (j.success && j.data.length > 0) return j.data[0].id
    } catch {  }
    return null
  }, [])
  useEffect(() => {
    setSerialHint(null)
    if (searchQuery.trim().length < 3) return
    const t = setTimeout(async () => { setSerialHint(await lookupAct(searchQuery)) }, 350)
    return () => clearTimeout(t)
  }, [searchQuery, lookupAct])
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [productFilter, setProductFilter] = useState<string>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [showSummary, setShowSummary] = useState(true)
  const [sortBy, setSortBy] = useState<'date' | 'product' | 'actNumber'>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const [quickFilter, setQuickFilter] = useState<'all' | 'repair' | 'analysis' | 'shipped' | 'mismatch' | 'inwork'>('all')

  const [datePreset, setDatePreset] = useState<'all' | 'today' | '7d' | '30d' | 'month' | 'custom'>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateField, setDateField] = useState<string>('accepted')

  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(100)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkStatus, setBulkStatus] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)

  const toggleOne = (id: string) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const applyBulk = async () => {
    if (!bulkStatus || selected.size === 0 || bulkBusy) return
    setBulkBusy(true)
    let ok = 0
    const errors: string[] = []
    try {
      for (const id of selected) {
        try {
          const r = await fetch(`/api/acts/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: bulkStatus }),
          })
          const j = await r.json().catch(() => null)
          if (r.ok) ok++
          else {
            const entry = entries.find(e => e.id === id)
            errors.push(`акт ${entry?.actNumber ?? id}: ${j?.error || r.status}`)
          }
        } catch {
          errors.push(`${id}: нет связи`)
        }
      }
      if (ok > 0) toast.success(`Статус «${STATUS_LABELS[bulkStatus] || bulkStatus}» применён: ${ok} из ${selected.size}`)
      for (const e of errors.slice(0, 4)) toast.error(e)
      if (errors.length > 4) toast.error(`…и ещё отказов: ${errors.length - 4}`)
      setSelected(new Set())
      setBulkStatus('')
      window.dispatchEvent(new Event('acts:refresh'))
    } finally {
      setBulkBusy(false)
    }
  }

  const localISO = (d: Date) => d.toLocaleDateString('sv')
  const presetRange = (preset: string): [string, string] => {
    const now = new Date()
    const today = localISO(now)
    switch (preset) {
      case 'today': return [today, today]
      case '7d': return [localISO(new Date(now.getTime() - 6 * 86400_000)), today]
      case '30d': return [localISO(new Date(now.getTime() - 29 * 86400_000)), today]
      case 'month': return [localISO(new Date(now.getFullYear(), now.getMonth(), 1)), today]
      default: return ['', '']
    }
  }
  const applyPreset = (preset: typeof datePreset) => {
    setDatePreset(preset)
    if (preset !== 'custom') {
      const [f, t] = presetRange(preset)
      setDateFrom(f)
      setDateTo(t)
    }
  }

  const uniqueProducts = useMemo(() => [...new Set(entries.map(e => e.product))].sort(), [entries])
  const uniqueSources = useMemo(() => [...new Set(entries.map(e => e.source))].sort(), [entries])

  const filteredEntries = useMemo(() => {
    let result = [...entries]

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(e =>
        e.product.toLowerCase().includes(query) ||
        e.actNumber.toString().includes(query) ||
        (e.source && e.source.toLowerCase().includes(query)) ||
        (e.notes && e.notes.toLowerCase().includes(query)) ||
        (e.outputControlBy && e.outputControlBy.toLowerCase().includes(query))
      )
    }

    if (statusFilter !== 'all') result = result.filter(e => e.status === statusFilter)
    if (productFilter !== 'all') result = result.filter(e => e.product === productFilter)
    if (sourceFilter !== 'all') result = result.filter(e => e.source === sourceFilter)
    if (dateFrom || dateTo) {
      result = result.filter(e => {
        const d = dateField === 'accepted'
          ? e.date
          : dateField === 'shipped'
            ? (e.actualShipDate || e.statusDates?.shipped || '')
            : (e.statusDates?.[dateField] || '')
        if (!d) return false
        if (dateFrom && d < dateFrom) return false
        if (dateTo && d > dateTo) return false
        return true
      })
    }
    if (quickFilter === 'repair') result = result.filter(e => (e.repairQty || 0) > 0)
    if (quickFilter === 'analysis') result = result.filter(e => (e.analysisQty || 0) > 0)
    if (quickFilter === 'shipped') result = result.filter(e => e.status === 'shipped')
    if (quickFilter === 'mismatch') result = result.filter(e => e.mismatchAct)
    if (quickFilter === 'inwork') result = result.filter(e => e.status !== 'shipped')

    result.sort((a, b) => {
      let comparison = 0
      switch (sortBy) {
        case 'date': comparison = new Date(a.date).getTime() - new Date(b.date).getTime(); break
        case 'product': comparison = a.product.localeCompare(b.product); break
        case 'actNumber': comparison = String(a.actNumber).localeCompare(String(b.actNumber), 'ru', { numeric: true }); break
      }
      return sortDir === 'asc' ? comparison : -comparison
    })

    return result
  }, [entries, searchQuery, statusFilter, productFilter, sourceFilter, sortBy, sortDir, quickFilter, dateFrom, dateTo, dateField])

  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const visibleEntries = useMemo(
    () => filteredEntries.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [filteredEntries, safePage, pageSize],
  )
  useEffect(() => { setPage(0) }, [searchQuery, statusFilter, productFilter, sourceFilter, quickFilter, dateFrom, dateTo, dateField, pageSize])

  const productSummary = useMemo((): ProductSummary[] => {
    const summaryMap = new Map<string, ProductSummary>()

    filteredEntries.forEach(entry => {
      if (!summaryMap.has(entry.product)) {
        summaryMap.set(entry.product, {
          productName: entry.product, totalQuantity: 0, totalRepairQty: 0,
          totalAnalysisQty: 0, totalShipped: 0, actsCount: 0, acts: [],
        })
      }

      const summary = summaryMap.get(entry.product)!
      summary.actsCount += 1
      summary.totalQuantity += entry.quantity
      if (entry.repairQty) summary.totalRepairQty += entry.repairQty
      if (entry.analysisQty) summary.totalAnalysisQty += entry.analysisQty
      if (entry.status === 'shipped') summary.totalShipped += entry.quantity
      summary.acts.push({ actNumber: entry.actNumber, quantity: entry.quantity, repairQty: entry.repairQty })
    })

    return Array.from(summaryMap.values()).sort((a, b) => b.totalQuantity - a.totalQuantity)
  }, [filteredEntries])

  const tileBase = useMemo(() => {
    let result = [...entries]
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(e =>
        e.product.toLowerCase().includes(query) ||
        e.actNumber.toString().includes(query) ||
        (e.source && e.source.toLowerCase().includes(query)) ||
        (e.notes && e.notes.toLowerCase().includes(query)) ||
        (e.outputControlBy && e.outputControlBy.toLowerCase().includes(query))
      )
    }
    if (statusFilter !== 'all') result = result.filter(e => e.status === statusFilter)
    if (productFilter !== 'all') result = result.filter(e => e.product === productFilter)
    if (sourceFilter !== 'all') result = result.filter(e => e.source === sourceFilter)
    if (dateFrom || dateTo) {
      result = result.filter(e => {
        const d = dateField === 'accepted'
          ? e.date
          : dateField === 'shipped'
            ? (e.actualShipDate || e.statusDates?.shipped || '')
            : (e.statusDates?.[dateField] || '')
        if (!d) return false
        if (dateFrom && d < dateFrom) return false
        if (dateTo && d > dateTo) return false
        return true
      })
    }
    return result
  }, [entries, searchQuery, statusFilter, productFilter, sourceFilter, dateFrom, dateTo, dateField])

  const tileTotals = useMemo(() => ({
    totalEntries: tileBase.length,
    totalQuantity: tileBase.reduce((sum, e) => sum + e.quantity, 0),
    totalRepairQty: tileBase.reduce((sum, e) => sum + (e.repairQty || 0), 0),
    totalAnalysisQty: tileBase.reduce((sum, e) => sum + (e.analysisQty || 0), 0),
    shippedCount: tileBase.filter(e => e.status === 'shipped').length,
    mismatchActs: tileBase.filter(e => e.mismatchAct).length,
    inProgressCount: tileBase.filter(e => e.status !== 'shipped').length,
  }), [tileBase])

  const dupInfo = useMemo(() => {
    const count = new Map<string, number>()
    entries.forEach(e => {
      const k = `${e.actNumber}::${e.product}`
      count.set(k, (count.get(k) || 0) + 1)
    })
    const seen = new Map<string, number>()
    const info = new Map<string, { n: number; of: number }>()
    entries.forEach(e => {
      const k = `${e.actNumber}::${e.product}`
      const total = count.get(k) || 1
      if (total > 1) {
        const n = (seen.get(k) || 0) + 1
        seen.set(k, n)
        info.set(e.id, { n, of: total })
      }
    })
    return info
  }, [entries])

  const totals = useMemo(() => ({
    totalEntries: filteredEntries.length,
    totalQuantity: filteredEntries.reduce((sum, e) => sum + e.quantity, 0),
    totalRepairQty: filteredEntries.reduce((sum, e) => sum + (e.repairQty || 0), 0),
    totalAnalysisQty: filteredEntries.reduce((sum, e) => sum + (e.analysisQty || 0), 0),
    shippedCount: filteredEntries.filter(e => e.status === 'shipped').length,
    inProgressCount: filteredEntries.filter(e => !['shipped'].includes(e.status)).length,
    mismatchActs: filteredEntries.filter(e => e.mismatchAct).length
  }), [filteredEntries])

  const handleSort = (field: typeof sortBy) => {
    setSortBy(field)
    setSortDir(d => sortBy === field && d === 'desc' ? 'asc' : 'desc')
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return dateStr
    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
  }

  const exportToCSV = () => {
    const headers = [
      'Дата', 'Время', 'Изделие', 'Источник', 'Акт', 'Кол-во',
      'Акт несоответствия', 'Ремонт', 'Анализ', 'Статус',
      'к Отгрузке готов (дата)', 'к Отгрузке готов (время)',
      'фактически Отгрузка (дата)', 'фактически Отгрузка (время)',
      'Выполнил выходной контроль', 'Примечание'
    ]

    const rows = filteredEntries.map(e => [
      formatDate(e.date),
      e.time,
      e.product,
      e.source || 'Склад',
      e.actNumber,
      e.quantity,
      e.mismatchAct || '',
      e.repairQty || '',
      e.analysisQty ?? 0,
      STATUS_CONFIG[e.status]?.label || e.status,
      e.plannedShipDate ? formatDate(e.plannedShipDate) : '',
      e.plannedShipTime || '',
      e.actualShipDate ? formatDate(e.actualShipDate) : '',
      e.actualShipTime || '',
      e.outputControlBy || '',
      e.notes || ''
    ])

    const esc = (v: unknown) => {
      const t = String(v ?? '')
      return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t
    }
    const csv = [headers.join(';'), ...rows.map(r => r.map(esc).join(';'))].join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `journal_${new Date().toISOString().split('T')[0]}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card className="border-border/50">
          <CardHeader>
            <div className="animate-pulse space-y-3">
              <div className="h-6 bg-muted rounded w-48"></div>
              <div className="h-4 bg-muted rounded w-64"></div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="animate-pulse flex gap-4">
                  <div className="h-10 bg-muted rounded flex-1"></div>
                  <div className="h-10 bg-muted rounded flex-1"></div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <Card className="border-border/50 bg-gradient-to-br from-card to-muted/20 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-primary/5 via-transparent to-purple-500/5 pointer-events-none" />
            <CardHeader className="relative pb-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-primary/10 rounded-xl border border-primary/20">
                    <History className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-xl font-bold">Журнал операций</CardTitle>
                    <CardDescription className="mt-1">Полный учёт актов и изделий — нажмите на строку, чтобы открыть карточку акта</CardDescription>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <Button variant="outline" size="sm" onClick={() => setShowSummary(!showSummary)} className="gap-2">
                    <Layers className="h-4 w-4" />
                    {showSummary ? 'Скрыть сводку' : 'Показать сводку'}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="sm" onClick={exportToCSV} className="gap-2">
                        <Download className="h-4 w-4" />
                        <span className="hidden sm:inline">Экспорт CSV</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Экспорт в CSV (Excel совместимый)</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-2">
                        <Printer className="h-4 w-4" />
                        <span className="hidden sm:inline">Печать</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Печать журнала</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </CardHeader>
          </Card>
        </motion.div>

        {}
        <motion.div
          className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          {([
            { key: 'all', value: tileTotals.totalEntries, label: 'Записей', color: 'text-primary' },
            { key: 'all', value: tileTotals.totalQuantity.toLocaleString('ru-RU'), label: 'Всего штук', color: 'text-blue-600 dark:text-blue-400' },
            { key: 'repair', value: tileTotals.totalRepairQty, label: 'В ремонте, штук', color: 'text-red-600 dark:text-red-400' },
            { key: 'analysis', value: tileTotals.totalAnalysisQty, label: 'На анализе, штук', color: 'text-yellow-600 dark:text-yellow-400' },
            { key: 'shipped', value: tileTotals.shippedCount, label: 'Отгружено, записей', color: 'text-green-600 dark:text-green-400' },
            { key: 'mismatch', value: tileTotals.mismatchActs, label: 'С несоответствиями', color: 'text-orange-600 dark:text-orange-400' },
            { key: 'inwork', value: tileTotals.inProgressCount, label: 'Не отгружено, записей', color: 'text-purple-600 dark:text-purple-400' },
          ] as const).map((t, ti) => {
            const active = quickFilter === t.key && t.key !== 'all'
            return (
              <button
                key={ti}
                type="button"
                onClick={() => setQuickFilter(quickFilter === t.key ? 'all' : t.key)}
                title={t.key === 'all' ? 'Сбросить быстрый фильтр' : `Показать: ${t.label}`}
                className={`rounded-xl border p-3 text-center transition-colors cursor-pointer bg-card/50 backdrop-blur-sm hover:bg-muted/60 ${
                  active ? 'border-primary ring-1 ring-primary' : 'border-border/50'
                }`}
              >
                <div className={`text-xl font-bold font-mono ${t.color}`}>{t.value}</div>
                <div className="text-xs text-muted-foreground mt-1">{t.label}</div>
              </button>
            )
          })}
        </motion.div>

        {}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.15 }}>
          <Card className="border-border/50">
            <CardContent className="p-4">
              <div className="flex flex-col lg:flex-row gap-4">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input placeholder="Поиск или скан: изделие, акт, серийный номер, источник..."
                    value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9"
                    onKeyDown={async (e) => {
                      if (e.key !== 'Enter' || !onRowClick) return

                      const id = serialHint || await lookupAct(searchQuery)
                      if (id) onRowClick(id)
                    }} />
                  {serialHint && onRowClick && (
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs rounded-md border px-2 py-1 bg-background hover:bg-muted"
                      onClick={() => onRowClick(serialHint)}
                    >
                      Найден акт по номеру/серийнику — открыть
                    </button>
                  )}
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-full sm:w-[170px]"><SelectValue placeholder="Статус" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все статусы</SelectItem>
                      {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                        <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select value={productFilter} onValueChange={setProductFilter}>
                    <SelectTrigger className="w-full sm:w-[140px]"><SelectValue placeholder="Изделие" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все изделия</SelectItem>
                      {uniqueProducts.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>

                  <Select value={sourceFilter} onValueChange={setSourceFilter}>
                    <SelectTrigger className="w-full sm:w-[140px]"><SelectValue placeholder="Источник" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все источники</SelectItem>
                      {uniqueSources.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>

                  {(searchQuery || statusFilter !== 'all' || productFilter !== 'all' || sourceFilter !== 'all' || dateFrom || dateTo || quickFilter !== 'all') && (
                    <Button variant="ghost" size="sm" onClick={() => { setSearchQuery(''); setStatusFilter('all'); setProductFilter('all'); setSourceFilter('all'); setQuickFilter('all'); setDatePreset('all'); setDateFrom(''); setDateTo(''); }} className="gap-2">
                      <RefreshCw className="h-4 w-4" /> Сбросить
                    </Button>
                  )}
                </div>
              </div>

              {}
              <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-border/50">
                <span className="text-xs text-muted-foreground">Период:</span>
                {([
                  ['all', 'Всё время'],
                  ['today', 'Сегодня'],
                  ['7d', '7 дней'],
                  ['30d', '30 дней'],
                  ['month', 'Этот месяц'],
                ] as const).map(([key, label]) => (
                  <Button
                    key={key}
                    variant={datePreset === key ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => applyPreset(key)}
                  >
                    {label}
                  </Button>
                ))}
                <span className="text-xs text-muted-foreground ml-2">с</span>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => { setDateFrom(e.target.value); setDatePreset('custom') }}
                  className="h-7 w-36 text-xs"
                />
                <span className="text-xs text-muted-foreground">по</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => { setDateTo(e.target.value); setDatePreset('custom') }}
                  className="h-7 w-36 text-xs"
                />
                <Select value={dateField} onValueChange={setDateField}>
                  <SelectTrigger className="h-7 w-52 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="accepted">По дате приёмки</SelectItem>
                    <SelectItem value="input_control">По дате входного контроля</SelectItem>
                    <SelectItem value="in_progress">По дате взятия в работу</SelectItem>
                    <SelectItem value="output_control">По дате выходного контроля</SelectItem>
                    <SelectItem value="ready_to_ship">По дате «К отгрузке»</SelectItem>
                    <SelectItem value="shipped">По дате отгрузки</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {}
        <div className={`grid ${showSummary ? 'grid-cols-1 xl:grid-cols-3' : 'grid-cols-1'} gap-6`}>

          {}
          <motion.div className={`${showSummary ? 'xl:col-span-2' : ''}`} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.2 }}>
            <Card className="border-border/50 overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <FileSpreadsheet className="h-5 w-5 text-primary" />
                    Таблица журнала
                    <Badge variant="secondary" className="ml-2 font-mono">{filteredEntries.length}</Badge>
                  </CardTitle>
                </div>
              </CardHeader>
              {selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-y bg-muted/40 px-4 py-2 text-sm">
                  <span className="font-medium tabular-nums">Выбрано актов: {selected.size}</span>
                  <span className="text-muted-foreground">перевести в статус</span>
                  <Select value={bulkStatus} onValueChange={setBulkStatus}>
                    <SelectTrigger className="h-8 w-52"><SelectValue placeholder="Выберите статус" /></SelectTrigger>
                    <SelectContent>
                      {ACT_STATUSES.map(s => (
                        <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="h-8" disabled={!bulkStatus || bulkBusy} onClick={applyBulk}>
                    {bulkBusy ? 'Применение…' : 'Применить'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8" disabled={bulkBusy}
                    onClick={() => { setSelected(new Set()); setBulkStatus('') }}>
                    Снять выделение
                  </Button>
                  <span className="text-xs text-muted-foreground basis-full">
                    Переходы «не по техпроцессу» применит только старший или начальник; отказы будут показаны по актам.
                  </span>
                </div>
              )}
              <CardContent className="p-0">
                <ScrollArea className="h-[550px]">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader className="sticky top-0 bg-background z-10">
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-8">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-primary cursor-pointer align-middle"
                              aria-label="Выбрать все строки на странице"
                              checked={visibleEntries.length > 0 && visibleEntries.every(e => selected.has(e.id))}
                              onChange={(ev) => setSelected(prev => {
                                const next = new Set(prev)
                                for (const e of visibleEntries) {
                                  if (ev.target.checked) next.add(e.id)
                                  else next.delete(e.id)
                                }
                                return next
                              })}
                            />
                          </TableHead>
                          <TableHead className="cursor-pointer select-none whitespace-nowrap" onClick={() => handleSort('date')}>
                            <div className="flex items-center gap-1">Дата{sortBy === 'date' && (sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}</div>
                          </TableHead>
                          <TableHead className="whitespace-nowrap">Время</TableHead>
                          <TableHead className="whitespace-nowrap">Изделие</TableHead>
                          <TableHead className="whitespace-nowrap">
                            <div className="flex items-center gap-1"><Warehouse className="h-3 w-3" />Источник</div>
                          </TableHead>
                          <TableHead className="cursor-pointer select-none whitespace-nowrap" onClick={() => handleSort('actNumber')}>
                            <div className="flex items-center gap-1">Акт{sortBy === 'actNumber' && (sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}</div>
                          </TableHead>
                          <TableHead className="text-right whitespace-nowrap">Количество</TableHead>
                          <TableHead className="whitespace-nowrap text-orange-600 dark:text-orange-400">Акт несоответствия</TableHead>
                          <TableHead className="whitespace-nowrap text-red-600 dark:text-red-400">В ремонте</TableHead>
                          <TableHead className="whitespace-nowrap text-yellow-600 dark:text-yellow-400">На анализе</TableHead>
                          <TableHead className="whitespace-nowrap">Статус</TableHead>
                          <TableHead className="whitespace-nowrap hidden lg:table-cell">К отгрузке</TableHead>
                          <TableHead className="whitespace-nowrap hidden xl:table-cell">Отгружено (факт)</TableHead>
                          <TableHead className="whitespace-nowrap hidden xl:table-cell">Выходной контроль</TableHead>
                          <TableHead className="whitespace-nowrap hidden md:table-cell max-w-[120px]">Примечание</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                          {filteredEntries.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={15} className="text-center py-12 text-muted-foreground">
                                <div className="flex flex-col items-center gap-2">
                                  <Search className="h-8 w-8 opacity-50" />
                                  <p>Записи не найдены</p>
                                  <p className="text-sm">Попробуйте изменить параметры фильтрации</p>
                                </div>
                              </TableCell>
                            </TableRow>
                          ) : (
                            visibleEntries.map((entry) => (
                              <tr key={entry.id} onClick={() => onRowClick?.(entry.id)} className={`group border-b transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted ${onRowClick ? 'cursor-pointer' : ''}`}
                                data-state={selected.has(entry.id) ? 'selected' : undefined}>
                                <TableCell className="w-8" onClick={(ev) => ev.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 accent-primary cursor-pointer align-middle"
                                    aria-label={`Выбрать акт ${entry.actNumber}`}
                                    checked={selected.has(entry.id)}
                                    onChange={() => toggleOne(entry.id)}
                                  />
                                </TableCell>
                                <TableCell className="font-medium whitespace-nowrap">
                                  <div className="flex items-center gap-2"><Calendar className="h-3 w-3 text-muted-foreground hidden sm:block" />{formatDate(entry.date)}</div>
                                </TableCell>
                                <TableCell className="font-mono text-sm whitespace-nowrap">{entry.time}</TableCell>
                                <TableCell className="whitespace-nowrap"><Badge variant="outline" className="font-semibold">{entry.product}</Badge></TableCell>
                                <TableCell className="whitespace-nowrap">
                                  <Badge variant="secondary" className="bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 font-normal text-xs">
                                    {entry.source || 'Склад'}
                                  </Badge>
                                </TableCell>
                                <TableCell className="font-mono font-semibold whitespace-nowrap text-primary">
                                  {entry.actNumber}
                                  {dupInfo.has(entry.id) && (
                                    <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0 text-amber-600 dark:text-amber-400 border-amber-500/50" title="Один акт несколькими строками (частичные отгрузки)">
                                      {dupInfo.get(entry.id)!.n} из {dupInfo.get(entry.id)!.of}
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell className="text-right font-mono font-semibold tabular-nums whitespace-nowrap">{entry.quantity}</TableCell>
                                <TableCell className="font-mono text-orange-600 dark:text-orange-400 whitespace-nowrap tabular-nums">{entry.mismatchAct || '-'}</TableCell>
                                <TableCell className="text-right font-mono text-red-600 dark:text-red-400 whitespace-nowrap tabular-nums">{entry.repairQty ?? '-'}</TableCell>
                                <TableCell className="text-right font-mono text-yellow-600 dark:text-yellow-400 whitespace-nowrap tabular-nums">{entry.analysisQty ?? 0}</TableCell>
                                <TableCell className="whitespace-nowrap">
                                  <Badge className={`${STATUS_CONFIG[entry.status]?.color || ''} gap-1.5`} variant="secondary">
                                    {STATUS_CONFIG[entry.status]?.icon}{STATUS_CONFIG[entry.status]?.label}
                                  </Badge>
                                </TableCell>
                                <TableCell className="whitespace-nowrap hidden lg:table-cell">
                                  {entry.plannedShipDate && entry.plannedShipTime ? (
                                    <span className="text-sm">{formatDate(entry.plannedShipDate)}<br/><span className="font-mono text-muted-foreground">{entry.plannedShipTime}</span></span>
                                  ) : <span className="text-muted-foreground">-</span>}
                                </TableCell>
                                <TableCell className="whitespace-nowrap hidden xl:table-cell">
                                  {entry.actualShipDate && entry.actualShipTime ? (
                                    <span className="text-sm">{formatDate(entry.actualShipDate)}<br/><span className="font-mono text-green-600 dark:text-green-400">{entry.actualShipTime}</span></span>
                                  ) : <span className="text-muted-foreground">-</span>}
                                </TableCell>
                                <TableCell className="whitespace-nowrap hidden xl:table-cell">
                                  {entry.outputControlBy ? <Badge variant="outline" className="font-mono text-xs">{entry.outputControlBy}</Badge> : <span className="text-muted-foreground">-</span>}
                                </TableCell>
                                <TableCell className="max-w-[120px] truncate hidden md:table-cell">
                                  <Tooltip><TooltipTrigger asChild><span className="text-sm text-muted-foreground cursor-help truncate block">{entry.notes || '-'}</span></TooltipTrigger>{entry.notes && <TooltipContent side="left" className="max-w-[250px]">{entry.notes}</TooltipContent>}</Tooltip>
                                </TableCell>
                              </tr>
                            ))
                          )}
                      </TableBody>
                    </Table>
                  </div>
                </ScrollArea>
                {filteredEntries.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-sm">
                    <span className="text-muted-foreground tabular-nums">
                      Показано {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, filteredEntries.length)} из {filteredEntries.length}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <Select value={String(pageSize)} onValueChange={(v) => setPageSize(parseInt(v))}>
                        <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="50">50 строк</SelectItem>
                          <SelectItem value="100">100 строк</SelectItem>
                          <SelectItem value="200">200 строк</SelectItem>
                          <SelectItem value="100000">Все строки</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button variant="outline" size="sm" className="h-7 px-2.5"
                        disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>‹</Button>
                      <span className="tabular-nums text-xs text-muted-foreground">{safePage + 1} / {pageCount}</span>
                      <Button variant="outline" size="sm" className="h-7 px-2.5"
                        disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>›</Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {}
          <AnimatePresence>
            {showSummary && (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.3, delay: 0.25 }} className="space-y-6">

                {}
                <Card className="border-border/50 overflow-hidden">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Calculator className="h-5 w-5 text-primary" />
                      Сводка по изделиям
                    </CardTitle>
                    <CardDescription>С учётом текущих фильтров журнала</CardDescription>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Изделие</TableHead>
                          <TableHead className="text-right">Актов</TableHead>
                          <TableHead className="text-right">Количество</TableHead>
                          <TableHead className="text-right text-red-600 dark:text-red-400">В ремонте</TableHead>
                          <TableHead className="text-right text-yellow-600 dark:text-yellow-400">На анализе</TableHead>
                          <TableHead className="text-right text-green-600 dark:text-green-400">Отгружено</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {productSummary.map((summary) => (
                          <TableRow
                            key={summary.productName}
                            className="cursor-pointer"
                            onClick={() => setProductFilter(productFilter === summary.productName ? 'all' : summary.productName)}
                            title="Нажмите, чтобы отфильтровать журнал по этому изделию"
                            data-state={productFilter === summary.productName ? 'selected' : undefined}
                          >
                            <TableCell className="font-semibold">{summary.productName}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums">{summary.actsCount}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums font-semibold">{summary.totalQuantity.toLocaleString('ru-RU')}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-red-600 dark:text-red-400">{summary.totalRepairQty || ''}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-yellow-600 dark:text-yellow-400">{summary.totalAnalysisQty || ''}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-green-600 dark:text-green-400">{summary.totalShipped.toLocaleString('ru-RU')}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-primary/5 hover:bg-primary/5 font-bold">
                          <TableCell>Общий итог</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{totals.totalEntries}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">{totals.totalQuantity.toLocaleString('ru-RU')}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-red-600 dark:text-red-400">{totals.totalRepairQty || ''}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-yellow-600 dark:text-yellow-400">{totals.totalAnalysisQty || ''}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-green-600 dark:text-green-400">{filteredEntries.filter(e => e.status === 'shipped').reduce((sum, e) => sum + e.quantity, 0).toLocaleString('ru-RU')}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                {}
                <Card className="border-border/50">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2"><ClipboardCheck className="h-4 w-4 text-primary" />Распределение по статусам</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {(Object.entries(STATUS_CONFIG) as [JournalStatus, typeof STATUS_CONFIG[JournalStatus]][]).map(([key, config]) => {
                      const count = filteredEntries.filter(e => e.status === key).length
                      const percentage = filteredEntries.length > 0 ? (count / filteredEntries.length) * 100 : 0

                      return (
                        <div key={key} className="space-y-1.5">
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">{config.icon}<span>{config.label}</span></div>
                            <span className="font-mono font-semibold">{count}</span>
                          </div>
                          <div className="h-2 bg-muted rounded-full overflow-hidden">
                            <motion.div className={`h-full rounded-full ${key === 'shipped' ? 'bg-green-500' : key === 'ready-for-ship' ? 'bg-purple-500' : key === 'output-control' ? 'bg-orange-500' : key === 'input-control' ? 'bg-yellow-500' : 'bg-blue-500'}`} initial={{ width: 0 }} animate={{ width: `${percentage}%` }} transition={{ duration: 0.5, ease: "easeOut" }} />
                          </div>
                        </div>
                      )
                    })}
                  </CardContent>
                </Card>

                {}
                <Card className="border-border/50">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2"><Warehouse className="h-4 w-4 text-primary" />По источникам</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {uniqueSources.map(source => {
                      const count = filteredEntries.filter(e => e.source === source).length
                      const qty = filteredEntries.filter(e => e.source === source).reduce((s, e) => s + e.quantity, 0)
                      return (
                        <div key={source} className="flex items-center justify-between text-sm p-2 rounded hover:bg-muted/50">
                          <Badge variant="outline" className="font-normal">{source}</Badge>
                          <div className="flex items-center gap-2"><span className="font-mono">{count}</span><span className="text-muted-foreground">({qty})</span></div>
                        </div>
                      )
                    })}
                  </CardContent>
                </Card>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {}
        <div className="print-area hidden">
          <h2 className="text-xl font-bold mb-4">Журнал операций</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Дата</TableHead><TableHead>Время</TableHead><TableHead>Изделие</TableHead>
                <TableHead>Источник</TableHead><TableHead>Акт</TableHead><TableHead>Количество</TableHead>
                <TableHead>Акт несоответствия</TableHead><TableHead>Ремонт</TableHead><TableHead>Анализ</TableHead>
                <TableHead>Статус</TableHead><TableHead>К отгрузке</TableHead><TableHead>Отгружено (факт)</TableHead>
                <TableHead>Выходной контроль</TableHead><TableHead>Примечание</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEntries.map(entry => (
                <TableRow key={entry.id}>
                  <TableCell>{formatDate(entry.date)}</TableCell><TableCell>{entry.time}</TableCell><TableCell>{entry.product}</TableCell>
                  <TableCell>{entry.source || 'Склад'}</TableCell><TableCell>{entry.actNumber}</TableCell><TableCell>{entry.quantity}</TableCell>
                  <TableCell>{entry.mismatchAct || '-'}</TableCell><TableCell>{entry.repairQty ?? '-'}</TableCell><TableCell>{entry.analysisQty ?? 0}</TableCell>
                  <TableCell>{STATUS_CONFIG[entry.status]?.label}</TableCell>
                  <TableCell>{entry.plannedShipDate ? `${formatDate(entry.plannedShipDate)} ${entry.plannedShipTime}` : '-'}</TableCell>
                  <TableCell>{entry.actualShipDate ? `${formatDate(entry.actualShipDate)} ${entry.actualShipTime}` : '-'}</TableCell>
                  <TableCell>{entry.outputControlBy || '-'}</TableCell><TableCell>{entry.notes || '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </TooltipProvider>
  )
}

export type { JournalEntry, JournalStatus, ProductSummary }
export { STATUS_CONFIG }
