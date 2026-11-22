/**
 * Validator for one outbox JSON line. The watcher is defensive: any line
 * that doesn't parse or doesn't carry `from.agent`, `from.shell`, and
 * `body` is silently skipped, so a malformed append from an agent can't
 * crash the main process or ingest garbage.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__, maybeRotateOutbox, OUTBOX_MAX_BYTES } from '@main/chat/outbox-watcher';

const { validateOutboxLine } = __test__;

describe('outbox validateOutboxLine', () => {
  it('accepts a minimal well-formed line', () => {
    const res = validateOutboxLine({ from: { agent: 'claude', shell: 0 }, body: 'hi' });
    expect(res).toEqual({ from: { agent: 'claude', shell: 0 }, body: 'hi', to: undefined, reply_in: undefined });
  });

  it('passes through `to` and `reply_in` when present', () => {
    const res = validateOutboxLine({
      from: { agent: 'codex', shell: 2 },
      to: [{ agent: 'human' }],
      body: 'done',
      reply_in: 'msg-123',
    });
    expect(res?.to).toEqual([{ agent: 'human' }]);
    expect(res?.reply_in).toBe('msg-123');
  });

  it('rejects missing `from`', () => {
    expect(validateOutboxLine({ body: 'hi' })).toBeNull();
  });

  it('rejects non-string agent', () => {
    expect(validateOutboxLine({ from: { agent: 7, shell: 0 }, body: 'hi' })).toBeNull();
  });

  it('rejects non-number shell', () => {
    expect(validateOutboxLine({ from: { agent: 'claude', shell: '0' }, body: 'hi' })).toBeNull();
  });

  it('rejects missing body', () => {
    expect(validateOutboxLine({ from: { agent: 'claude', shell: 0 } })).toBeNull();
  });

  it('rejects non-object input (null, string, array, number)', () => {
    expect(validateOutboxLine(null)).toBeNull();
    expect(validateOutboxLine('hi')).toBeNull();
    expect(validateOutboxLine([])).toBeNull();
    expect(validateOutboxLine(42)).toBeNull();
  });
});

describe('maybeRotateOutbox', () => {
  it('leaves a small file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-rot-'));
    const path = join(dir, 'chat-outbox.jsonl');
    writeFileSync(path, 'small');
    expect(maybeRotateOutbox(path, 1024)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.old`)).toBe(false);
  });

  it('is a no-op when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-rot-'));
    expect(maybeRotateOutbox(join(dir, 'does-not-exist.jsonl'))).toBe(false);
  });

  it('moves an oversized file to .old and clears the way for a fresh file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-rot-'));
    const path = join(dir, 'chat-outbox.jsonl');
    const body = 'x'.repeat(2048);
    writeFileSync(path, body);
    expect(maybeRotateOutbox(path, 1024)).toBe(true);
    expect(existsSync(path)).toBe(false); // the live file is gone, next appender recreates it
    expect(readFileSync(`${path}.old`, 'utf8')).toBe(body);
  });

  it('overwrites a prior .old on a second rotation (keeps exactly one backup)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-rot-'));
    const path = join(dir, 'chat-outbox.jsonl');
    writeFileSync(path, 'first-gen'.repeat(300));
    maybeRotateOutbox(path, 1024);
    writeFileSync(path, 'second-gen'.repeat(300));
    expect(maybeRotateOutbox(path, 1024)).toBe(true);
    expect(readFileSync(`${path}.old`, 'utf8').startsWith('second-gen')).toBe(true);
  });

  it('defaults to the 1 MiB cap', () => {
    expect(OUTBOX_MAX_BYTES).toBe(1024 * 1024);
    const dir = mkdtempSync(join(tmpdir(), 'outbox-rot-'));
    const path = join(dir, 'chat-outbox.jsonl');
    writeFileSync(path, 'y'.repeat(512));
    // Explicit arg omitted — uses OUTBOX_MAX_BYTES, so 512 B must not rotate.
    expect(maybeRotateOutbox(path)).toBe(false);
    expect(statSync(path).size).toBe(512);
  });
});
