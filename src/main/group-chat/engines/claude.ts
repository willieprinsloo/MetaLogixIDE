/**
 * A Claude group member, run headless like the other engines: `claude -p --output-format json`
 * with the round message on stdin. It keeps the context of the Claude tab it was added from by
 * forking that tab's conversation on its first turn (`--resume <tab session> --fork-session`) and
 * resuming its own copy after that, so nothing is ever typed into the user's tab.
 *
 * Permissions follow the app's choice for Claude tabs ('auto' or 'bypass'); headless Claude can't
 * ask, so in 'auto' anything that would need approval is refused and Claude says so in its reply.
 */
import type { ClaudePermissionMode } from '@shared/claude-permission-mode';
import type { Progress, TurnResult } from './types';

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$/;

export interface ClaudeTurnOpts {
  /** The tab's conversation the member was added from. */
  forkFrom: string | null;
  /** The group's own copy, once the first turn made it. */
  engineSession: string | null;
  permission: ClaudePermissionMode;
  model?: string | null;
}

export function claudeArgs(o: ClaudeTurnOpts): string[] {
  const own = o.engineSession && SESSION_RE.test(o.engineSession) ? o.engineSession : null;
  const from = o.forkFrom && SESSION_RE.test(o.forkFrom) ? o.forkFrom : null;
  const resume = own ? ['--resume', own] : from ? ['--resume', from, '--fork-session'] : [];
  const perm = o.permission === 'bypass' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'auto'];
  const model = o.model && MODEL_RE.test(o.model) ? ['--model', o.model] : [];
  return ['-p', '--output-format', 'json', ...resume, ...perm, ...model];
}

interface ClaudeResult { type?: unknown; is_error?: unknown; result?: unknown; session_id?: unknown }

/** Keeps the last `result` object Claude printed. */
export function claudeProgress(): Progress & { result: ClaudeResult | null } {
  const p = {
    result: null as ClaudeResult | null,
    feed(line: string): boolean {
      try {
        const v = JSON.parse(line) as ClaudeResult;
        if (v && typeof v === 'object' && v.type === 'result') { p.result = v; return true; }
      } catch { /* not JSON: a warning line */ }
      return false;
    },
  };
  return p;
}

export function parseClaude(progress: Progress, code: number | null): TurnResult {
  const r = (progress as ReturnType<typeof claudeProgress>).result;
  if (!r) return { ok: false, reply: '', error: `claude exited without an answer (code ${code})` };
  const sid = typeof r.session_id === 'string' && SESSION_RE.test(r.session_id) ? { engineSession: r.session_id } : {};
  const text = typeof r.result === 'string' ? r.result : '';
  if (r.is_error === true) return { ok: false, reply: '', error: text.trim().slice(0, 300) || 'Claude reported an error', ...sid };
  return { ok: true, reply: text, ...sid };
}
