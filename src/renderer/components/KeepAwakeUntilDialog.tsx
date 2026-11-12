import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { KEEP_AWAKE_COPY, KEEP_AWAKE_TESTIDS } from '@shared/keep-awake-contract';
import { ModalFrame } from '@renderer/components/ModalFrame';
import { useDialogFocus } from '@renderer/hooks/useDialogFocus';
import { formatEndTime, parseUntil } from '@renderer/keep-awake-time';

export interface UntilResolution {
  readonly endsAt: number | null;
  readonly preview: string | null;
  readonly error: string | null;
}

/**
 * Resolves the typed text against `now`: a valid time gives the deadline and its "Until HH:MM day"
 * preview; empty or malformed text gives an inline error, but only once a confirm was `attempted`.
 */
export function resolveUntil(text: string, now: number, attempted: boolean): UntilResolution {
  const parsed = parseUntil(text, now);
  if (parsed.kind === 'ok') {
    return { endsAt: parsed.endsAt, preview: KEEP_AWAKE_COPY.dialog.preview(formatEndTime(parsed.endsAt, now)), error: null };
  }
  const error = parsed.kind === 'empty' ? KEEP_AWAKE_COPY.dialog.errorEmpty : KEEP_AWAKE_COPY.dialog.errorMalformed;
  return { endsAt: null, preview: null, error: attempted ? error : null };
}

/**
 * State of the "Keep awake until" dialog. The clock is read when the dialog opens and on each edit, so
 * the deadline passed to `onStart` is the one the preview showed. A valid submit starts and closes;
 * an invalid one only reveals the inline error. Escape closes.
 */
export function useUntilDialog(onStart: (endsAt: number) => void, onClose: () => void) {
  const [text, setTextState] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [attempted, setAttempted] = useState(false);
  const { endsAt, preview, error } = resolveUntil(text, now, attempted);

  const setText = useCallback((next: string) => { setTextState(next); setNow(Date.now()); }, []);

  const onSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    if (endsAt === null) { setAttempted(true); return; }
    onStart(endsAt);
    onClose();
  }, [endsAt, onStart, onClose]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  return { text, setText, preview, error, onSubmit, onKeyDown };
}

interface ViewProps {
  readonly text: string;
  readonly preview: string | null;
  readonly error: string | null;
  readonly onChange: (text: string) => void;
  readonly onSubmit: (e: FormEvent) => void;
  readonly onClose: () => void;
  readonly onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  readonly panelRef: RefObject<HTMLDivElement>;
  readonly inputRef: RefObject<HTMLInputElement>;
}

const INPUT_ID = 'keep-awake-input';
const ERROR_ID = 'keep-awake-error';
const PREVIEW_ID = 'keep-awake-preview';
const TITLE_ID = 'keep-awake-title';
const BUTTON =
  'pressable px-3 py-1.5 rounded-md text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]';

/** Presentational "Keep awake until" dialog: labelled HH:MM input, resolved preview, inline error, Cancel and Start. */
export function KeepAwakeUntilDialogView({ text, preview, error, onChange, onSubmit, onClose, onKeyDown, panelRef, inputRef }: ViewProps): React.JSX.Element {
  return (
    <ModalFrame testId={KEEP_AWAKE_TESTIDS.dialog} tier="modal" motion="none" layerClassName="flex items-center justify-center" onDismiss={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="modal-sheet w-[380px] max-w-[92vw] outline-none"
      >
        <form onSubmit={onSubmit} noValidate className="p-5 space-y-3">
          <h2 id={TITLE_ID} className="font-semibold">{KEEP_AWAKE_COPY.dialog.title}</h2>
          <div className="space-y-1.5">
            <label htmlFor={INPUT_ID} className="block text-sm text-[--modal-text-muted]">{KEEP_AWAKE_COPY.dialog.label}</label>
            <input
              ref={inputRef}
              id={INPUT_ID}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={text}
              onChange={(e) => onChange(e.target.value)}
              placeholder={KEEP_AWAKE_COPY.dialog.placeholder}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? ERROR_ID : preview ? PREVIEW_ID : undefined}
              data-testid={KEEP_AWAKE_TESTIDS.input}
              className="w-full font-mono bg-[--panel] text-[--text] border border-[--border] rounded-md px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-[--accent]"
            />
            {preview && <p id={PREVIEW_ID} role="status" data-testid={KEEP_AWAKE_TESTIDS.preview} className="text-sm text-[--text]">{preview}</p>}
            {error && <p id={ERROR_ID} role="alert" data-testid={KEEP_AWAKE_TESTIDS.error} className="text-sm text-[--danger]">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className={`${BUTTON} border border-[--border] text-[--text] hover:bg-[--panel]`}>{KEEP_AWAKE_COPY.dialog.cancel}</button>
            <button type="submit" data-testid={KEEP_AWAKE_TESTIDS.confirm} className={`${BUTTON} bg-[color:var(--accent)] text-[--accent-text]`}>{KEEP_AWAKE_COPY.dialog.confirm}</button>
          </div>
        </form>
      </div>
    </ModalFrame>
  );
}

interface Props {
  readonly onStart: (endsAt: number) => void;
  readonly onClose: () => void;
}

/** Modal that asks for an HH:MM end time and starts keep-awake until then. Mount it to open, unmount to close. */
export function KeepAwakeUntilDialog({ onStart, onClose }: Props): React.JSX.Element {
  const dialog = useUntilDialog(onStart, onClose);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const trapTab = useDialogFocus(panelRef);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <KeepAwakeUntilDialogView
      text={dialog.text}
      preview={dialog.preview}
      error={dialog.error}
      onChange={dialog.setText}
      onSubmit={dialog.onSubmit}
      onClose={onClose}
      onKeyDown={(e) => { trapTab(e); dialog.onKeyDown(e); }}
      panelRef={panelRef}
      inputRef={inputRef}
    />
  );
}
