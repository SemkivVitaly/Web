/**
 * @fileoverview httpOnly cookie для JWT-сессии (дополняет Bearer / localStorage на клиенте).
 */

export const AUTH_COOKIE_NAME = 'localchat_token';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Secure flag only when explicitly enabled (plain HTTP LAN must not set Secure). */
function cookieSecure() {
  const v = (process.env.COOKIE_SECURE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {import('express').Response} res
 * @param {string} token
 */
export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

/** @param {import('express').Response} res */
export function clearAuthCookie(res) {
  res.cookie(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    maxAge: 0,
    path: '/',
  });
}

/**
 * @param {import('express').Request} req
 * @returns {string | null}
 */
export function readAuthCookie(req) {
  const v = req.cookies?.[AUTH_COOKIE_NAME];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
