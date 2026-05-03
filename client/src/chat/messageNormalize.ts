import type { Message } from '../types';

/**
 * Приводит сообщение к предсказуемому виду после ответа API или события сокета.
 *
 * Сервер может не присылать опциональные поля (`reactions`, `workspaceLinks` и т.д.).
 * Чтобы в UI не писать `m.reactions ?? []` в десятках мест, нормализуем один раз при
 * попадании сообщения в состояние React.
 *
 * @param m — сырое сообщение из API / Socket.IO
 * @returns Копия объекта с заполненными массивами и флагами по умолчанию
 */
export function normalizeLoadedMessage(m: Message): Message {
  return {
    ...m,
    reactions: m.reactions ?? [],
    importantForMe: m.importantForMe ?? false,
    workspaceLinks: m.workspaceLinks ?? [],
  };
}
