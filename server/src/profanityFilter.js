/**
 * @fileoverview Маскировка нецензурной лексики для ответов API: по полному слову (словарь) и по префиксам-корням (≥4 символов).
 * Токены — последовательности букв/цифр (Unicode `\p{L}\p{N}`); замена ограничена по длине звёздочек.
 * Используется вместе с `moderation.shouldMaskGroupTextForViewer`.
 */
const BAD_WORDS = new Set(
  [
    'дурак',
    'дура',
    'идиот',
    'идиотка',
    'кретин',
    'мразь',
    'ублюдок',
    'сука',
    'суки',
    'блядь',
    'блять',
    'хуй',
    'хуйня',
    'пизда',
    'пиздец',
    'ебан',
    'ебать',
    'ёбан',
    'ёбать',
    'заебал',
    'мудак',
    'мудила',
    'гнида',
    'сволочь',
    'тварь',
    'урод',
    'дебил',
    'козёл',
    'козел',
    'пидор',
    'пидарас',
    'fuck',
    'shit',
  ].map((w) => w.toLowerCase())
);

/** Корни (≥4 символа): склонения и производные, целое слово не в словаре */
const BAD_ROOTS = [
  'пизд',
  'бляд',
  'хуй',
  'хуё',
  'хуе',
  'ебан',
  'ёбан',
  'ебёт',
  'ёбёт',
  'ебет',
  'ебен',
  'муда',
  'гонд',
  'свол',
  'мраз',
  'крет',
  'идиот',
  'дебил',
  'урод',
  'твар',
  'гнид',
  'шлюх',
].map((w) => w.toLowerCase());

/**
 * @param {string | null | undefined} text
 * @returns {string | null | undefined} исходный тип, если не строка
 */
export function maskProfanity(text) {
  if (text == null || typeof text !== 'string') return text;
  return text.replace(/[\p{L}\p{N}]+/gu, (word) => {
    const low = word.toLocaleLowerCase('ru-RU');
    if (BAD_WORDS.has(low)) return '*'.repeat(Math.min(word.length, 12));
    for (const root of BAD_ROOTS) {
      if (low.length >= root.length && low.startsWith(root))
        return '*'.repeat(Math.min(word.length, 12));
    }
    return word;
  });
}
