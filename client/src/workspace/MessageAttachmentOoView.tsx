/**
 * Просмотр вложения чата в OnlyOffice в той же оболочке, что и {@link CollabDocView} (шапка Office-like, без Yjs).
 */

import { useEffect, useState } from 'react';
import { api } from '../api';
import { OnlyOfficeDocEmbed } from './OnlyOfficeDocEmbed';

function shellKindFromFileName(fileName: string): 'word' | 'excel' {
  const lower = String(fileName || '').toLowerCase();
  if (/\.(xlsx|xls|csv|ods|fods)$/i.test(lower)) return 'excel';
  return 'word';
}

type OoConfigResp = { documentServerUrl: string; config: Record<string, unknown> };

export function MessageAttachmentOoView({
  attachmentId,
  fileName,
  ooMode = 'view',
  attachmentSource = 'message',
  onBack,
}: {
  attachmentId: number;
  fileName: string;
  /** `edit` — только если текущий пользователь автор сообщения (проверяется на сервере). */
  ooMode?: 'view' | 'edit';
  attachmentSource?: 'message' | 'announcement';
  onBack: () => void;
}) {
  const [session, setSession] = useState<OoConfigResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr('');
    setSession(null);
    void (async () => {
      try {
        const configPath =
          attachmentSource === 'announcement'
            ? `/api/announcement-attachments/${attachmentId}/onlyoffice/config`
            : `/api/message-attachments/${attachmentId}/onlyoffice/config`;
        const r = await api<OoConfigResp>(configPath, {
          method: 'POST',
          json: attachmentSource === 'announcement' ? {} : { mode: ooMode },
        });
        if (!alive) return;
        setSession(r);
      } catch (e) {
        if (!alive) return;
        setErr((e as Error).message || 'Не удалось открыть просмотр');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [attachmentId, ooMode, attachmentSource]);

  const sk = shellKindFromFileName(fileName);

  return (
    <div className={`lc-workspace-panel lc-office-shell lc-office-shell--${sk === 'excel' ? 'excel' : 'word'}`}>
      <header className="lc-mso-titlebar" role="banner">
        <div className="lc-mso-titlebar-left">
          <button type="button" className="lc-mso-back" onClick={onBack} title="Назад к чату">
            ←
          </button>
          <div className="lc-mso-titlebar-doc">
            <span className="lc-mso-titlebar-name">{fileName}</span>
            <span className="lc-mso-titlebar-sub">
              OnlyOffice · {attachmentSource === 'announcement' ? 'вложение объявления' : 'вложение из чата'} (
              {ooMode === 'edit' ? 'редактирование' : 'просмотр'})
            </span>
          </div>
        </div>
        <div className="lc-mso-titlebar-brand" aria-hidden>
          {sk === 'excel' ? 'X' : 'W'}
        </div>
      </header>
      {err ? <p className="error lc-office-shell-error">{err}</p> : null}
      {loading ? <p className="meta">Загрузка просмотра…</p> : null}
      {!loading && session ? (
        <div className="lc-onlyoffice-wrap">
          <OnlyOfficeDocEmbed
            documentServerUrl={session.documentServerUrl}
            config={session.config}
            docId={attachmentId}
            containerId={`lc-onlyoffice-chat-att-${attachmentId}`}
          />
        </div>
      ) : null}
    </div>
  );
}
