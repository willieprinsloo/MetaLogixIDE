import { useId, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { useTerminalPadding } from '@renderer/terminal/terminal-padding-context';
import {
  DEFAULT_TERMINAL_PADDING, isTerminalPaddingValue, TERMINAL_PADDING_KEYS, TERMINAL_PADDING_MAX,
  type TerminalPaddingAxis, type TerminalPaddingValue,
} from '@shared/terminal-padding';
import { NUMBER_FIELD_CLASS, SettingRow } from './primitives';

const HINT: Record<TerminalPaddingAxis, string> = {
  horizontal: `Space on each side. Default: ${DEFAULT_TERMINAL_PADDING.sides} px.`,
  vertical: `Space above and below. Default: ${DEFAULT_TERMINAL_PADDING.top} px above, ${DEFAULT_TERMINAL_PADDING.bottom} px below.`,
};

/** Edits one axis at a time. The running terminal only uses committed values. */
export function TerminalPaddingControl({ axis }: { readonly axis: TerminalPaddingAxis }): React.JSX.Element {
  const padding = useTerminalPadding()[axis];
  const id = useId();
  const label = `Terminal ${axis} padding`;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  async function save(next: TerminalPaddingValue) {
    if (inFlight.current) return;
    if (next === padding) { setDraft(null); setError(''); return; }
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      await api.invoke('settings:set', { key: TERMINAL_PADDING_KEYS[axis], value: next });
    } catch {
      setError(`Could not save terminal ${axis} padding. The previous setting is still in use.`);
    } finally {
      inFlight.current = false;
      setSaving(false);
      setDraft(null);
    }
  }

  function commit(raw: string) {
    if (draft === null || inFlight.current) return;
    const next = raw === '' ? NaN : Number(raw);
    if (isTerminalPaddingValue(next)) { void save(next); return; }
    setDraft(null);
    setError(`Enter a whole number between 0 and ${TERMINAL_PADDING_MAX}.`);
  }

  return (
    <div className="space-y-1.5">
      <SettingRow label={label} htmlFor={id} hint={HINT[axis]}>
        <div className="flex items-center gap-2" aria-busy={saving}>
          <input id={id} type="number" min={0} max={TERMINAL_PADDING_MAX} step={1}
            value={draft ?? padding ?? ''} placeholder="Default" className={NUMBER_FIELD_CLASS}
            readOnly={saving} aria-invalid={error !== ''} aria-describedby={error ? `${id}-error` : undefined}
            onChange={event => { setDraft(event.currentTarget.value); setError(''); }}
            onBlur={event => commit(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(event.currentTarget.value); } }} />
          <span className="text-xs text-[--text-muted]" aria-hidden="true">px</span>
          <button type="button" aria-label={`Reset terminal ${axis} padding`} disabled={saving || (padding === null && draft === null)}
            className="rounded-lg px-2 py-1 text-xs text-[--text-muted] hover:bg-[--surface-hover] hover:text-[--text] disabled:opacity-40"
            onMouseDown={event => event.preventDefault()} onClick={() => void save(null)}>
            Reset
          </button>
        </div>
      </SettingRow>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-[--text-muted]">{error}</p>}
    </div>
  );
}
