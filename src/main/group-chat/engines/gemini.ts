/**
 * Gemini through Google's Gemini CLI: one headless run per turn in the project folder, the message
 * on stdin (piped input makes it non-interactive). Gemini keeps its own conversation; later turns
 * resume it by session id (the member's engineSession).
 * `--output-format stream-json` prints one event per line: init {session_id, model},
 * message {role, content, delta}, tool_use {tool_name, tool_id, parameters},
 * tool_result {tool_id, status: success|error}, error {message},
 * result {status: success|error, error?: {message}, stats: {input_tokens, output_tokens}}.
 * Ported from BotOffice windows/engines/gemini.js (attachment folders dropped).
 */
import type { Progress, TurnItem, TurnResult } from './types';

/**
 * auto_edit: Gemini may read and edit files in its folder without asking; tools that would need
 * asking, like shell commands, are refused in headless mode. --skip-trust: the folder is one of the
 * user's own projects, opened in the app.
 */
export const BASE = ['--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--skip-trust'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_STEPS = 12;
const MAX_STEP_CHARS = 160;
const EDIT_TOOLS = new Set(['write_file', 'replace', 'edit']);

export function geminiArgs(item: TurnItem): string[] {
  const out = [...BASE];
  if (item.model && MODEL_RE.test(item.model)) out.push('-m', item.model);
  if (item.engineSession && SESSION_RE.test(item.engineSession)) out.push('--resume', item.engineSession);
  return out;
}

type Params = Record<string, unknown>;
const short = (s: unknown): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_STEP_CHARS ? `${t.slice(0, MAX_STEP_CHARS - 1)}…` : t;
};
const fileOf = (p: Params = {}): string => String(p.file_path || p.absolute_path || p.path || '');

function describe(name: string, p: Params = {}): string {
  switch (name) {
    case 'read_file': return `Read ${short(fileOf(p))}`;
    case 'read_many_files': return 'Read several files';
    case 'write_file': return `Wrote ${short(fileOf(p))}`;
    case 'replace': case 'edit': return `Edited ${short(fileOf(p))}`;
    case 'run_shell_command': return `Ran: ${short(p.command)}`;
    case 'list_directory': return `Listed ${short(fileOf(p))}`;
    case 'glob': return `Looked for ${short(p.pattern)}`;
    case 'search_file_content': case 'grep': return `Searched for ${short(p.pattern)}`;
    case 'google_web_search': return `Searched the web: ${short(p.query)}`;
    case 'web_fetch': return 'Fetched a web page';
    default: return `Used ${short(name)}`;
  }
}

/** One `--output-format stream-json` event; every field is untrusted until checked. */
interface GeminiEvent {
  type?: unknown;
  session_id?: unknown;
  model?: unknown;
  role?: unknown;
  content?: unknown;
  delta?: unknown;
  tool_name?: unknown;
  tool_id?: unknown;
  parameters?: Params;
  status?: unknown;
  message?: unknown;
  error?: { message?: unknown };
  stats?: Record<string, unknown>;
}

export interface GeminiProgress extends Progress {
  text: string;
  steps: string[];
  changed: string[];
  tokens: { in: number | null; out: number | null } | null;
  sessionId: string | null;
  model: string | null;
  error: string | null;
  status: string | null;
}

export function geminiProgress(): GeminiProgress {
  const pending = new Map<unknown, string>(); // tool_id → file it edits (counted once the edit succeeds)
  const p: GeminiProgress = {
    text: '', steps: [], changed: [], tokens: null, sessionId: null, model: null, error: null, status: null,
    feed(line: string): boolean {
      let e: GeminiEvent;
      try { e = JSON.parse(line) as GeminiEvent; } catch { return false; }
      if (!e || typeof e !== 'object') return false;
      switch (e.type) {
        case 'init':
          if (typeof e.session_id === 'string') p.sessionId = e.session_id;
          if (typeof e.model === 'string') p.model = e.model;
          return false;
        case 'message':
          if (e.role !== 'assistant' || typeof e.content !== 'string') return false;
          p.text = e.delta ? p.text + e.content : e.content;
          return true;
        case 'tool_use': {
          const name = String(e.tool_name || 'tool');
          const params = (e.parameters ?? {}) as Params;
          if (EDIT_TOOLS.has(name) && fileOf(params)) pending.set(e.tool_id, fileOf(params));
          p.steps = [...p.steps, describe(name, params)].slice(-MAX_STEPS);
          return true;
        }
        case 'tool_result': {
          const file = pending.get(e.tool_id);
          pending.delete(e.tool_id);
          if (file && e.status === 'success' && !p.changed.includes(file)) { p.changed.push(file); return true; }
          return false;
        }
        case 'error':
          p.error = String(e.message || 'Gemini reported an error');
          return false;
        case 'result': {
          p.status = typeof e.status === 'string' ? e.status : null;
          if (e.status !== 'success') p.error = String(e.error?.message || p.error || 'Gemini reported an error');
          const s = e.stats ?? {};
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
          if (num(s.input_tokens) !== null || num(s.output_tokens) !== null) p.tokens = { in: num(s.input_tokens), out: num(s.output_tokens) };
          return false;
        }
        default: return false;
      }
    },
  };
  return p;
}

export function parseGemini(p: Progress, code: number | null): TurnResult {
  const g = p as GeminiProgress;
  const extra = g.sessionId ? { engineSession: g.sessionId } : {};
  if (g.status === 'success') return { ok: true, reply: g.text, ...extra };
  return { ok: false, reply: '', error: g.error || `Gemini exited without an answer (code ${code})`, ...extra };
}
