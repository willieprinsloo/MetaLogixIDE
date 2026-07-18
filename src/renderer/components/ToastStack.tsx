import { useToasts, type ToastKind } from '@renderer/hooks/useToasts';

const KIND_STYLES: Record<ToastKind, { border: string; accent: string; icon: string }> = {
  info:    { border: 'border-[--border]',    accent: 'text-[--accent]', icon: 'ⓘ' },
  success: { border: 'border-emerald-500/40', accent: 'text-emerald-400', icon: '✓' },
  warning: { border: 'border-amber-500/40',   accent: 'text-amber-400',   icon: '⚠' },
  error:   { border: 'border-[--danger]/40',  accent: 'text-[--danger]',  icon: '⨯' },
};

export function ToastStack() {
  const { toasts, dismiss } = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-40 flex flex-col-reverse gap-2 max-w-[380px]">
      {toasts.map((t) => {
        const s = KIND_STYLES[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            data-testid="toast"
            className={`pointer-events-auto bg-[--panel-strong] border ${s.border} rounded-md shadow-lg px-3 py-2 flex items-start gap-2 backdrop-blur-md`}
          >
            <span className={`text-sm font-bold ${s.accent}`} aria-hidden>{s.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{t.title}</div>
              {t.detail && <div className="text-xs text-[--text-muted] mt-0.5 whitespace-pre-wrap break-words">{t.detail}</div>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="text-[--text-muted] hover:text-[--text] w-5 h-5 flex items-center justify-center rounded"
              title="Dismiss"
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
