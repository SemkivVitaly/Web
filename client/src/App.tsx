/**
 * @fileoverview Корень клиента: восстановление сессии по JWT (`/api/me`), экран входа/регистрации или ленивый `ChatApp`.
 * Токен хранится через `api` (`getToken` / `setToken`).
 */

import { useState, useEffect, lazy, Suspense } from 'react';
import { api, getToken, setToken } from './api';
import type { User } from './types';

const ChatApp = lazy(() => import('./ChatApp'));

/** Маршрутизация «гость → форма авторизации → чат»; основной UI грузится отдельным чанком. */
export default function App() {
  const [me, setMe] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    // Гард от обновления состояния после unmount: запрос может завершиться уже после logout/перемонтирования.
    let cancelled = false;
    api<User>('/api/me')
      .then((u) => {
        if (!cancelled) setMe(u);
      })
      .catch(() => {
        if (cancelled) return;
        setToken(null);
        setMe(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onLogin(username: string, password: string) {
    setErr('');
    const r = await api<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      json: { username, password },
    });
    setToken(r.token);
    setMe(r.user);
  }

  async function onRegister(username: string, password: string, displayName: string) {
    setErr('');
    const r = await api<{ token: string; user: User }>('/api/auth/register', {
      method: 'POST',
      json: { username, password, displayName },
    });
    setToken(r.token);
    setMe(r.user);
  }

  function logout() {
    setToken(null);
    setMe(null);
  }

  if (loading) return <div className="login-page">Загрузка…</div>;

  if (!me) {
    return (
      <div className="lc-auth-screen">
        <div className="lc-auth-card">
          <div className="lc-auth-brand">
            <div className="lc-auth-brand-mark" aria-hidden>
              {/* Простая абстрактная эмблема (мессенджер в рамке LAN). */}
              <svg viewBox="0 0 32 32" width="28" height="28" role="img" aria-hidden>
                <defs>
                  <linearGradient id="lc-logo-g" x1="0" x2="1" y1="0" y2="1">
                    <stop offset="0%" stopColor="#6a95ff" />
                    <stop offset="100%" stopColor="#3558b9" />
                  </linearGradient>
                </defs>
                <rect x="2" y="4" width="28" height="22" rx="5" fill="url(#lc-logo-g)" />
                <path d="M9 13h14M9 17h10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                <path d="M10 26l4 4 1-4z" fill="#3558b9" />
              </svg>
            </div>
            <div className="lc-auth-brand-text">
              <h1 className="lc-auth-title">LocalChat</h1>
              <p className="lc-auth-tagline">Корпоративный мессенджер · только локальная сеть</p>
            </div>
          </div>
          <div className="lc-auth-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={authMode === 'login'}
              className={`lc-auth-tab${authMode === 'login' ? ' lc-auth-tab--active' : ''}`}
              onClick={() => setAuthMode('login')}
            >
              Вход
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={authMode === 'register'}
              className={`lc-auth-tab${authMode === 'register' ? ' lc-auth-tab--active' : ''}`}
              onClick={() => setAuthMode('register')}
            >
              Регистрация
            </button>
          </div>
          <form
            className="lc-auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const username = String(fd.get('username') || '');
              const password = String(fd.get('password') || '');
              const displayName = String(fd.get('displayName') || username);
              setErr('');
              (authMode === 'login' ? onLogin(username, password) : onRegister(username, password, displayName)).catch(
                (er: Error) => setErr(er.message)
              );
            }}
          >
            <div className="field">
              <label>Имя пользователя</label>
              <input name="username" required autoComplete="username" placeholder="ivanov" />
            </div>
            {authMode === 'register' && (
              <div className="field">
                <label>Отображаемое имя</label>
                <input name="displayName" required placeholder="Иван Иванов" />
              </div>
            )}
            <div className="field">
              <label>Пароль</label>
              <input
                name="password"
                type="password"
                required
                autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
              />
            </div>
            {err && <p className="error">{err}</p>}
            <button type="submit" className="primary lc-auth-submit">
              {authMode === 'login' ? 'Войти' : 'Создать профиль'}
            </button>
          </form>
          <p className="lc-auth-footnote">
            Сервер должен быть запущен внутри вашей локальной сети. Данные не покидают периметр компании.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="login-page">Загрузка интерфейса…</div>}>
      <ChatApp me={me} onLogout={logout} onMeUpdated={setMe} />
    </Suspense>
  );
}
