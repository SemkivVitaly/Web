export const errMsg = (e: unknown, fallback = 'Ошибка'): string =>
  e instanceof Error && e.message ? e.message : fallback

export const errCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code?: unknown }).code)
    : undefined

export const isUserError = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'userError' in e &&
  Boolean((e as { userError?: unknown }).userError)
