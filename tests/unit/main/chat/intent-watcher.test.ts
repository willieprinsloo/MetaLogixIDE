/**
 * Validator and rotation coverage for the agent-intent watcher. Same
 * defensiveness contract as the chat outbox: a malformed line is
 * silently dropped so a chatty agent writing nonsense can't crash
 * main or poison the status badge.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__, maybeRotateIntent, INTENT_MAX_BYTES } from '@main/chat/intent-watcher';

const { validateIntentLine } = __test__;

describe('intent validateIntentLine', () => {
  it('accepts a minimal well-formed line', () => {
    expect(validateIntentLine({ from: { agent: 'claude', shell: 0 }, text: 'writing tests' })).toEqual({
      from: { agent: 'claude', shell: 0 },
      text: 'writing tests',
    });
  });

  it('trims whitespace around text so a stray newline survives', () => {
    const res = validateIntentLine({ from: { agent: 'codex', shell: 2 }, text: '  on it  ' });
    expect(res?.text).toBe('on it');
  });

  it('rejects missing from', () => {
    expect(validateIntentLine({ text: 'hi' })).toBeNull();
  });

  it('rejects non-string agent', () => {
    expect(validateIntentLine({ from: { agent: 7, shell: 0 }, text: 'hi' })).toBeNull();
  });

  it('rejects non-number shell', () => {
    expect(validateIntentLine({ from: { agent: 'claude', shell: '0' }, text: 'hi' })).toBeNull();
  });

  it('rejects empty text (whitespace only) — a blank badge is noise', () => {
    expect(validateIntentLine({ from: { agent: 'claude', shell: 0 }, text: '   ' })).toBeNull();
  });

  it('rejects missing text', () => {
    expect(validateIntentLine({ from: { agent: 'claude', shell: 0 } })).toBeNull();
  });

  it('rejects non-object input (null, string, array, number)', () => {
    expect(validateIntentLine(null)).toBeNull();
    expect(validateIntentLine('hi')).toBeNull();
    expect(validateIntentLine([])).toBeNull();
    expect(validateIntentLine(42)).toBeNull();
  });
});

describe('maybeRotateIntent', () => {
  it('leaves a small file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-rot-'));
    const path = join(dir, 'intent-outbox.jsonl');
    writeFileSync(path, 'small');
    expect(maybeRotateIntent(path, 1024)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.old`)).toBe(false);
  });

  it('is a no-op when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-rot-'));
    expect(maybeRotateIntent(join(dir, 'intent-outbox.jsonl'))).toBe(false);
  });

  it('moves an oversized file to .old and leaves the path free for a fresh one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-rot-'));
    const path = join(dir, 'intent-outbox.jsonl');
    writeFileSync(path, 'x'.repeat(2048));
    expect(maybeRotateIntent(path, 1024)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.old`)).toBe(true);
    expect(statSync(`${path}.old`).size).toBe(2048);
  });

  it('a second rotation overwrites the prior .old so disk usage stays bounded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-rot-'));
    const path = join(dir, 'intent-outbox.jsonl');
    writeFileSync(path, 'x'.repeat(2048));
    maybeRotateIntent(path, 1024);
    writeFileSync(path, 'y'.repeat(4096));
    expect(maybeRotateIntent(path, 1024)).toBe(true);
    expect(statSync(`${path}.old`).size).toBe(4096);
  });

  it('uses the 1 MiB default cap', () => {
    expect(INTENT_MAX_BYTES).toBe(1 << 20);
  });
});
