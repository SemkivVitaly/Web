export type Role = 'tester' | 'senior' | 'boss'

/** Роли учёта = роли группы LocalChat (коды прежние, подписи как в чате). */
export const ROLE_LABELS: Record<Role, string> = {
  tester: 'Участник',
  senior: 'Модератор',
  boss: 'Администратор',
}

export const ROLE_ORDER: Role[] = ['tester', 'senior', 'boss']
export const atLeast = (role: string, min: Role): boolean =>
  ROLE_ORDER.indexOf(role as Role) >= ROLE_ORDER.indexOf(min)
