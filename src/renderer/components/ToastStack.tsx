import { useEffect, useRef, useState } from 'react';
import { useToasts, type Toast, type ToastKind } from '@renderer/hooks/useToasts';

// Matches `.toast[data-leaving]` in styles.css.
const EXIT_MS = 180;

interface Entry { toast: Toast; leaving: boolean }

/** Keeps dismissed toasts mounted for EXIT_MS, in place, so they can fade out. */
export function mergeToasts(rendered: Entry[], toasts: Toast[]): Entry[] {
  const live = new Set(toasts.map((t) => t.id));
  const known = new Set(rendered.map((e) => e.toast.id));
  const fresh = toasts.filter((t) => !known.has(t.id)).map((toast) => ({ toast, leaving: false }));
  const kept = rendered.map((e) => (live.has(e.toast.id) || e.leaving ? e : { ...e, leaving: true }));
  return [...fresh, ...kept];
}

function useExitingToasts(toasts: Toast[]): Entry[] {
  const [rendered, setRendered] = useState<Entry[]>([]);
  const renderedRef = useRef<Entry[]>([]);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const commit = (next: Entry[]) => { renderedRef.current = next; setRendered(next); };
    const next = mergeToasts(renderedRef.current, toasts);
    commit(next);
    const exiting = new Set(next.filter((e) => e.leaving).map((e) => e.toast.id));
    if (exiting.size === 0) return;
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      commit(renderedRef.current.filter((e) => !exiting.has(e.toast.id)));
    }, EXIT_MS);
    timers.current.add(timer);
  }, [toasts]);

  useEffect(() => () => { for (const t of timers.current) window.clearTimeout(t); }, []);
  return rendered;
}

const KIND_STYLES: Record<ToastKind, { border: string; accent: string; stripe: string; Icon: () => JSX.Element }> = {
  info:    { border: 'border-[--border]',       accent: 'text-[color:var(--accent)]', stripe: 'bg-[color:var(--accent)]', Icon: InfoIcon },
  success: { border: 'border-emerald-500/40',   accent: 'text-emerald-400',           stripe: 'bg-emerald-500',            Icon: CheckIcon },
  warning: { border: 'border-amber-500/40',     accent: 'text-amber-400',             stripe: 'bg-amber-400',              Icon: WarnIcon },
  error:   { border: 'border-[color:var(--danger)]/40', accent: 'text-[--danger]',    stripe: 'bg-[--danger]',             Icon: ErrorIcon },
};

export function ToastStack() {
  const { toasts, dismiss } = useToasts();
  const entries = useExitingToasts(toasts);
  if (entries.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-40 flex flex-col-reverse gap-2 max-w-[380px]">
      {entries.map(({ toast: t, leaving }) => {
        const s = KIND_STYLES[t.kind];
        const Icon = s.Icon;
        return (
          <div
            key={t.id}
            role={leaving ? undefined : 'status'}
            data-testid={leaving ? 'toast-leaving' : 'toast'}
            data-leaving={leaving || undefined}
            aria-hidden={leaving || undefined}
            className={`toast pointer-events-auto relative bg-[--panel-strong] border ${s.border} rounded-md shadow-lg pl-3 pr-2 py-2 flex items-start gap-2 backdrop-blur-md overflow-hidden`}
          >
            <span className={`absolute left-0 top-0 bottom-0 w-1 ${s.stripe}`} aria-hidden />
            <span className={`${s.accent} shrink-0 mt-0.5`} aria-hidden><Icon /></span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{t.title}</div>
              {t.detail && <div className="text-xs text-[--text-muted] mt-0.5 whitespace-pre-wrap break-words">{t.detail}</div>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="text-[--text-muted] hover:text-[--text] w-5 h-5 flex items-center justify-center rounded shrink-0"
              title="Dismiss"
              aria-label="Dismiss notification"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function InfoIcon()  { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8"  x2="12.01" y2="8"/></svg>; }
function CheckIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>; }
function WarnIcon()  { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>; }
function ErrorIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9"  y1="9" x2="15" y2="15"/></svg>; }
