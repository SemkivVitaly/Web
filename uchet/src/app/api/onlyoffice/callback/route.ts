/* __uchetGroupWrapped */
import { NextRequest, NextResponse } from 'next/server'
import { importJournalWorkbook } from '@/lib/journal-excel'
import { getOnlyOfficeEnv, onlyOfficeEnabled, verifyJwt } from '@/lib/onlyoffice'
import { withGroupFromRequest } from '@/lib/group-context'

export async function POST(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  if (!onlyOfficeEnabled()) {
    return NextResponse.json({ error: 1 }, { status: 404 })
  }
  try {
    const body = await request.json()
    const { secret } = getOnlyOfficeEnv()
    if (secret) {
      const auth = request.headers.get('authorization') || ''
      const headerToken = auth.replace(/^Bearer\s+/i, '')
      const token = body.token || headerToken
      if (!token || !verifyJwt(token, secret)) {
        return NextResponse.json({ error: 1, message: 'Недействительный токен' }, { status: 403 })
      }
    } else {

      return NextResponse.json({ error: 1, message: 'Задайте ONLYOFFICE_JWT_SECRET' }, { status: 403 })
    }

    const status = body.status as number
    const isSave = (status === 2 || status === 6) && body.url

    if (isSave) {
      try {
        const url = new URL(String(body.url))
        const allowedHosts = new Set([
          ...[process.env.ONLYOFFICE_URL, process.env.ONLYOFFICE_INTERNAL_URL, 'http://onlyoffice']
            .filter(Boolean)
            .map(u => { try { return new URL(u as string).hostname } catch { return '' } })
            .filter(Boolean),

          ...String(process.env.ONLYOFFICE_ALLOWED_HOSTS || '')
            .split(',').map(h => h.trim()).filter(Boolean),
        ])
        const schemeOk = url.protocol === 'http:' || url.protocol === 'https:'
        if (!schemeOk || (allowedHosts.size > 0 && !allowedHosts.has(url.hostname))) {
          return NextResponse.json({ error: 1, message: 'Недопустимый адрес документа' }, { status: 403 })
        }
        const res = await fetch(url)
        if (!res.ok) throw new Error(`не удалось скачать документ: ${res.status}`)
        const buffer = Buffer.from(await res.arrayBuffer())
        const result = await importJournalWorkbook(buffer)
        console.log(`[onlyoffice] сохранение импортировано: +${result.created}, ~${result.updated}`)
      } catch (e) {
        console.error('[onlyoffice] не удалось сохранить документ:', e)
        return NextResponse.json({
          error: 1,
          message: e instanceof Error ? e.message : 'Ошибка сохранения',
        })
      }
    }

    return NextResponse.json({ error: 0 })
  } catch (e) {
    console.error('[onlyoffice] callback error:', e)
    return NextResponse.json({ error: 1, message: 'Ошибка обработки' })
  }
  })
}
