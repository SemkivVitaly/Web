/**
 * @fileoverview Внутренние модальные окна вместо нативных браузерных `alert` / `confirm` / `prompt`.
 *
 * Императивный API (`uiAlert`, `uiConfirm`, `uiPrompt`) возвращает промисы и может вызываться откуда угодно
 * (в т.ч. вне React-компонентов). Один экземпляр `<DialogHost />` монтируется в корне приложения и рисует
 * очередь запросов по одному. Оформление переиспользует классы `.modal-backdrop` / `.modal`.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

type AlertOptions = { title?: string; okText?: string };
type ConfirmOptions = {
  title?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
};
type PromptOptions = {
  title?: string;
  defaultValue?: string;
  placeholder?: string;
  okText?: string;
  cancelText?: string;
  multiline?: boolean;
  /** Разрешить пустую строку как валидный ответ. По умолчанию пустая строка допустима. */
  allowEmpty?: boolean;
};

type DialogRequest =
  | {
      id: number;
      kind: 'alert';
      message: string;
      title?: string;
      okText?: string;
      resolve: () => void;
    }
  | {
      id: number;
      kind: 'confirm';
      message: string;
      title?: string;
      okText?: string;
      cancelText?: string;
      danger?: boolean;
      resolve: (ok: boolean) => void;
    }
  | {
      id: number;
      kind: 'prompt';
      message: string;
      title?: string;
      defaultValue?: string;
      placeholder?: string;
      okText?: string;
      cancelText?: string;
      multiline?: boolean;
      allowEmpty?: boolean;
      resolve: (value: string | null) => void;
    };

let queue: DialogRequest[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot() {
  return queue;
}

function push(req: DialogRequest) {
  queue = [...queue, req];
  emit();
}

function resolveCurrent(id: number) {
  queue = queue.filter((q) => q.id !== id);
  emit();
}

/** Информационное окно с одной кнопкой. */
export function uiAlert(message: string, opts: AlertOptions = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    push({ id: ++seq, kind: 'alert', message, title: opts.title, okText: opts.okText, resolve });
  });
}

/** Окно подтверждения. Резолвится `true` при подтверждении, `false` при отмене/закрытии. */
export function uiConfirm(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    push({
      id: ++seq,
      kind: 'confirm',
      message,
      title: opts.title,
      okText: opts.okText,
      cancelText: opts.cancelText,
      danger: opts.danger,
      resolve,
    });
  });
}

/** Окно ввода строки. Резолвится введённым значением или `null` при отмене. */
export function uiPrompt(message: string, opts: PromptOptions = {}): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    push({
      id: ++seq,
      kind: 'prompt',
      message,
      title: opts.title,
      defaultValue: opts.defaultValue,
      placeholder: opts.placeholder,
      okText: opts.okText,
      cancelText: opts.cancelText,
      multiline: opts.multiline,
      allowEmpty: opts.allowEmpty,
      resolve,
    });
  });
}

/** Рендерит текущее (первое в очереди) диалоговое окно. Монтируется один раз в корне. */
export function DialogHost() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const current = snapshot[0] ?? null;
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (current && current.id !== lastIdRef.current) {
      lastIdRef.current = current.id;
      if (current.kind === 'prompt') {
        setInputValue(current.defaultValue ?? '');
      }
      // Автофокус на поле/кнопке после появления окна.
      const t = window.setTimeout(() => {
        if (current.kind === 'prompt') {
          const el = current.multiline ? textareaRef.current : inputRef.current;
          el?.focus();
          if (el && 'select' in el) el.select();
        }
      }, 30);
      return () => window.clearTimeout(t);
    }
    if (!current) lastIdRef.current = null;
  }, [current]);

  const finishAlert = useCallback((req: Extract<DialogRequest, { kind: 'alert' }>) => {
    resolveCurrent(req.id);
    req.resolve();
  }, []);

  const finishConfirm = useCallback(
    (req: Extract<DialogRequest, { kind: 'confirm' }>, ok: boolean) => {
      resolveCurrent(req.id);
      req.resolve(ok);
    },
    []
  );

  const finishPrompt = useCallback(
    (req: Extract<DialogRequest, { kind: 'prompt' }>, value: string | null) => {
      resolveCurrent(req.id);
      req.resolve(value);
    },
    []
  );

  if (!current) return null;

  const onBackdropClick = () => {
    if (current.kind === 'alert') finishAlert(current);
    else if (current.kind === 'confirm') finishConfirm(current, false);
    else finishPrompt(current, null);
  };

  const promptCanSubmit =
    current.kind !== 'prompt' || current.allowEmpty !== false || inputValue.trim().length > 0;

  const submitPrompt = () => {
    if (current.kind !== 'prompt') return;
    if (!promptCanSubmit) return;
    finishPrompt(current, inputValue);
  };

  return (
    <div
      className="modal-backdrop lc-dialog-backdrop"
      role="presentation"
      onClick={onBackdropClick}
    >
      <div
        className="modal lc-dialog-modal"
        role={current.kind === 'alert' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onBackdropClick();
          }
        }}
      >
        {current.title ? <h3 className="lc-dialog-title">{current.title}</h3> : null}
        {current.message ? <p className="lc-dialog-message">{current.message}</p> : null}

        {current.kind === 'prompt' &&
          (current.multiline ? (
            <textarea
              ref={textareaRef}
              className="lc-dialog-input"
              rows={4}
              value={inputValue}
              placeholder={current.placeholder}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submitPrompt();
                }
              }}
            />
          ) : (
            <input
              ref={inputRef}
              className="lc-dialog-input"
              type="text"
              value={inputValue}
              placeholder={current.placeholder}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitPrompt();
                }
              }}
            />
          ))}

        <div className="lc-dialog-actions">
          {current.kind === 'alert' && (
            <button type="button" className="primary" onClick={() => finishAlert(current)}>
              {current.okText ?? 'ОК'}
            </button>
          )}
          {current.kind === 'confirm' && (
            <>
              <button type="button" onClick={() => finishConfirm(current, false)}>
                {current.cancelText ?? 'Отмена'}
              </button>
              <button
                type="button"
                className={current.danger ? 'danger' : 'primary'}
                onClick={() => finishConfirm(current, true)}
              >
                {current.okText ?? 'ОК'}
              </button>
            </>
          )}
          {current.kind === 'prompt' && (
            <>
              <button type="button" onClick={() => finishPrompt(current, null)}>
                {current.cancelText ?? 'Отмена'}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!promptCanSubmit}
                onClick={submitPrompt}
              >
                {current.okText ?? 'ОК'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
