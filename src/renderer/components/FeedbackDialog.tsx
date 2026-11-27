/**
 * Report-a-bug / Leave-feedback dialog (METAI-6).
 *
 * The user picks `bug` or `idea`, writes a one-line title and an
 * optional description, and submits. The main side composes the ticket
 * text, copies it to the clipboard via this component, and returns the
 * board URL — a confirmation toast then offers "Open the board" so the
 * human can paste the pre-written body into a new ticket in one click.
 *
 * Why not create the ticket outright? See `src/main/feedback/reporter.ts`
 * — the direct POST to the tickets API lands as a follow-up once the
 * endpoint is confirmed. Opening the board with the body on the clipboard
 * is the honest intermediate, and it's testable end-to-end today.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { MODAL_CLASSES } from '@renderer/modal-glass';
import { ModalFrame } from './ModalFrame';
import { XIcon } from './shell-icons';
import { useDialogFocus } from '@renderer/hooks/useDialogFocus';
import { Tooltip } from './Tooltip';
import { ICON_SIZE } from './icon-size';
import { FEEDBACK_LIMITS, type FeedbackType } from '@shared/feedback';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The selected shell's engine, filled in for context. Omitted when
   *  no shell is focused — the ticket will say `unknown`. */
  readonly terminalEngine?: 'xterm' | 'ghostty' | 'unknown';
}

export function FeedbackDialog({ open, onClose, terminalEngine }: Props): React.JSX.Element | null {
  const titleId = useId();
  const [type, setType] = useState<FeedbackType>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ markdown: string; boardUrl: string | null; message: string } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useDialogFocus(dialogRef);

  // Reset state each time the dialog opens so a previous submission's
  // confirmation doesn't flash back on re-open.
  useEffect(() => {
    if (!open) return;
    setType('bug');
    setTitle('');
    setDescription('');
    setBusy(false);
    setError(null);
    setConfirmation(null);
  }, [open]);

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Add a title so a reviewer can scan the board.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.invoke('feedback:submit', {
        type,
        title: trimmed,
        description,
        terminalEngine: terminalEngine ?? 'unknown',
      });
      if (!result.ok) {
        setError(result.message ?? 'Report was rejected.');
        return;
      }
      if (result.markdown) {
        try { await navigator.clipboard.writeText(result.markdown); } catch { /* clipboard permission off — the toast still tells them. */ }
      }
      setConfirmation({
        markdown: result.markdown ?? '',
        boardUrl: result.boardUrl ?? null,
        message: result.message ?? 'Report composed.',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [type, title, description, terminalEngine]);

  const openBoard = useCallback(async () => {
    if (!confirmation?.boardUrl) return;
    try {
      await api.invoke('app:open-external', { url: confirmation.boardUrl });
    } catch { /* leave the dialog open so the user sees what went wrong */ }
  }, [confirmation]);

  if (!open) return null;

  return (
    <ModalFrame testId="feedback-dialog" tier="palette" motion="fade" onDismiss={onClose} layerClassName="flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`${MODAL_CLASSES.sheet} w-full max-w-lg p-5 flex flex-col gap-4 outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3">
          <h2 id={titleId} className="text-[15px] font-medium text-[--text] flex-1">Report a bug or leave feedback</h2>
          <Tooltip label="Close">
            <button onClick={onClose} aria-label="Close dialog" className="p-1 rounded hover:bg-[--surface-hover] text-[--text-muted]" data-testid="feedback-close">
              <XIcon size={ICON_SIZE.sm} />
            </button>
          </Tooltip>
        </header>

        {!confirmation && (
          <>
            <fieldset className="flex gap-2" aria-label="Report type">
              <TypeOption value="bug" current={type} onPick={setType} label="Bug" hint="Something's broken or behaving wrongly." />
              <TypeOption value="idea" current={type} onPick={setType} label="Feedback / idea" hint="A suggestion or a thing you wish worked differently." />
            </fieldset>

            <label className="flex flex-col gap-1 text-[12px] text-[--text-muted]">
              <span>Title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value.slice(0, FEEDBACK_LIMITS.titleMax))}
                maxLength={FEEDBACK_LIMITS.titleMax}
                autoFocus
                placeholder={type === 'bug' ? 'Short summary — what broke?' : 'Short summary — what would be better?'}
                className="bg-[--panel] border border-[--border] rounded-md px-2 py-1.5 text-[13px] text-[--text] outline-none focus:border-[--accent]"
                data-testid="feedback-title"
              />
            </label>

            <label className="flex flex-col gap-1 text-[12px] text-[--text-muted]">
              <span>Description <span className="opacity-70">(optional — what happened, what you expected)</span></span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, FEEDBACK_LIMITS.descriptionMax))}
                rows={6}
                className="bg-[--panel] border border-[--border] rounded-md px-2 py-1.5 text-[13px] text-[--text] outline-none focus:border-[--accent] font-mono"
                data-testid="feedback-description"
              />
            </label>

            {error && (
              <p role="alert" className="text-[12px] text-[--hue-orange-soft-text] bg-[--hue-orange-soft] px-2 py-1 rounded-md">{error}</p>
            )}

            <footer className="flex items-center justify-end gap-2 pt-1">
              <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded-md border border-[--border] text-[--text-muted] hover:bg-[--surface-hover]" data-testid="feedback-cancel">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy || !title.trim()}
                className="text-[12px] px-3 py-1.5 rounded-md border border-[color:var(--accent)]/40 text-[color:var(--accent)] hover:bg-[--accent-soft] disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="feedback-submit"
              >
                {busy ? 'Composing…' : 'Compose report'}
              </button>
            </footer>
            <p className="text-[11px] text-[--text-muted] -mt-1">
              The ticket text (including version and OS) goes to your clipboard; the next step opens the MetaIDE board so you can paste it into a new ticket.
            </p>
          </>
        )}

        {confirmation && (
          <>
            <p className="text-[13px] text-[--text]" data-testid="feedback-confirmation">{confirmation.message}</p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded-md border border-[--border] text-[--text-muted] hover:bg-[--surface-hover]">
                Close
              </button>
              {confirmation.boardUrl && (
                <button
                  onClick={openBoard}
                  className="text-[12px] px-3 py-1.5 rounded-md border border-[color:var(--accent)]/40 text-[color:var(--accent)] hover:bg-[--accent-soft]"
                  data-testid="feedback-open-board"
                >
                  Open the board
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </ModalFrame>
  );
}

function TypeOption({ value, current, onPick, label, hint }: { value: FeedbackType; current: FeedbackType; onPick: (v: FeedbackType) => void; label: string; hint: string }): React.JSX.Element {
  const selected = current === value;
  return (
    <label className={`flex-1 cursor-pointer rounded-md border px-3 py-2 ${selected ? 'border-[color:var(--accent)]/60 bg-[--accent-soft]' : 'border-[--border] hover:bg-[--surface-hover]'}`}>
      <input
        type="radio"
        name="feedback-type"
        value={value}
        checked={selected}
        onChange={() => onPick(value)}
        className="sr-only"
        data-testid={`feedback-type-${value}`}
      />
      <div className="text-[13px] text-[--text]">{label}</div>
      <div className="text-[11px] text-[--text-muted] mt-0.5">{hint}</div>
    </label>
  );
}
