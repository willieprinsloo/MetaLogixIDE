import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '@renderer/api';
import { DEFAULT_TERMINAL_ENGINE, isTerminalEngine, TERMINAL_ENGINE_KEY, type TerminalEngine } from '@shared/terminal-engine';
import { SettingRow } from './primitives';

const ENGINES = [{ id: 'xterm', label: 'xterm.js' }, { id: 'ghostty', label: 'Ghostty (WASM)' }] as const;
const LABEL = 'Terminal engine';

export function TerminalEngineControl() {
  const hint = useId();
  const [committed, setCommitted] = useState<TerminalEngine | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const saveChoice = useRef<((next: TerminalEngine) => Promise<void>) | null>(null);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let read = 0;
    let refreshAfter = false;
    async function reload() {
      if (inFlight) { refreshAfter = true; return; }
      const version = ++read;
      try {
        const { value } = await api.invoke('settings:get', { key: TERMINAL_ENGINE_KEY });
        if (active && read === version) setCommitted(isTerminalEngine(value) ? value : DEFAULT_TERMINAL_ENGINE);
      } catch {
        if (active && read === version) setError('Could not read the terminal engine. Reopen Settings to try again.');
      }
    }
    async function save(next: TerminalEngine) {
      if (inFlight) return;
      inFlight = true;
      read++;
      setSaving(true);
      setError('');
      try {
        await api.invoke('settings:set', { key: TERMINAL_ENGINE_KEY, value: next });
        if (active) setCommitted(next);
      } catch {
        if (active) setError('Could not save the terminal engine. Your previous choice is still in use.');
      } finally {
        inFlight = false;
        if (active) {
          setSaving(false);
          if (refreshAfter) { refreshAfter = false; void reload(); }
        }
      }
    }
    saveChoice.current = save;
    const unsubscribe = api.on('settings:changed', ({ key }) => { if (key === TERMINAL_ENGINE_KEY) void reload(); });
    void reload();
    return () => { active = false; saveChoice.current = null; unsubscribe(); };
  }, []);

  function select(next: TerminalEngine) {
    if (committed && next !== committed && !saving) void saveChoice.current?.(next);
  }

  function onArrow(event: KeyboardEvent<HTMLButtonElement>, from: TerminalEngine) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (saving || !committed) return;
    const next = event.key === 'Home' ? 'xterm' : event.key === 'End' ? 'ghostty' : from === 'xterm' ? 'ghostty' : 'xterm';
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-engine-choice="${next}"]`)?.focus();
    select(next);
  }

  return (
    <>
      <SettingRow label={LABEL}>
        <div role="radiogroup" aria-label={LABEL} aria-describedby={hint} aria-busy={saving}
          className="inline-flex gap-0.5 rounded-[11px] bg-[--surface-field] p-[3px]">
          {ENGINES.map(({ id, label }) => (
            <button key={id} type="button" role="radio" aria-checked={committed === id} data-engine-choice={id}
              aria-disabled={saving} disabled={committed === null} tabIndex={committed === id ? 0 : -1}
              onClick={() => select(id)} onKeyDown={event => onArrow(event, id)}
              className={`h-[30px] rounded-lg px-3.5 text-[13px] ${committed === id ? 'bg-[--accent-soft] font-medium text-[--accent-soft-text]' : 'text-[--text] hover:bg-[--surface-hover]'}`}>
              {label}
            </button>
          ))}
        </div>
      </SettingRow>
      <p id={hint} className="text-xs text-[--text-muted]">Applies when you open or reopen a terminal view. Open views stay as they are.</p>
      {error && <p role="alert" className="text-xs text-[--text-muted]">{error}</p>}
    </>
  );
}
