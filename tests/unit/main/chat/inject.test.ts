import { describe, it, expect, vi } from 'vitest';
import { formatInjectionLine, wireChatInjector } from '@main/chat/inject';
import { createReplyCap } from '@main/chat/cap';
import type { ChatEntry } from '@shared/chat';
import type { RosterRow } from '@main/chat/roster';

const base = (p: Partial<ChatEntry> = {}): ChatEntry => ({
  id: 'e1',
  ts: '',
  from: { device: 'laptop', shell: 1, agent: 'claude' },
  to: [{ agent: 'codex' }],
  body: 'hi there',
  ...p,
});

const row = (p: Partial<RosterRow> = {}): RosterRow => ({
  device: 'laptop',
  shell: 2,
  agent: 'codex',
  label: 'codex',
  state: null,
  mention: '@codex',
  ...p,
});

describe('formatInjectionLine', () => {
  it('strips \\r \\n and ANSI, keeps the prefix contract', () => {
    const line = formatInjectionLine(base({ body: 'red\x1b[31mX\x1b[0m\r\nend' }), 'laptop');
    expect(line).toBe('[metaide-chat from=@claude@laptop reply=- ] redX end\n');
  });
  it('reply=<msgId> when reply_in is set', () => {
    expect(formatInjectionLine(base({ reply_in: 'root-7' }), 'laptop')).toMatch(/reply=root-7 /);
  });
});

describe('wireChatInjector', () => {
  it('fires PtyManager.write for every matching local recipient', () => {
    const pty = { write: vi.fn() };
    const subs: Array<(p: { projectId: number; entry: ChatEntry }) => void> = [];
    wireChatInjector({
      pty,
      roster: () => [row({ shell: 2, agent: 'codex' })],
      cap: createReplyCap(),
      selfDevice: 'laptop',
      onCapHeld: vi.fn(),
      hooks: { onChatChanged: (cb) => { subs.push(cb); } },
    });
    subs[0]!({ projectId: 42, entry: base({ to: [{ agent: 'codex' }] }) });
    expect(pty.write).toHaveBeenCalledWith(42, 2, expect.stringContaining('[metaide-chat'));
  });

  it('cap=cap triggers onCapHeld and does NOT write', () => {
    const pty = { write: vi.fn() };
    const cap = { admit: () => 'cap' as const, release: () => [] };
    const onCapHeld = vi.fn();
    const subs: Array<(p: { projectId: number; entry: ChatEntry }) => void> = [];
    wireChatInjector({
      pty,
      roster: () => [row({ shell: 2, agent: 'codex' })],
      cap,
      selfDevice: 'laptop',
      onCapHeld,
      hooks: { onChatChanged: (cb) => { subs.push(cb); } },
    });
    subs[0]!({ projectId: 1, entry: base() });
    expect(onCapHeld).toHaveBeenCalled();
    expect(pty.write).not.toHaveBeenCalled();
  });

  it('@human recipient is never injected', () => {
    const pty = { write: vi.fn() };
    const subs: Array<(p: { projectId: number; entry: ChatEntry }) => void> = [];
    wireChatInjector({
      pty,
      roster: () => [row({ shell: 3, agent: 'human' })],
      cap: createReplyCap(),
      selfDevice: 'laptop',
      onCapHeld: vi.fn(),
      hooks: { onChatChanged: (cb) => { subs.push(cb); } },
    });
    subs[0]!({ projectId: 1, entry: base({ to: [{ agent: 'human' }] }) });
    expect(pty.write).not.toHaveBeenCalled();
  });

  it('empty to list is logged-only — no injection', () => {
    const pty = { write: vi.fn() };
    const subs: Array<(p: { projectId: number; entry: ChatEntry }) => void> = [];
    wireChatInjector({
      pty,
      roster: () => [row({ shell: 2, agent: 'codex' })],
      cap: createReplyCap(),
      selfDevice: 'laptop',
      onCapHeld: vi.fn(),
      hooks: { onChatChanged: (cb) => { subs.push(cb); } },
    });
    subs[0]!({ projectId: 1, entry: base({ to: [] }) });
    expect(pty.write).not.toHaveBeenCalled();
  });
});
