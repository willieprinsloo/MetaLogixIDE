import { api } from '@renderer/api';
import { DEFAULT_TERMINAL_ENGINE, isTerminalEngine, TERMINAL_ENGINE_KEY, type TerminalEngine } from '@shared/terminal-engine';
import { untilAbort } from './terminal-abort';

const READ_DEADLINE_MS = 750;

/** Read the committed value once for this opening. Do not consult window-local state. */
export async function readTerminalEngine(signal: AbortSignal): Promise<TerminalEngine> {
  if (signal.aborted) return DEFAULT_TERMINAL_ENGINE;
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), READ_DEADLINE_MS);
  const bounded = AbortSignal.any([signal, deadline.signal]);
  try {
    const { value } = await untilAbort(api.invoke('settings:get', { key: TERMINAL_ENGINE_KEY }), bounded);
    return isTerminalEngine(value) ? value : DEFAULT_TERMINAL_ENGINE;
  } catch {
    if (!signal.aborted) console.warn('[metaide] terminal engine setting unavailable; using xterm');
    return DEFAULT_TERMINAL_ENGINE;
  } finally {
    clearTimeout(timeout);
  }
}
