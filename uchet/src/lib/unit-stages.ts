import type { Role } from '@/lib/roles'

export interface UnitStage {
  key: 'accepted' | 'input_control' | 'in_progress' | 'output_control'
  byField: 'acceptedBy' | 'inputControlBy' | 'testedBy' | 'outputControlBy'
  atField: 'acceptedAt' | 'inputControlAt' | 'testedAt' | 'outputControlAt'
  label: string
  minRole: Role
}

export const UNIT_STAGES: UnitStage[] = [
  { key: 'accepted', byField: 'acceptedBy', atField: 'acceptedAt', label: 'Приёмка', minRole: 'senior' },
  { key: 'input_control', byField: 'inputControlBy', atField: 'inputControlAt', label: 'Входной контроль', minRole: 'tester' },
  { key: 'in_progress', byField: 'testedBy', atField: 'testedAt', label: 'Тестирование', minRole: 'tester' },
  { key: 'output_control', byField: 'outputControlBy', atField: 'outputControlAt', label: 'Выходной контроль', minRole: 'senior' },
]

export const stageForActStatus = (status: string): UnitStage | null =>
  UNIT_STAGES.find(s => s.key === status) ?? null

export const stageByKey = (key: string): UnitStage | null =>
  UNIT_STAGES.find(s => s.key === key) ?? null
