import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAgentStanza } from '@main/chat/onboard';

describe('ensureAgentStanza', () => {
  it('creates CLAUDE.md with the stanza and the marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    const res = ensureAgentStanza(dir, 'claude');
    expect(res.appended).toBe(true);
    const txt = readFileSync(res.file, 'utf8');
    expect(txt).toContain('# metaide-chat-bus@v1');
    expect(txt).toContain('[metaide-chat');
    expect(txt).toContain('metaide chat send');
  });

  it('is idempotent — second call does not duplicate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    ensureAgentStanza(dir, 'claude');
    const res2 = ensureAgentStanza(dir, 'claude');
    expect(res2.appended).toBe(false);
  });

  it('codex writes to AGENTS.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    const res = ensureAgentStanza(dir, 'codex');
    expect(res.file).toBe(join(dir, 'AGENTS.md'));
  });

  it('ollama writes to .metaide/ollama-system.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    const res = ensureAgentStanza(dir, 'ollama');
    expect(res.file).toBe(join(dir, '.metaide', 'ollama-system.md'));
  });

  it('appends to an existing file rather than overwriting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    writeFileSync(join(dir, 'CLAUDE.md'), '# existing\n\nproject-specific rules\n');
    const res = ensureAgentStanza(dir, 'claude');
    const txt = readFileSync(res.file, 'utf8');
    expect(txt).toContain('existing');
    expect(txt).toContain('project-specific rules');
    expect(txt).toContain('# metaide-chat-bus@v1');
  });
});
