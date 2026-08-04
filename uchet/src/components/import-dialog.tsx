'use client'

import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Upload, FileSpreadsheet, CheckCircle2, XCircle, AlertCircle, Loader2, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'

interface ImportResult {
  success: boolean
  message: string
  imported?: number
  errors?: string[]
}

interface ImportDialogProps {
  onImportComplete?: () => void
}

export function ImportDialog({ onImportComplete }: ImportDialogProps) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string>('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) {
      if (selectedFile.size > 5 * 1024 * 1024) {
        toast.error('Файл слишком большой (макс. 5 МБ)')
        return
      }

      setFile(selectedFile)
      setResult(null)

      if (/\.xlsx?$/i.test(selectedFile.name)) {
        setPreview('')
        return
      }
      const reader = new FileReader()
      reader.onload = (event) => {
        const content = (event.target?.result ?? '') as string
        setPreview(content.substring(0, 1000) + (content.length > 1000 ? '\n...' : ''))
      }
      reader.readAsText(selectedFile)
    }
  }

  const handleImport = async () => {
    if (!file) return

    setImporting(true)

    try {

      if (/\.xlsx?$/i.test(file.name)) {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch('/api/journal/import', { method: 'POST', body: form })
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json.error || 'Ошибка импорта')
        setResult({
          success: true,
          message: json.message,
          imported: (json.data?.created ?? 0) + (json.data?.updated ?? 0),
        })
        onImportComplete?.()
        toast.success(`✅ ${json.message}`)
        return
      }

      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = (e) => resolve((e.target?.result ?? '') as string)
        reader.onerror = () => reject(new Error('Не удалось прочитать файл'))
        reader.readAsText(file)
      })

      const lines = content.split('\n').filter(line => line.trim())
      if (lines.length < 2) {
        throw new Error('Файл пустой или некорректный')
      }

      const headers = lines[0].split(';').map(h => h.trim().replace(/^"|"$/g, ''))

      const requiredHeaders = ['Номер акта', 'Дата', 'Тип', 'Количество']
      const missingHeaders = requiredHeaders.filter(h =>
        !headers.some(header => header.toLowerCase().includes(h.toLowerCase()))
      )

      if (missingHeaders.length > 0 && !headers.includes('actNumber')) {
        throw new Error(`Отсутствуют обязательные столбцы: ${missingHeaders.join(', ')}`)
      }

      let imported = 0
      const errors: string[] = []

      for (let i = 1; i < Math.min(lines.length, 2001); i++) {
        try {
          const values = lines[i].split(';').map(v => v.trim().replace(/^"|"$/g, ''))

          if (values.length < 3) continue

          const actData: Record<string, any> = {
            actNumber: values[0] || undefined,
            actDate: values[1] || new Date().toLocaleDateString('sv'),
            actTime: values.length > 6 ? values[6] : new Date().toTimeString().slice(0, 5),
            actType: values[2] || 'Не указано',
            quantity: parseInt(values[3]) || 1,
            status: 'accepted',
          }

          const res = await fetch('/api/acts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(actData),
          })

          if (res.ok) imported++
          else errors.push(`Строка ${i + 1}: Ошибка создания`)

        } catch (err) {
          errors.push(`Строка ${i + 1}: ${err instanceof Error ? err.message : 'Ошибка парсинга'}`)
        }
      }

      setResult({
        success: errors.length === 0,
        message: `Импорт завершён: ${imported} записей создано${errors.length > 0 ? `, ${errors.length} ошибок` : ''}`,
        imported,
        errors: errors.length > 0 ? errors : undefined,
      })

      onImportComplete?.()
      toast.success(`✅ Импортировано ${imported} актов`)

    } catch (error) {
      setResult({
        success: false,
        message: error instanceof Error ? error.message : 'Ошибка импорта',
        errors: [],
      })
      toast.error('❌ Ошибка импорта')
    } finally {
      setImporting(false)
    }
  }

  const handleClose = () => {
    setOpen(false)
    setTimeout(() => {
      setFile(null)
      setPreview('')
      setResult(null)
    }, 200)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); setOpen(v) }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Upload className="h-4 w-4" />
          Импорт
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-primary" />
            Импорт данных из CSV/Excel
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {}
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer hover:bg-muted/50 ${
              file ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
            }`}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls,.txt"
              onChange={handleFileChange}
              className="hidden"
            />

            {!file ? (
              <>
                <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-medium">Выберите файл для импорта</p>
                <p className="text-sm text-muted-foreground mt-1">
                  общий Excel-журнал участка (.xlsx) — импорт без дублей; также CSV/TXT (разделитель ;)
                </p>
                <Badge variant="secondary" className="mt-3">Макс. размер: 5 МБ</Badge>
              </>
            ) : (
              <>
                <FileSpreadsheet className="h-12 w-12 mx-auto mb-4 text-primary" />
                <p className="text-lg font-medium">{file.name}</p>
                <p className="text-sm text-muted-foreground">
                  {(file.size / 1024).toFixed(1)} КБ • {file.type || 'CSV'}
                </p>
              </>
            )}
          </div>

          {}
          {preview && (
            <>
              <Separator />
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  Предпросмотр файла (первые 500 строк)
                </Label>
                <ScrollArea className="h-40 rounded-md border bg-muted/30 p-3 font-mono text-xs">
                  {preview.split('\n').slice(0, 15).map((line, i) => (
                    <div key={i} className="flex">
                      <span className="w-8 text-muted-foreground">{i + 1}</span>
                      <span>{line}</span>
                    </div>
                  ))}
                </ScrollArea>
              </div>
            </>
          )}

          {}
          {result && (
            <>
              <Separator />
              <div className={`p-4 rounded-xl ${
                result.success
                  ? 'bg-green-500/10 border border-green-500/20'
                  : 'bg-red-500/10 border border-red-500/20'
              }`}>
                <div className="flex items-start gap-3">
                  {result.success ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p className="font-medium">{result.message}</p>
                    {result.imported !== undefined && (
                      <p className="text-sm text-muted-foreground mt-1">
                        Создано документов: {result.imported}
                      </p>
                    )}

                    {result.errors && result.errors.length > 0 && (
                      <details className="mt-2">
                        <summary className="text-sm text-red-600 cursor-pointer">
                          Показать ошибки ({result.errors.length})
                        </summary>
                        <ul className="mt-2 space-y-1 text-xs text-red-600/80 pl-4">
                          {result.errors.slice(0, 10).map((err, i) => (
                            <li key={i}>{err}</li>
                          ))}
                          {result.errors.length > 10 && (
                            <li className="italic">...и ещё {result.errors.length - 10}</li>
                          )}
                        </ul>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {}
          <div className="flex justify-between items-center pt-2">
            <Button variant="ghost" onClick={handleClose}>
              Отмена
            </Button>
            <Button
              onClick={handleImport}
              disabled={!file || importing}
              className="gap-2"
            >
              {importing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Импорт...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  Начать импорт
                </>
              )}
            </Button>
          </div>

          {}
          <details className="group">
            <summary className="text-sm text-muted-foreground cursor-pointer flex items-center gap-2 py-2">
              <AlertCircle className="h-4 w-4" />
              Формат файла CSV
              <ChevronDown className="h-3 w-3 group-open:rotate-180 transition-transform" />
            </summary>
            <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg space-y-2">
              <p><strong>Обязательные столбцы:</strong></p>
              <p>Номер акта; Дата; Тип; Количество</p>
              <p className="mt-2"><strong>Пример строки:</strong></p>
              <code className="block p-2 bg-background rounded">
                ACT-001;2026-07-31;Bridge;150
              </code>
              <p className="mt-2">
                В столбце «Тип» указывается название изделия — если его нет в
                справочнике, оно создаётся автоматически. Столбец «Статус» не
                читается: акты импортируются со статусом «Принят» и дальше идут
                по техпроцессу. Для сводного журнала участка (.xlsx) используйте
                импорт Excel — колонки распознаются автоматически.
              </p>
            </div>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ScrollArea({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={className} style={{ overflowY: 'auto', maxHeight: 'inherit' }}>
      {children}
    </div>
  )
}
