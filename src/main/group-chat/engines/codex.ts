/**
 * GPT through OpenAI's Codex CLI: one `codex exec` per turn, run in the project folder, the message
 * on stdin. Codex keeps its own conversation (a "thread"): the first turn starts one, later turns
 * resume it by id (the member's engineSession).
 * `--json` prints one event per line: thread.started {thread_id}, turn.started,
 * item.started|updated|completed {item: {type: agent_message|reasoning|command_execution|
 * file_change|mcp_tool_call|web_search|todo_list, …}}, turn.completed {usage}, turn.failed {error},
 * error {message}.
 * Ported from BotOffice windows/engines/codex.js (its MCP bridge option dropped).
 */
import type { Progress, TurnItem, TurnResult } from './types';

/** Write access to the project folder only. `resume` has no -s, so the sandbox is set as config. */
export const SANDBOX = ['-c', 'sandbox_mode="workspace-write"'];
/**
 * On Windows, Codex only gives write access to the folder through its own Windows sandbox; without
 * it every turn falls back to read-only. "unelevated" needs no admin rights.
 */
const WINDOWS_SANDBOX = ['-c', 'windows.sandbox="unelevated"'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const ENGINE_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_STEPS = 12;
const MAX_STEP_CHARS = 160;

export function codexArgs(item: TurnItem, opts: { platform?: NodeJS.Platform } = {}): string[] {
  const model = item.model && MODEL_RE.test(item.model) ? ['-m', item.model] : [];
  const win = (opts.platform ?? process.platform) === 'win32' ? WINDOWS_SANDBOX : [];
  const resume = item.engineSession && ENGINE_SESSION_RE.test(item.engineSession);
  return resume
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...SANDBOX, ...win, ...model, item.engineSession!, '-']
    : ['exec', '--json', '--skip-git-repo-check', ...SANDBOX, ...win, ...model, '-'];
}

const short = (s: unknown): string => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_STEP_CHARS ? `${t.slice(0, MAX_STEP_CHARS - 1)}…` : t;
};

interface CodexItem { id?: string; type?: string; text?: unknown; command?: unknown; query?: unknown; server?: string; tool?: string; changes?: Array<{ path?: unknown }> }

// a step in words, once per item (started and completed are the same step)
function describe(item: CodexItem): string | null {
  switch (item.type) {
    case 'command_execution': return `Ran: ${short(item.command)}`;
    case 'file_change': {
      const n = (item.changes ?? []).length;
      return n === 1 ? `Changed ${short(item.changes![0]!.path)}` : `Changed ${n} files`;
    }
    case 'web_search': return `Searched: ${short(item.query)}`;
    case 'mcp_tool_call': return `Used ${short([item.server, item.tool].filter(Boolean).join(' · ') || 'a tool')}`;
    default: return null;
  }
}

export interface CodexProgress extends Progress {
  text: string;
  steps: string[];
  changed: string[];
  tokens: { in: number | null; out: number | null } | null;
  threadId: string | null;
  error: string | null;
  failed: boolean;
  done: boolean;
}

export function codexProgress(): CodexProgress {
  const seen = new Set<string>();
  const p: CodexProgress = {
    text: '', steps: [], changed: [], tokens: null, threadId: null, error: null, failed: false, done: false,
    feed(line: string): boolean {
      let e: { type?: string; thread_id?: unknown; usage?: Record<string, unknown>; error?: { message?: unknown }; message?: unknown; item?: CodexItem };
      try { e = JSON.parse(line); } catch { return false; }
      if (!e || typeof e !== 'object') return false;
      if (e.type === 'thread.started' && typeof e.thread_id === 'string') { p.threadId = e.thread_id; return false; }
      if (e.type === 'turn.completed') {
        const u = e.usage ?? {};
        p.tokens = { in: Number.isFinite(u.input_tokens) ? (u.input_tokens as number) : null, out: Number.isFinite(u.output_tokens) ? (u.output_tokens as number) : null };
        p.done = true;
        return false;
      }
      if (e.type === 'turn.failed') { p.failed = true; p.error = String(e.error?.message || 'Codex reported an error'); return false; }
      if (e.type === 'error') { p.error = String(e.message || 'Codex reported an error'); return false; }
      if (!/^item\.(started|updated|completed)$/.test(e.type ?? '') || !e.item) return false;
      const it = e.item;
      if (it.type === 'agent_message' && e.type === 'item.completed' && typeof it.text === 'string') { p.text = it.text; return true; }
      let changed = false;
      if (it.type === 'file_change' && e.type === 'item.completed') {
        for (const c of it.changes ?? []) if (typeof c.path === 'string' && !p.changed.includes(c.path)) { p.changed.push(c.path); changed = true; }
      }
      const key = it.id || `${it.type}:${JSON.stringify(it.command || it.changes || it.query || '')}`;
      const step = describe(it);
      if (step && !seen.has(key)) { seen.add(key); p.steps = [...p.steps, step].slice(-MAX_STEPS); changed = true; }
      return changed;
    },
  };
  return p;
}

export function parseCodex(p: Progress, code: number | null): TurnResult {
  const c = p as CodexProgress;
  const extra = c.threadId ? { engineSession: c.threadId } : {};
  if (c.done && !c.failed) return { ok: true, reply: c.text, ...extra };
  return { ok: false, reply: '', error: c.error || `Codex exited without an answer (code ${code})`, ...extra };
}
