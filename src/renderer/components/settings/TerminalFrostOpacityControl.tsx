import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { FROST_ATTR } from '@renderer/frosted-chrome-contract';
import { isTerminalFrostOpacity, TERMINAL_FROST_OPACITY, TERMINAL_FROST_OPACITY_KEY } from '@shared/frosted-glass';
import { SettingRow } from './primitives';

const PREVIEW = '--terminal-opacity-preview';
const LABEL = 'Terminal background opacity';

/** Previews only the background in this window. A native change event commits the completed edit. */
export function TerminalFrostOpacityControl({ disabled }: { readonly disabled: boolean }): React.JSX.Element {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<symbol | null>(null);
  const [saved, setSaved] = useState<number>(TERMINAL_FROST_OPACITY.default);
  const [draft, setDraft] = useState<number | null>(null);
  const [error, setError] = useState(false);

  const save = useCallback(async (value: number) => {
    if (disabled || !isTerminalFrostOpacity(value)) return;
    const root = document.documentElement;
    const request = Symbol();
    pending.current = request;
    setDraft(value);
    setError(false);
    root.style.setProperty(PREVIEW, String(value / 100));
    try {
      await api.invoke('settings:set', { key: TERMINAL_FROST_OPACITY_KEY, value });
      if (request !== pending.current) return;
      if (root.getAttribute(FROST_ATTR.terminalFrost) === 'custom') root.setAttribute(FROST_ATTR.terminalOpacity, String(value));
      setSaved(value);
    } catch {
      if (request === pending.current) setError(true);
    } finally {
      if (request === pending.current) {
        pending.current = null;
        root.style.removeProperty(PREVIEW);
        setDraft(null);
      }
    }
  }, [disabled]);

  useEffect(() => {
    const el = input.current;
    const root = document.documentElement;
    function sync() {
      const value = Number(root.getAttribute(FROST_ATTR.terminalOpacity));
      if (isTerminalFrostOpacity(value)) setSaved(value);
    }
    function commit() { if (el) void save(el.valueAsNumber); }
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: [FROST_ATTR.terminalOpacity] });
    sync();
    el?.addEventListener('change', commit);
    return () => {
      observer.disconnect();
      el?.removeEventListener('change', commit);
    };
  }, [save]);

  useEffect(() => {
    if (disabled) setDraft(null);
    return () => {
      pending.current = null;
      document.documentElement.style.removeProperty(PREVIEW);
    };
  }, [disabled]);

  const value = draft ?? saved;
  return (
    <div className="space-y-1">
      <SettingRow label={LABEL} htmlFor={id} hint="Lower values show more glass. Terminal text stays opaque.">
        <div className="flex w-[260px] max-w-full items-center gap-2">
          <input ref={input} id={id} type="range" min={TERMINAL_FROST_OPACITY.min} max={TERMINAL_FROST_OPACITY.max}
            value={value} disabled={disabled} aria-valuetext={`${value}%`} className="min-w-0 flex-1 accent-[--accent]"
            onChange={event => {
              const next = event.currentTarget.valueAsNumber;
              if (!isTerminalFrostOpacity(next)) return;
              pending.current = null;
              setDraft(next);
              setError(false);
              document.documentElement.style.setProperty(PREVIEW, String(next / 100));
            }} />
          <span className="w-10 text-right text-xs tabular-nums" aria-hidden="true">{value}%</span>
          <button type="button" aria-label={`Reset ${LABEL.toLowerCase()}`} disabled={disabled || value === TERMINAL_FROST_OPACITY.default}
            onClick={() => void save(TERMINAL_FROST_OPACITY.default)}
            className="rounded-lg px-2 py-1 text-xs text-[--text-muted] hover:bg-[--surface-hover] hover:text-[--text] disabled:opacity-40">
            Reset
          </button>
        </div>
      </SettingRow>
      {error && <p role="alert" className="text-xs text-[--danger]">Could not save terminal opacity. The last saved value is still in use.</p>}
    </div>
  );
}
