import { errMsg } from '@/lib/api-err'
import { NextRequest, NextResponse } from 'next/server'
import { withGroupDb } from '@/lib/db'
import { setAuthCookies, upsertEmployeeFromChat } from '@/lib/auth'
import { ROLE_LABELS } from '@/lib/roles'
import { chatSsoEnabled, chatEnv, resolveChatUser } from '@/lib/chat-sso'
import { readGroupId, GROUP_COOKIE } from '@/lib/group-context'

/* __uchetGroupWrapped */

export async function POST(request: NextRequest) {
  if (!chatSsoEnabled()) {
    return NextResponse.json(
      { success: false, error: 'Вход через чат не настроен (CHAT_URL)' },
      { status: 404 },
    )
  }
  try {
    let body: { groupId?: string; token?: string } = {}
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const token =
      body.token ||
      request.cookies.get('localchat_token')?.value ||
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) {
      return NextResponse.json(
        {
          success: false,
          error: 'Сначала войдите в чат — учёт использует его вход',
          needChatLogin: true,
        },
        { status: 401 },
      )
    }

    const groupId =
      String(body.groupId || '').trim() ||
      readGroupId(request) ||
      chatEnv().groupId
    if (!groupId) {
      return NextResponse.json(
        { success: false, error: 'Не указана группа чата для точки сбора' },
        { status: 400 },
      )
    }

    const chatUser = await resolveChatUser(token, groupId)
    if (!chatUser) {
      const { groupName } = chatEnv()
      return NextResponse.json(
        {
          success: false,
          error: `Нет доступа: вы не состоите в этой группе чата («${groupName}», id ${groupId})`,
        },
        { status: 403 },
      )
    }

    const emp = await withGroupDb(groupId, () => upsertEmployeeFromChat(chatUser))

    const res = NextResponse.json({
      success: true,
      data: { code: emp.code, name: emp.name, role: emp.role, groupId },
      message: `${emp.code} · ${emp.name} (${ROLE_LABELS[emp.role as keyof typeof ROLE_LABELS] || emp.role})`,
    })
    setAuthCookies(res, emp, groupId)
    res.cookies.set(GROUP_COOKIE, String(groupId), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 3600,
    })
    return res
  } catch (e) {
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 })
  }
}
