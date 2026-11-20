// One headless CLI turn: spawn, message on stdin, events on stdout, a parsed result.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCliTurn } from '@main/group-chat/engines/run-cli';
import { codexArgs, codexProgress, parseCodex } from '@main/group-chat/engines/codex';
import { geminiArgs, geminiProgress, parseGemini } from '@main/group-chat/engines/gemini';

const FAKE_CODEX = resolve(__dirname, 'fake-codex.cjs');
const FAKE_GEMINI = resolve(__dirname, 'fake-gemini.cjs');
const cwd = mkdtempSync(join(tmpdir(), 'runcli-'));
const log = (name: string) => join(mkdtempSync(join(tmpdir(), 'fakelog-')), `${name}.jsonl`);

function codexTurn(text: string, env: Record<string, string>, signal = new AbortController().signal, engineSession: string | null = null) {
  return runCliTurn({
    cmd: [process.execPath, FAKE_CODEX], args: codexArgs({ text, engineSession }, { platform: 'linux' }), cwd, text,
    progress: codexProgress(), parse: parseCodex, signal, env,
  });
}

describe('runCliTurn', () => {
  it('returns the fake codex reply and thread id, with the message on stdin in the project folder', async () => {
    const file = log('codex');
    const r = await codexTurn('hello group', { FAKE_CODEX_LOG: file });
    expect(r).toEqual({ ok: true, reply: 'codex: hello group', engineSession: 'fake-thread-1' });
    const call = JSON.parse(readFileSync(file, 'utf8').trim()) as { cwd: string; stdin: string };
    expect(call.stdin).toBe('hello group');
    expect(resolve(call.cwd).toLowerCase()).toBe(resolve(cwd).toLowerCase());
  });

  it('resumes the thread it is given', async () => {
    const r = await codexTurn('again', { FAKE_CODEX_LOG: log('codex') }, undefined, 'thread-9');
    expect(r.engineSession).toBe('thread-9');
  });

  it('a failed turn reports the engine’s message', async () => {
    const r = await codexTurn('x', { FAKE_CODEX_LOG: log('codex'), FAKE_CODEX_FAIL: 'quota exceeded' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/quota exceeded/);
  });

  it('gemini: reply from deltas and its session', async () => {
    const r = await runCliTurn({
      cmd: [process.execPath, FAKE_GEMINI], args: geminiArgs({ text: 'hi' }), cwd, text: 'hi',
      progress: geminiProgress(), parse: parseGemini, signal: new AbortController().signal, env: { FAKE_GEMINI_LOG: log('gemini') },
    });
    expect(r).toEqual({ ok: true, reply: 'gemini: hi', engineSession: 'fake-gemini-session' });
  });

  it('a CLI that only writes to stderr reports that text', async () => {
    const r = await runCliTurn({
      cmd: [process.execPath, FAKE_GEMINI], args: geminiArgs({ text: 'hi' }), cwd, text: 'hi',
      progress: geminiProgress(), parse: parseGemini, signal: new AbortController().signal,
      env: { FAKE_GEMINI_LOG: log('gemini'), FAKE_GEMINI_STDERR: 'Please set an Auth method' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Please set an Auth method/);
  });

  it('a missing executable resolves to ok:false with an error, never throws', async () => {
    const r = await runCliTurn({
      cmd: [join(cwd, 'no-such-cli.exe')], args: [], cwd, text: 'x',
      progress: codexProgress(), parse: parseCodex, signal: new AbortController().signal,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("abort kills the child and resolves ok:false 'stopped'", async () => {
    const ctl = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 100);
    const r = await codexTurn('slow', { FAKE_CODEX_LOG: log('codex'), FAKE_CODEX_DELAY_MS: '10000' }, ctl.signal);
    expect(r).toEqual({ ok: false, reply: '', error: 'stopped' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
