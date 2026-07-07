/**
 * @fileoverview HTTP-клиент для бэкенда LocalChat: JWT в `localStorage`, `fetch`, загрузка форм.
 *
 * В продакшене клиент и API обычно с одного origin (статика + прокси на Node). Тогда
 * {@link getApiOrigin} совпадает с URL страницы. В dev Vite проксирует `/api` на сервер.
 */

const TOKEN_KEY = 'localchat_token';
/** JWT: localStorage (Socket.IO) + httpOnly cookie (REST / same-origin media). */

const defaultFetchInit: RequestInit = { credentials: 'include' };

/** Текущий JWT после логина; `null`, если пользователь не авторизован. */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Сохраняет или удаляет токен. При `null` ключ убирается из `localStorage`.
 */
export function setToken(t: string | null) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * Origin страницы (`http://host:port` без пути) — база для относительных путей API и `/uploads`.
 */
export function getApiOrigin(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

/**
 * Собирает абсолютный URL: относительные пути с `/` префиксом клеятся к {@link getApiOrigin}.
 * Уже абсолютные `http(s)://` возвращаются без изменений.
 * Для `/api/files/*` добавляет JWT в query (нужно для `<img src>` без заголовка Authorization).
 */
export function resolveUrl(path: string): string {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const base = getApiOrigin();
  let full = path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
  if (full.includes('/api/files/')) {
    const token = getToken();
    if (token) {
      const sep = full.includes('?') ? '&' : '?';
      full = `${full}${sep}token=${encodeURIComponent(token)}`;
    }
  }
  return full;
}

/** URL миниатюры вложения для ленты; fallback — полный url. */
export function resolveAttachmentThumbUrl(a: { url: string; thumbUrl?: string | null }): string {
  return resolveUrl(a.thumbUrl || a.url);
}

/**
 * Нормализация `HeadersInit` (может прийти `Headers` / кортежи / объект) к plain-object, который удобно
 * мерджить с нашими служебными полями без сюрпризов регистра и дублирующихся ключей.
 */
function toHeaderRecord(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    const out: Record<string, string> = {};
    for (const [k, v] of h) out[k] = v;
    return out;
  }
  return { ...(h as Record<string, string>) };
}

/** Добавляет `Authorization: Bearer <token>`, если токен есть. */
function withAuth(headers: Record<string, string>): Record<string, string> {
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Разбор тела ответа. При невалидном JSON возвращает `{ error: text }`. */
async function parseResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

/** Формирует Error из неуспешного ответа: приоритет у `response.error`, fallback — `statusText`. */
function errorFromResponse(res: Response, data: unknown): Error {
  const msg = (data as { error?: string })?.error || res.statusText || `HTTP ${res.status}`;
  return new Error(msg);
}

/**
 * JSON-запрос с опциональным телом `init.json` и заголовком `Authorization: Bearer`.
 *
 * @param path — например `/api/me` или `/api/groups`
 * @param init — стандартный `RequestInit`; поле `json` сериализуется в тело и выставляет `Content-Type`
 * @throws Error с текстом из `response.error` или `statusText`, если `!res.ok`
 */
export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {}
): Promise<T> {
  const headers = withAuth(toHeaderRecord(init.headers));
  let body = init.body;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(resolveUrl(path), { ...defaultFetchInit, ...init, headers, body });
  const data = await parseResponseBody(res);
  if (!res.ok) throw errorFromResponse(res, data);
  return data as T;
}

/**
 * `multipart/form-data` (аватар, вложения в чат). Тело не трогаем — браузер сам выставит boundary.
 *
 * @param method — по умолчанию `POST`; для профиля используется `PATCH`
 */
export async function apiForm<T>(path: string, form: FormData, method: 'POST' | 'PATCH' = 'POST'): Promise<T> {
  const headers = withAuth({});
  const res = await fetch(resolveUrl(path), { ...defaultFetchInit, method, headers, body: form });
  const data = await parseResponseBody(res);
  if (!res.ok) throw errorFromResponse(res, data);
  return data as T;
}

/**
 * Та же семантика, что у {@link apiForm}, но через `XMLHttpRequest`: событие `upload.onprogress`
 * и отмена через стандартный `AbortSignal` (см. MDN: AbortSignal).
 *
 * @param opts.onProgress — доля `0…1` по байтам тела запроса (полезно для больших вложений)
 * @throws Error «Отменено» при `signal.abort()` или `xhr.abort()`
 */
export async function apiFormWithProgress<T>(
  path: string,
  form: FormData,
  opts: {
    method?: 'POST' | 'PATCH';
    signal?: AbortSignal;
    onProgress?: (ratio: number) => void;
  } = {}
): Promise<T> {
  const { method = 'POST', signal, onProgress } = opts;
  const token = getToken();
  const url = resolveUrl(path);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.withCredentials = true;
    xhr.open(method, url);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.responseType = 'json';

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(Math.min(1, ev.loaded / ev.total));
    };

    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) {
        reject(new Error('Отменено'));
        return;
      }
      signal.addEventListener('abort', onAbort);
    }

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    xhr.onload = () => {
      cleanup();
      const data = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }
      const err =
        data && typeof data === 'object' && data !== null && 'error' in data
          ? String((data as { error?: string }).error || xhr.statusText)
          : xhr.statusText;
      reject(new Error(err));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error('Ошибка сети'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new Error('Отменено'));
    };

    xhr.send(form);
  });
}
