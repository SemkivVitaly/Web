'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (id: string, config: unknown) => { destroyEditor: () => void } }
  }
}

export default function EditorPage() {
  const [state, setState] = useState<'loading' | 'disabled' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const editorRef = useRef<{ destroyEditor: () => void } | null>(null)

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      try {
        const res = await fetch('/api/onlyoffice/config')
        const json = await res.json()
        if (cancelled) return
        if (!json.success || !json.data.enabled) {
          setState('disabled')
          return
        }
        const { config } = json.data

        const dsUrl = json.data.dsUrl || `${location.protocol}//${location.hostname}:8080`

        await new Promise<void>((resolve, reject) => {
          if (window.DocsAPI) return resolve()
          const script = document.createElement('script')
          script.src = `${dsUrl}/web-apps/apps/api/documents/api.js`
          script.onload = () => resolve()
          script.onerror = () => reject(new Error(`Document Server недоступен: ${dsUrl}`))
          document.head.appendChild(script)
        })
        if (cancelled) return
        if (!window.DocsAPI) throw new Error('api.js загрузился, но DocsAPI не найден')

        editorRef.current = new window.DocsAPI.DocEditor('onlyoffice-editor', config)
        setState('ready')
      } catch (e) {
        if (!cancelled) {
          setState('error')
          setMessage(e instanceof Error ? e.message : String(e))
        }
      }
    }
    init()

    return () => {
      cancelled = true
      editorRef.current?.destroyEditor()
    }
  }, [])

  return (
    <div className="h-screen flex flex-col">
      <header className="h-12 border-b flex items-center gap-3 px-4 shrink-0">
        <Link href="/" className="text-sm font-semibold hover:underline">← Производственный учёт</Link>
        <span className="text-sm text-muted-foreground">Журнал — совместное редактирование</span>
      </header>

      {state === 'loading' && (
        <p className="p-6 text-sm text-muted-foreground">Загрузка редактора…</p>
      )}
      {state === 'disabled' && (
        <div className="p-6 max-w-xl space-y-3 text-sm">
          <h1 className="text-lg font-semibold">Редактор не настроен</h1>
          <p className="text-muted-foreground">
            Для совместного редактирования журнала в браузере нужен OnlyOffice
            Document Server. Разверните его и задайте переменные окружения:
          </p>
          <pre className="rounded-md border bg-muted/40 p-3 text-xs overflow-x-auto">{`# Document Server (однократно, на том же сервере):
docker run -d --name onlyoffice -p 8080:80 \\
  -e JWT_SECRET=ВАШ_СЕКРЕТ onlyoffice/documentserver

# Переменные приложения (docker-compose.yml или перед запуском):
ONLYOFFICE_URL=http://АДРЕС-СЕРВЕРА:8080
APP_URL=http://АДРЕС-СЕРВЕРА:3000
ONLYOFFICE_JWT_SECRET=ВАШ_СЕКРЕТ`}</pre>
          <p className="text-muted-foreground">
            После перезапуска эта страница превратится в полноценную таблицу
            с одновременным редактированием. Пока работает синхронизация
            через общий файл — ничего не потеряно.
          </p>
        </div>
      )}
      {state === 'error' && (
        <div className="p-6 text-sm">
          <p className="text-red-600 dark:text-red-400 font-medium">Ошибка: {message}</p>
          <p className="text-muted-foreground mt-2">
            Проверьте, что Document Server запущен и доступен из браузера.
          </p>
        </div>
      )}

      <div id="onlyoffice-editor" className="flex-1" />
    </div>
  )
}
