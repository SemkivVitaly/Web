/**
 * @fileoverview Express middleware для защищённых маршрутов API: Bearer JWT, httpOnly cookie или query `token`.
 */

import { verifyToken } from './auth.js';
import { readAuthCookie } from './authCookie.js';

/**
 * @param {import('express').Request} req
 * @returns {string | null}
 */
export function extractAuthToken(req) {
  const h = req.headers.authorization;
  const bearer = h?.startsWith('Bearer ') ? h.slice(7) : null;
  const q = typeof req.query?.token === 'string' ? req.query.token : null;
  return bearer || readAuthCookie(req) || q || null;
}

/**
 * Проверяет JWT; при успехе выставляет `req.userId` и вызывает `next()`.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireAuth(req, res, next) {
  const token = extractAuthToken(req);
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
  const payload = verifyToken(token);
  if (!payload?.userId) return res.status(401).json({ error: 'Недействительный токен' });
  req.userId = payload.userId;
  next();
}
