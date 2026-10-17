import { describe, expect, it, vi } from 'vitest';
import { ClaudeHookHistory } from '@main/notifications/claude-hook-history';
import { SessionRegistry } from '@main/claude-hooks/session-registry';
import type { ReceivedHook } from '@main/claude-hooks/receiver';

const shell = { projectId: 4, shellIndex: 1 };
const event = (hookEventName: string, extra: Record<string, unknown> = {}) => ({ hookEventName, notificationType: null, message: null, backgroundTaskCount: 0, ...extra });

describe('Claude hook notification history without dot authority', () => {
  it('confirms current session, preserves eligible finished and suppresses background or settled Stop', () => {
    const sessions = new SessionRegistry();
    const { id } = sessions.issue(shell);
    const history = new ClaudeHookHistory({ sessions, now: () => 10, lastOutputAt: () => 10 });
    const applied = vi.fn();
    history.onHookApplied(applied);
    const send = (hookEventName: string, extra = {}): void => history.handle({ shell, sessionId: id, event: event(hookEventName, extra) } as ReceivedHook);
    send('UserPromptSubmit');
    send('Stop', { backgroundTaskCount: 1 });
    expect(applied.mock.lastCall?.[0]).toMatchObject({ from: 'busy', to: 'busy' });
    send('Stop');
    expect(applied.mock.lastCall?.[0]).toMatchObject({ from: 'busy', to: 'idle' });
    send('Stop');
    expect(applied.mock.lastCall?.[0]).toMatchObject({ from: 'idle', to: 'idle' });
    expect(sessions.isConfirmed(shell)).toBe(true);
    sessions.release(shell);
    send('UserPromptSubmit');
    expect(applied).toHaveBeenCalledTimes(4);
  });

  it('does not notify a stale prompt after input answers prior blocked notification', () => {
    const sessions = new SessionRegistry();
    const { id } = sessions.issue(shell);
    const history = new ClaudeHookHistory({ sessions, now: () => 10, lastOutputAt: () => 10 });
    const applied = vi.fn();
    history.onHookApplied(applied);
    const inputPrompt = (): void => history.handle({ shell, sessionId: id, event: event('Notification', { notificationType: 'permission_prompt' }) } as ReceivedHook);
    inputPrompt();
    history.onInput(shell, '1');
    inputPrompt();
    expect(applied.mock.lastCall?.[0]).toMatchObject({ from: 'busy', to: 'busy' });
  });
});
