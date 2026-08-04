import { NextRequest, NextResponse } from 'next/server'
import { documentKey, getOnlyOfficeEnv, onlyOfficeEnabled, signJwt } from '@/lib/onlyoffice'
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
  if (!onlyOfficeEnabled()) {
    return NextResponse.json({ success: true, data: { enabled: false } })
  }
  const { dsUrl, appUrl, secret } = getOnlyOfficeEnv()
  const key = await documentKey()

  const config: Record<string, unknown> = {
    documentType: 'cell',
    document: {
      fileType: 'xlsx',
      key,
      title: 'Журнал производства.xlsx',
      url: `${appUrl}/api/onlyoffice/document`,
      permissions: { edit: true, download: true, print: true },
    },
    editorConfig: {
      lang: 'ru',
      mode: 'edit',
      callbackUrl: `${appUrl}/api/onlyoffice/callback`,
      customization: {
        autosave: true,
        forcesave: true,
        compactHeader: true,
      },
    },
  }
  if (secret) {
    config.token = signJwt(config, secret)
  }

  return NextResponse.json({ success: true, data: { enabled: true, dsUrl, config } })
  })
}
