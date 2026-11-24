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
    expect(txt).toContain('# metaide-chat-bus@v3');
    expect(txt).toContain('[metaide-chat');
    expect(txt).toContain('chat-outbox.jsonl');
  });

  it('includes the status-badge and writing-style sections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    ensureAgentStanza(dir, 'claude');
    const txt = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    // The v3 sections — the whole point of the bump.
    expect(txt).toContain('## Status badge');
    expect(txt).toContain('intent-outbox.jsonl');
    expect(txt).toContain('## Writing style');
    expect(txt).toContain('10th-grade');
  });

  it('upgrades a v2 stanza by replacing the whole block, not stacking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-'));
    const v2Body = [
      '# user rules',
      'use tabs',
      '',
      '# metaide-chat-bus@v2',
      '## metaIDE chat bus',
      'old v2 instructions that should not survive',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'CLAUDE.md'), v2Body);
    const res = ensureAgentStanza(dir, 'claude');
    expect(res.appended).toBe(true);
    const txt = readFileSync(res.file, 'utf8');
    // User's own content stays.
    expect(txt).toContain('use tabs');
    // Old v2 marker + its body are gone.
    expect(txt).not.toContain('# metaide-chat-bus@v2');
    expect(txt).not.toContain('old v2 instructions that should not survive');
    // Fresh v3 marker is present exactly once.
    expect(txt).toContain('# metaide-chat-bus@v3');
    expect(txt.split('# metaide-chat-bus@').length - 1).toBe(1);
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
    expect(txt).toContain('# metaide-chat-bus@v3');
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

  it('mentions the intent-outbox path and the writing-style rule', () => {
    const nudge = buildOnboardingNudge('codex');
    // The v3 nudge tells the agent what changed since v2 — intent file
    // and writing-style — so an agent running against the old stanza
    // knows which section to re-read.
    expect(nudge).toContain('intent-outbox.jsonl');
    expect(nudge).toContain('writing-style');
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
