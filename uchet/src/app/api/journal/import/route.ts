/* __uchetGroupWrapped */
import { errMsg } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { importJournalWorkbook } from '@/lib/journal-excel'
import { requireRole } from '@/lib/auth'
import { withGroupFromRequest } from '@/lib/group-context'

export async function POST(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  const auth = await requireRole(request, 'senior')
  if ('response' in auth) return auth.response
  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'Приложите файл .xlsx (поле "file")' }, { status: 400 })
    }
    const buffer = Buffer.from(await file.arrayBuffer())
    const result = await importJournalWorkbook(buffer)
    return NextResponse.json({
      success: true,
      data: result,
      message: `Импорт: +${result.created} новых, ~${result.updated} обновлено, ${result.skipped} пропущено`,
    })
  } catch (error) {
    console.error('Journal import error:', error)
    return NextResponse.json({ success: false, error: errMsg(error, 'Ошибка импорта') }, { status: 500 })
  }
  })
}
