import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAgentStanza, buildOnboardingNudge, nudgeAgentShell } from '@main/chat/onboard';

describe('ensureAgentStanza', () => {
  it('creates CLAUDE.md with the stanza and the marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    const res = ensureAgentStanza(dir, 'claude');
    expect(res.appended).toBe(true);
    const txt = readFileSync(res.file, 'utf8');
    expect(txt).toContain('# metaide-chat-bus@v2');
    expect(txt).toContain('[metaide-chat');
    expect(txt).toContain('chat-outbox.jsonl');
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

  it('opencode writes to AGENTS.md (same convention file as Codex)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    const res = ensureAgentStanza(dir, 'opencode');
    expect(res.file).toBe(join(dir, 'AGENTS.md'));
  });

  it('appends to an existing file rather than overwriting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    writeFileSync(join(dir, 'CLAUDE.md'), '# existing\n\nproject-specific rules\n');
    const res = ensureAgentStanza(dir, 'claude');
    const txt = readFileSync(res.file, 'utf8');
    expect(txt).toContain('existing');
    expect(txt).toContain('project-specific rules');
    expect(txt).toContain('# metaide-chat-bus@v2');
  });
});

describe('buildOnboardingNudge', () => {
  it('names CLAUDE.md for the claude CLI', () => {
    expect(buildOnboardingNudge('claude')).toContain('CLAUDE.md');
  });

  it('names AGENTS.md for codex and opencode', () => {
    expect(buildOnboardingNudge('codex')).toContain('AGENTS.md');
    expect(buildOnboardingNudge('opencode')).toContain('AGENTS.md');
  });

  it('points the agent at the chat-outbox path', () => {
    expect(buildOnboardingNudge('codex')).toContain('.metaide/chat-outbox.jsonl');
  });
});

describe('nudgeAgentShell', () => {
  it('writes the body wrapped in bracketed-paste markers and a separate CR', () => {
    vi.useFakeTimers();
    const writes: Array<{ projectId: number; shell: number; data: string }> = [];
    const pty = { write: (projectId: number, shell: number, data: string) => { writes.push({ projectId, shell, data }); } };
    nudgeAgentShell(pty, 42, 1, 'read-this');
    // First write is the bracketed body.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ projectId: 42, shell: 1, data: '\x1b[200~read-this\x1b[201~' });
    // CR arrives after the 40 ms gap, as a separate write.
    vi.advanceTimersByTime(40);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ projectId: 42, shell: 1, data: '\r' });
    vi.useRealTimers();
  });
});
