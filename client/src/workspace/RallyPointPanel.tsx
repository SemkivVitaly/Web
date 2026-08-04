/**
 * Вкладка «Точка сбора»: iframe сервиса учёта с SSO по JWT LocalChat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getToken } from '../api';

const MSG_SSO = 'localchat-uchet-sso';
const MSG_READY = 'localchat-uchet-ready';

function uchetOrigin(): string {
  const fromEnv = (import.meta.env.VITE_UCHET_URL as string | undefined)?.replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location;
    const port = (import.meta.env.VITE_UCHET_PORT as string | undefined) || '3000';
    return `${protocol}//${hostname}:${port}`;
  }
  return 'http://localhost:3000';
}

export function RallyPointPanel(props: { groupId: number }) {
  const { groupId } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Подключение…');
  const origin = useMemo(() => uchetOrigin(), []);
  const src = useMemo(() => `${origin}/embed?groupId=${groupId}`, [origin, groupId]);

  const sendSso = useCallback(() => {
    const token = getToken();
    const win = iframeRef.current?.contentWindow;
    if (!token) {
      setError('Нет сессии чата — войдите снова');
      return;
    }
    if (!win) return;
    try {
      win.postMessage({ type: MSG_SSO, token, groupId }, origin);
      setStatus('Вход в точку сбора…');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось передать сессию');
    }
  }, [groupId, origin]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== origin) return;
      if (ev.data?.type === MSG_READY) {
        sendSso();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, sendSso]);

  // Повтор при смене группы — новый iframe src
  useEffect(() => {
    setStatus('Подключение…');
    setError(null);
  }, [groupId]);

  return (
    <div className="lc-rally-point">
      {(error || status) && (
        <div className="lc-rally-point-bar" role="status">
          {error ? <span className="lc-rally-point-error">{error}</span> : <span className="meta">{status}</span>}
          {error && (
            <button type="button" className="primary" onClick={sendSso}>
              Повторить
            </button>
          )}
        </div>
      )}
      <iframe
        ref={iframeRef}
        key={groupId}
        className="lc-rally-point-frame"
        title="Точка сбора"
        src={src}
        onLoad={() => {
          setStatus('');
          // На случай если ready уже ушёл до подписки
          window.setTimeout(sendSso, 50);
        }}
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
