export const ACT_STATUSES = [
  'accepted',
  'input_control',
  'in_progress',
  'output_control',
  'ready_to_ship',
  'shipped',
] as const

export type ActStatus = (typeof ACT_STATUSES)[number]

export const STATUS_LABELS: Record<string, string> = {
  accepted: 'Принят',
  input_control: 'Входной контроль',
  in_progress: 'В работе',
  stopped: 'Остановлен',
  output_control: 'Выходной контроль',
  ready_to_ship: 'К отгрузке',
  shipped: 'Отгружен',

  created: 'Создан (уст.)',
  completed: 'Завершён (уст.)',
  cancelled: 'Отменён',
}

export function statusFromExcel(raw: unknown): ActStatus | null {
  const key = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  const map: Record<string, ActStatus> = {
    'принят': 'accepted',
    'входной контроль': 'input_control',
    'в работе': 'in_progress',

    'выходной контроль': 'output_control',
    'к отгрузке': 'ready_to_ship',
    'отгружен': 'shipped',
    'отгружено': 'shipped',
  }
  return map[key] ?? null
}

export const DEFECT_KINDS: Record<string, string> = {
  new: 'Новый',
  repeated: 'Уже был',
  mass: 'Массовый',
  hardware: 'Аппаратная поломка',
  analysis: 'На анализ',
}

export const DEFECT_STATES: Record<string, string> = {
  in_repair: 'В ремонте',
  isolator: 'Изолятор',
  on_analysis: 'На анализе (у разработчика)',
  awaiting_decision: 'Ожидает решения',
  returned: 'Возвращён в акт',
  deviation_approved: 'Отклонение разрешено',
}

export const RESOLVED_DEFECT_STATES = ['returned', 'deviation_approved'] as const
export const isResolvedDefectState = (s: string): boolean =>
  (RESOLVED_DEFECT_STATES as readonly string[]).includes(s)

export function initialDefectState(kind: string): string {
  if (kind === 'hardware') return 'isolator'
  if (kind === 'mass') return 'awaiting_decision'
  if (kind === 'analysis') return 'on_analysis'
  return 'in_repair'
}

export const ALLOWED_TRANSITIONS: Record<string, ActStatus[]> = {
  accepted: ['input_control'],
  input_control: ['in_progress'],
  in_progress: ['output_control'],
  output_control: ['ready_to_ship', 'in_progress'],
  ready_to_ship: ['shipped', 'in_progress'],
  shipped: [],
}

export function canTransition(from: string, to: string): boolean {
  const allowed = ALLOWED_TRANSITIONS[from]

  if (!allowed) return (ACT_STATUSES as readonly string[]).includes(to)
  return (allowed as string[]).includes(to)
}

export function nextStep(from: string): ActStatus | null {
  return ALLOWED_TRANSITIONS[from]?.[0] ?? null
}
