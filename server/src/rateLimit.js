/**
 * @fileoverview Простой лимит запросов в памяти процесса (без Redis): скользящее окно по произвольному ключу из `req`.
 * При превышении — HTTP 429 и заголовок `Retry-After` (секунды до сброса счётчика).
 */

/**
 * @param {{ windowMs: number, max: number, keyFn: (req: import('express').Request) => string }} opts
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter({ windowMs, max, keyFn }) {
  const buckets = new Map();
  return function rateLimitMiddleware(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Слишком много запросов. Подождите немного.' });
    }
    next();
  };
}
