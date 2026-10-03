import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClaudePermissionMode } from '@shared/claude-permission-mode';
import { PERMISSION_MODE_COPY, PERMISSION_MODE_TEST_IDS } from '@renderer/permission-mode-copy';
import { classifyDialogKey, nextFocusIndex } from './permission-mode-keys';

interface Props {
  onConfirm: (mode: ClaudePermissionMode) => Promise<void>;
  error: string | null;
}

interface OptionProps {
  mode: ClaudePermissionMode;
  checked: boolean;
  onSelect: (mode: ClaudePermissionMode) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}

const TITLE_ID = 'permission-mode-title';
const INTRO_ID = 'permission-mode-intro';
const FOCUSABLE = 'input[type="radio"]:checked, button:not([disabled])';

function ModeOption({ mode, checked, onSelect, inputRef }: OptionProps) {
  const copy = PERMISSION_MODE_COPY[mode];
  const descId = `permission-mode-${mode}-desc`;
  const testId = mode === 'auto' ? PERMISSION_MODE_TEST_IDS.dialogOptionAuto : PERMISSION_MODE_TEST_IDS.dialogOptionBypass;
  return (
    <label
      className={`flex items-start gap-3 min-h-[44px] rounded-lg border px-4 py-3 cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[--accent] ${
        checked ? 'border-[--accent] bg-[--panel] shadow-[inset_0_0_0_1px_var(--accent)]' : 'border-[--border] bg-[--panel] hover:bg-[--panel-strong]'
      }`}
    >
      <input
        ref={inputRef}
        type="radio"
        name="claude-permission-mode"
        value={mode}
        checked={checked}
        onChange={() => onSelect(mode)}
        aria-describedby={descId}
        className="mt-1 h-4 w-4 shrink-0 accent-[--accent] focus:outline-none"
        data-testid={testId}
      />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 text-base font-medium text-[--text]">
          {copy.label}
          {'badge' in copy && (
            <span className="rounded-full border border-[--accent] px-2 py-0.5 text-xs font-medium text-[--text]">{copy.badge}</span>
          )}
        </span>
        <span id={descId} className="mt-1 block text-sm leading-relaxed text-[--text-muted]">{copy.description}</span>
      </span>
    </label>
  );
}

/**
 * Blocking first-run modal asking how Claude runs (Auto or Bypass). Auto is
 * preselected; selecting an option persists nothing, only Continue (or Enter)
 * calls `onConfirm(mode)`, which is awaited while Continue is disabled. There
 * is no close control and no backdrop or Escape dismissal; while mounted it
 * owns every keydown (capture phase) so app shortcuts cannot open other
 * overlays, and it traps Tab focus. `error` is shown when a confirm fails.
 */
export function PermissionModeDialog({ onConfirm, error }: Props) {
  const [selected, setSelected] = useState<ClaudePermissionMode>('auto');
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const autoRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<() => void>(() => {});

  confirmRef.current = () => {
    if (submitting) return;
    setSubmitting(true);
    void onConfirm(selected).finally(() => setSubmitting(false));
  };

  useEffect(() => { autoRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      e.stopImmediatePropagation();
      const action = classifyDialogKey(e);
      if (action === 'swallow') e.preventDefault();
      if (action === 'confirm') { e.preventDefault(); confirmRef.current(); }
      if (action === 'cycle-focus') {
        e.preventDefault();
        const els = Array.from(formRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
        const idx = nextFocusIndex(els.indexOf(document.activeElement as HTMLElement), els.length, e.shiftKey);
        els[idx]?.focus();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    confirmRef.current();
  }

  return (
    <div className="modal-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={INTRO_ID}
        onSubmit={onSubmit}
        className="modal-panel bg-[--panel-strong] w-[520px] max-w-full max-h-full overflow-y-auto rounded-xl shadow-2xl border border-[--border]"
        data-testid={PERMISSION_MODE_TEST_IDS.dialog}
      >
        <div className="px-5 pt-5 pb-4 space-y-4">
          <div className="space-y-1">
            <h2 id={TITLE_ID} className="text-lg font-semibold text-[--text]">{PERMISSION_MODE_COPY.dialogTitle}</h2>
            <p id={INTRO_ID} className="text-sm text-[--text-muted]">{PERMISSION_MODE_COPY.dialogIntro}</p>
          </div>
          <div role="radiogroup" aria-labelledby={TITLE_ID} className="space-y-2">
            <ModeOption mode="auto" checked={selected === 'auto'} onSelect={setSelected} inputRef={autoRef} />
            <ModeOption mode="bypass" checked={selected === 'bypass'} onSelect={setSelected} />
          </div>
          <p className="text-sm text-[--text-muted]">{PERMISSION_MODE_COPY.changeLaterNote}</p>
          {error && (
            <p role="alert" className="text-sm text-[--danger]" data-testid={PERMISSION_MODE_TEST_IDS.dialogError}>{error}</p>
          )}
        </div>
        <div className="flex justify-end border-t border-[--border] px-5 py-3 bg-[--panel]/60">
          <button
            type="submit"
            disabled={submitting}
            className="min-h-[44px] min-w-[44px] px-5 text-sm font-medium pressable bg-[--accent] hover:brightness-110 text-white rounded-md disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-2 focus-visible:ring-offset-[--panel-strong]"
            data-testid={PERMISSION_MODE_TEST_IDS.dialogConfirm}
          >
            {PERMISSION_MODE_COPY.confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
