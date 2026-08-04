/* __uchetGroupWrapped */
import { NextRequest, NextResponse } from 'next/server'
import { buildJournalWorkbook } from '@/lib/journal-excel'
import { getOnlyOfficeEnv, onlyOfficeEnabled, verifyJwt } from '@/lib/onlyoffice'
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  if (!onlyOfficeEnabled()) {
    return NextResponse.json({ success: false, error: 'OnlyOffice не настроен' }, { status: 404 })
  }
  const { secret } = getOnlyOfficeEnv()
  if (secret) {
    const auth = request.headers.get('authorization') || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    if (!token || !verifyJwt(token, secret)) {
      return NextResponse.json({ success: false, error: 'Недействительный токен' }, { status: 403 })
    }
  }

  const wb = await buildJournalWorkbook()
  const buffer = await wb.xlsx.writeBuffer()
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="journal.xlsx"',
    },
  })
  })
}
