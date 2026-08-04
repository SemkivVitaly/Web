/// <reference types="bun-types" />
import { test, expect, describe } from 'bun:test'
import {
  ACT_STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  nextStep,
  statusFromExcel,
  initialDefectState,
  isResolvedDefectState,
} from './statuses'
import { atLeast, ROLE_ORDER } from './roles'

describe('матрица переходов статусов', () => {
  test('счастливый путь идёт по порядку до отгрузки', () => {
    expect(nextStep('accepted')).toBe('input_control')
    expect(nextStep('input_control')).toBe('in_progress')
    expect(nextStep('in_progress')).toBe('output_control')
    expect(nextStep('output_control')).toBe('ready_to_ship')
    expect(nextStep('ready_to_ship')).toBe('shipped')
  })

  test('отгружен — конечный статус', () => {
    expect(ALLOWED_TRANSITIONS.shipped).toEqual([])
    expect(nextStep('shipped')).toBeNull()
  })

  test('нельзя перескакивать этапы техпроцесса', () => {
    expect(canTransition('accepted', 'shipped')).toBe(false)
    expect(canTransition('accepted', 'in_progress')).toBe(false)
    expect(canTransition('input_control', 'output_control')).toBe(false)
  })

  test('доработка возвращает акт в работу', () => {
    expect(canTransition('output_control', 'in_progress')).toBe(true)
    expect(canTransition('ready_to_ship', 'in_progress')).toBe(true)
  })

  test('каждый статус из справочника присутствует в матрице', () => {
    for (const s of ACT_STATUSES) {
      expect(ALLOWED_TRANSITIONS[s]).toBeDefined()
    }
  })
})

describe('импорт статуса из Excel', () => {
  test('русские подписи распознаются без учёта регистра и пробелов', () => {
    expect(statusFromExcel('Принят')).toBe('accepted')
    expect(statusFromExcel('  входной   контроль ')).toBe('input_control')
    expect(statusFromExcel('ОТГРУЖЕНО')).toBe('shipped')
  })

  test('неизвестное значение не превращается в статус', () => {
    expect(statusFromExcel('абракадабра')).toBeNull()
    expect(statusFromExcel('')).toBeNull()
    expect(statusFromExcel(null)).toBeNull()
  })
})

describe('маршрутизация дефектов по виду', () => {
  test('аппаратная поломка едет в изолятор', () => {
    expect(initialDefectState('hardware')).toBe('isolator')
  })
  test('массовый ждёт решения', () => {
    expect(initialDefectState('mass')).toBe('awaiting_decision')
  })
  test('на анализ — к разработчику', () => {
    expect(initialDefectState('analysis')).toBe('on_analysis')
  })
  test('обычный дефект по умолчанию в ремонт', () => {
    expect(initialDefectState('new')).toBe('in_repair')
    expect(initialDefectState('repeated')).toBe('in_repair')
  })

  test('возврат и разрешённое отклонение закрывают дефект', () => {
    expect(isResolvedDefectState('returned')).toBe(true)
    expect(isResolvedDefectState('deviation_approved')).toBe(true)
    expect(isResolvedDefectState('in_repair')).toBe(false)
  })
})

describe('иерархия ролей', () => {
  test('старшинство: тестировщик < старший < начальник', () => {
    expect(ROLE_ORDER).toEqual(['tester', 'senior', 'boss'])
  })

  test('atLeast уважает старшинство', () => {
    expect(atLeast('boss', 'senior')).toBe(true)
    expect(atLeast('senior', 'senior')).toBe(true)
    expect(atLeast('tester', 'senior')).toBe(false)
    expect(atLeast('tester', 'tester')).toBe(true)
  })

  test('неизвестная роль не проходит проверку', () => {
    expect(atLeast('', 'tester')).toBe(false)
    expect(atLeast('guest', 'tester')).toBe(false)
  })
})
