// Сервис-воркер PWA. Главное правило (выучено на ошибке прошлой версии):
// ДАННЫЕ НИКОГДА НЕ КЭШИРУЮТСЯ. Все запросы к /api/ идут только в сеть —
// журнал не может молча показать устаревшие данные из кэша.
// Кэшируется только оболочка: страницы (сеть → кэш как запасной вариант,
// чтобы сайт открывался без связи) и неизменяемая статика Next.js.
// Офлайн-данные живут в localStorage (снимок + очередь правок) — это
// зона ответственности приложения, не воркера.

const VERSION = 'uchet-v2'
const STATIC_CACHE = `${VERSION}-static`
const PAGE_CACHE = `${VERSION}-pages`

self.addEventListener('install', (event) => {
  self.skipWaiting()
  // предзагружаем страницы оболочки, чтобы офлайн работал с первого визита
  event.waitUntil(
    caches.open(PAGE_CACHE).then((cache) =>
      cache.addAll(['/', '/shop', '/login']).catch(() => {})
    )
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // данные — только сеть, воркер не вмешивается
  if (url.pathname.startsWith('/api/')) return

  // неизменяемая статика (хэшированные имена) и иконки — кэш прежде сети
  if (
    url.pathname.startsWith('/_next/static/') ||
    /^\/(icon-\d+\.png|logo\.svg|manifest\.webmanifest)$/.test(url.pathname)
  ) {
    event.respondWith((async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok) {
        const cache = await caches.open(STATIC_CACHE)
        cache.put(request, response.clone())
      }
      return response
    })())
    return
  }

  // переходы по страницам: сеть прежде кэша; без связи — последняя
  // сохранённая оболочка (данные страница возьмёт из localStorage)
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        if (response.ok) {
          const cache = await caches.open(PAGE_CACHE)
          cache.put(request, response.clone())
        }
        return response
      } catch {
        const cached = await caches.match(request)
        return cached || (await caches.match('/')) || Response.error()
      }
    })())
  }
})
