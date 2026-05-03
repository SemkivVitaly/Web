/**
 * @fileoverview Express middleware для защищённых маршрутов API: заголовок `Authorization: Bearer <JWT>`, запись `req.userId`.
 */

import { verifyToken } from './auth.js';

/**
 * Проверяет JWT из `Authorization`; при успехе выставляет `req.userId` и вызывает `next()`.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  const payload = verifyToken(token);
  if (!payload?.userId) return res.status(401).json({ error: 'Недействительный токен' });
  req.userId = payload.userId;
  next();
}
