// Which engines can run right now, and why not when they can't.
// Ported from BotOffice windows/test/engine-status.test.js (Claude and Grok dropped).
import { describe, it, expect } from 'vitest';
import { detectEngines } from '@main/group-chat/engines/status';

const okJson = (data: unknown) => (async () => ({ ok: true, status: 200, json: async () => data })) as unknown as typeof fetch;
const refused = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
// version(cmd, args): the fake answers `--version` from map, and `login status` from login
const versions = (map: Record<string, string>, login: Record<string, string> = { codex: 'Logged in using ChatGPT' }) =>
  async (cmd: string[], args: string[] = ['--version']): Promise<string> => {
    if (args[0] === 'login') { if (login[cmd[0]!]) return login[cmd[0]!]!; throw new Error('Not logged in'); }
    if (map[cmd[0]!]) return map[cmd[0]!]!;
    throw new Error('not found');
  };
const base = { ollamaBase: 'http://127.0.0.1:11434', codex: ['codex'], gemini: ['gemini'] };

describe('detectEngines', () => {
  it('lists Ollama models when it’s up', async () => {
    const e = await detectEngines({ ...base, fetch: okJson({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen3:8b' }] }), version: versions({}) });
    expect(e.ollama).toEqual({ ready: true, models: ['llama3.2:latest', 'qwen3:8b'] });
  });

  it('explains when Ollama is down', async () => {
    const e = await detectEngines({ ...base, fetch: refused, version: versions({}) });
    expect(e.ollama.ready).toBe(false);
    expect(e.ollama.ready === false && e.ollama.why).toMatch(/Ollama isn’t running/);
  });

  it('Ollama up with no models says how to get one', async () => {
    const e = await detectEngines({ ...base, fetch: okJson({ models: [] }), version: versions({}) });
    expect(e.ollama.ready === false && e.ollama.why).toMatch(/ollama pull/);
  });

  it('codex and gemini are ready when --version answers', async () => {
    const e = await detectEngines({ ...base, fetch: refused, version: versions({ codex: 'codex-cli 0.157.0\n', gemini: '0.20.1\n' }) });
    expect(e.codex).toEqual({ ready: true, version: 'codex-cli 0.157.0' });
    expect(e.gemini).toEqual({ ready: true, version: '0.20.1' });
  });

  it('missing CLIs say how to install them', async () => {
    const e = await detectEngines({ ...base, fetch: refused, version: versions({}) });
    expect(e.codex.ready === false && e.codex.why).toMatch(/npm i -g @openai\/codex/);
    expect(e.gemini.ready === false && e.gemini.why).toMatch(/npm i -g @google\/gemini-cli/);
  });

  it('codex installed but signed out says to sign in', async () => {
    const e = await detectEngines({ ...base, fetch: refused, version: versions({ codex: 'codex-cli 0.157.0' }, {}) });
    expect(e.codex.ready).toBe(false);
    expect(e.codex.ready === false && e.codex.why).toMatch(/codex login/);
  });

  it('gemini installed but signed out says to sign in', async () => {
    const e = await detectEngines({ ...base, geminiSignedIn: () => false, fetch: refused, version: versions({ gemini: '0.68.0' }) });
    expect(e.gemini.ready).toBe(false);
    expect(e.gemini.ready === false && e.gemini.why).toMatch(/sign in/i);
    const ok = await detectEngines({ ...base, geminiSignedIn: () => true, fetch: refused, version: versions({ gemini: '0.68.0' }) });
    expect(ok.gemini.ready).toBe(true);
  });
});
