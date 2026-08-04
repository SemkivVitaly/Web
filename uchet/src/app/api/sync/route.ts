import { NextRequest, NextResponse } from 'next/server'
import { getSyncState } from '@/lib/folder-sync'
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
    return NextResponse.json({ success: true, data: getSyncState() })
  })
}
