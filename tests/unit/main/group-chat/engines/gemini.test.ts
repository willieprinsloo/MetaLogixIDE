// Gemini through the Gemini CLI: its arguments, and reading `--output-format stream-json` events.
// Ported from BotOffice windows/test/engine-gemini.test.js (attachment folders dropped).
import { describe, it, expect } from 'vitest';
import { geminiArgs, geminiProgress, parseGemini } from '@main/group-chat/engines/gemini';

const BASE = ['--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--skip-trust'];
const ev = (o: unknown) => JSON.stringify(o);
const run = (lines: unknown[]) => { const p = geminiProgress(); const ch = lines.map((l) => p.feed(ev(l))); return { p, ch }; };

describe('geminiArgs', () => {
  it('a first turn edits without asking (no shell), message on stdin', () => {
    expect(geminiArgs({ text: '', engineSession: null })).toEqual(BASE);
  });

  it('a later turn resumes its session', () => {
    expect(geminiArgs({ text: '', engineSession: '7f3c1b2a-0000-4000-8000-000000000001' })).toEqual([...BASE, '--resume', '7f3c1b2a-0000-4000-8000-000000000001']);
  });

  it('the model is passed, an odd one is not', () => {
    expect(geminiArgs({ text: '', model: 'gemini-2.5-pro' })).toEqual([...BASE, '-m', 'gemini-2.5-pro']);
    expect(geminiArgs({ text: '', model: '--yolo' }).includes('--yolo')).toBe(false);
  });
});

describe('geminiProgress / parseGemini', () => {
  it('progress: session, live text from deltas, steps, edited files and tokens', () => {
    const { p, ch } = run([
      { type: 'init', session_id: 's-1', model: 'gemini-2.5-pro' },
      { type: 'message', role: 'user', content: 'tidy notes' },
      { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { absolute_path: 'H:/p/notes.md' } },
      { type: 'tool_result', tool_id: 't1', status: 'success' },
      { type: 'tool_use', tool_name: 'replace', tool_id: 't2', parameters: { file_path: 'H:/p/notes.md', old_string: 'a', new_string: 'b' } },
      { type: 'tool_result', tool_id: 't2', status: 'success' },
      { type: 'tool_use', tool_name: 'write_file', tool_id: 't3', parameters: { file_path: 'H:/p/new.md', content: 'x' } },
      { type: 'tool_result', tool_id: 't3', status: 'error', error: { message: 'denied' } },
      { type: 'message', role: 'assistant', content: 'Tidied ', delta: true },
      { type: 'message', role: 'assistant', content: 'notes.md', delta: true },
      { type: 'result', status: 'success', stats: { total_tokens: 900, input_tokens: 850, output_tokens: 50 } },
    ]);
    expect(p.sessionId).toBe('s-1');
    expect(p.model).toBe('gemini-2.5-pro');
    expect(p.text).toBe('Tidied notes.md');
    expect(p.steps).toEqual(['Read H:/p/notes.md', 'Edited H:/p/notes.md', 'Wrote H:/p/new.md']);
    expect(p.changed).toEqual(['H:/p/notes.md']);
    expect(p.tokens).toEqual({ in: 850, out: 50 });
    expect(ch[1]).toBe(false);
  });

  it('success gives the reply and session', () => {
    const { p } = run([{ type: 'init', session_id: 's-2' }, { type: 'message', role: 'assistant', content: 'hi', delta: true }, { type: 'result', status: 'success', stats: { input_tokens: 3, output_tokens: 1 } }]);
    expect(parseGemini(p, 0)).toEqual({ ok: true, reply: 'hi', engineSession: 's-2' });
  });

  it('an error result reports its message and keeps the session', () => {
    const { p } = run([{ type: 'init', session_id: 's-3' }, { type: 'result', status: 'error', error: { type: 'FatalAuthenticationError', message: 'Please set an Auth method' } }]);
    const r = parseGemini(p, 41);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Please set an Auth method/);
    expect(r.engineSession).toBe('s-3');
  });

  it('no result line at all', () => {
    expect(parseGemini(geminiProgress(), 1).error).toMatch(/Gemini exited without an answer \(code 1\)/);
  });

  it('a plain error event is kept for the message', () => {
    const { p } = run([{ type: 'error', severity: 'error', message: 'quota exceeded' }]);
    expect(parseGemini(p, 1).error).toMatch(/quota exceeded/);
  });
});
