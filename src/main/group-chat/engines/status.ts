/**
 * Which headless engines can run right now, and if one can't, why and how to fix it (the group
 * panel shows it in "+ Add"). Everything is injected so tests need no real CLIs.
 * Ported from BotOffice windows/engines/status.js (Claude and Grok dropped).
 */
import type { EngineStatus } from '@shared/group-chat';
import { NOT_RUNNING } from './ollama';

const PROBE_TIMEOUT_MS = 5000;

async function ollamaStatus(base: string, fetchFn: typeof fetch): Promise<EngineStatus> {
  try {
    const res = await fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return { ready: false, why: `Ollama answered HTTP ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name?: unknown }> };
    const models = (body.models ?? []).map((m) => String(m.name || '')).filter(Boolean);
    if (!models.length) return { ready: false, why: 'Ollama has no models yet — run e.g.: ollama pull llama3.2' };
    return { ready: true, models };
  } catch {
    return { ready: false, why: NOT_RUNNING };
  }
}

type Version = (cmd: string[], args: string[]) => Promise<string>;

// installed (answers --version), and, where the CLI can say so, signed in
async function cliStatus(cmd: string[], version: Version, why: string, signIn?: { args: string[]; why: string }): Promise<EngineStatus> {
  let v: string;
  try {
    v = String(await version(cmd, ['--version'])).trim().split(/\r?\n/)[0]!.slice(0, 40);
  } catch {
    return { ready: false, why };
  }
  if (signIn) {
    try { await version(cmd, signIn.args); } catch { return { ready: false, why: signIn.why, version: v }; }
  }
  return { ready: true, version: v };
}

export async function detectEngines(o: {
  ollamaBase: string;
  codex: string[];
  gemini: string[];
  fetch: typeof fetch;
  version: Version;
  /** Gemini has no "am I signed in?" command; the caller may check its sign-in files instead. */
  geminiSignedIn?: () => boolean;
}): Promise<{ codex: EngineStatus; gemini: EngineStatus; ollama: EngineStatus }> {
  const [ollama, codex, gemini] = await Promise.all([
    ollamaStatus(o.ollamaBase, o.fetch),
    cliStatus(o.codex, o.version, 'Codex CLI isn’t installed — run: npm i -g @openai/codex, then codex login',
      { args: ['login', 'status'], why: 'Codex CLI isn’t signed in — run: codex login (in a terminal), then wait a minute' }),
    cliStatus(o.gemini, o.version, 'Gemini CLI isn’t installed — run: npm i -g @google/gemini-cli, then gemini once to sign in'),
  ]);
  if (gemini.ready && o.geminiSignedIn && !o.geminiSignedIn()) {
    return { ollama, codex, gemini: { ready: false, why: 'Gemini CLI isn’t signed in — run gemini once in a terminal to sign in, or set an API key', version: gemini.version } };
  }
  return { ollama, codex, gemini };
}
