/* __uchetGroupWrapped */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

const startedAt = Date.now()

export async function GET() {
  let dbOk = false
  let acts = -1
  try {
    acts = await db.act.count()
    dbOk = true
  } catch {
    /* ignore */
  }
  return NextResponse.json(
    {
      ok: dbOk,
      db: dbOk,
      acts,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
    },
    { status: dbOk ? 200 : 503 },
  )
}
