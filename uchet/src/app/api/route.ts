/* __uchetGroupWrapped */
import { NextRequest, NextResponse } from "next/server";
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: NextRequest) {
  return withGroupFromRequest(request, async () => {
    return NextResponse.json({ message: "Hello, world!" });
  })
}
