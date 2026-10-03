import { describe, it, expect } from 'vitest';
import { classifyHookEvent, NEEDS_INPUT_TYPES, parseHookEvent, stateTransitionFor, type HookEvent } from '@main/claude-hooks/hook-event';

const common = {
  session_id: 'abc123',
  transcript_path: '/Users/x/.claude/projects/p/abc123.jsonl',
  cwd: '/Users/x/p',
};

describe('parseHookEvent', () => {
  it('parses the documented Notification example and keeps only the fields the app uses', () => {
    const raw = {
      ...common,
      hook_event_name: 'Notification',
      message: 'Claude needs your permission',
      title: 'Permission needed',
      notification_type: 'permission_prompt',
    };
    expect(parseHookEvent(raw)).toEqual({
      hookEventName: 'Notification',
      notificationType: 'permission_prompt',
      message: 'Claude needs your permission',
      backgroundTaskCount: 0,
    });
  });

  it('parses a real Stop payload, stripping unknown fields such as last_assistant_message', () => {
    const raw = { ...common, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'secret reply', background_tasks: [] };
    const parsed = parseHookEvent(raw);
    expect(parsed).toEqual({ hookEventName: 'Stop', notificationType: null, message: null, backgroundTaskCount: 0 });
    expect(JSON.stringify(parsed)).not.toContain('secret reply');
  });

  it('parses a UserPromptSubmit payload without carrying the prompt', () => {
    const parsed = parseHookEvent({ ...common, hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' });
    expect(parsed).toEqual({ hookEventName: 'UserPromptSubmit', notificationType: null, message: null, backgroundTaskCount: 0 });
  });

  it.each([
    ['null', null],
    ['an array', [{ hook_event_name: 'Stop' }]],
    ['a string', 'Stop'],
    ['missing hook_event_name', { ...common }],
    ['empty hook_event_name', { hook_event_name: '' }],
    ['non-string hook_event_name', { hook_event_name: 42 }],
    ['non-string message', { hook_event_name: 'Notification', message: 5, notification_type: 'permission_prompt' }],
    ['object message', { hook_event_name: 'Notification', message: { text: 'x' } }],
    ['non-string notification_type', { hook_event_name: 'Notification', notification_type: ['permission_prompt'] }],
  ])('rejects %s', (_label, raw) => {
    expect(parseHookEvent(raw)).toBeNull();
  });

  it('treats an explicit null message or notification_type as absent', () => {
    expect(parseHookEvent({ hook_event_name: 'Notification', message: null, notification_type: null }))
      .toEqual({ hookEventName: 'Notification', notificationType: null, message: null, backgroundTaskCount: 0 });
  });
});

describe('parseHookEvent — background_tasks (AC24, AC27, AC28)', () => {
  const task = { id: 'bash_1', type: 'shell', command: 'rm -rf /tmp/SECRET-CMD', description: 'SECRET-DESC' };

  it('keeps only a count of background tasks, never their content (AC28)', () => {
    const parsed = parseHookEvent({ ...common, hook_event_name: 'Stop', background_tasks: [task] });
    expect(parsed).toEqual({ hookEventName: 'Stop', notificationType: null, message: null, backgroundTaskCount: 1 });
    expect(Object.keys(parsed!)).toEqual(['hookEventName', 'notificationType', 'message', 'backgroundTaskCount']);
    expect(JSON.stringify(parsed)).not.toMatch(/SECRET|bash_1|shell/);
  });

  it('counts every element', () => {
    const parsed = parseHookEvent({ hook_event_name: 'Stop', background_tasks: [task, { id: 'a', type: 'subagent' }, null] });
    expect(parsed?.backgroundTaskCount).toBe(3);
  });

  it('never reads the elements', () => {
    const tasks = new Proxy([task, task], {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) throw new Error(`element ${prop} was read`);
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(parseHookEvent({ hook_event_name: 'Stop', background_tasks: tasks })?.backgroundTaskCount).toBe(2);
  });

  it.each([['a string', 'x'], ['an object', {}], ['an object with length', { length: 5 }], ['null', null], ['a number', 3]])(
    'a non-array background_tasks (%s) counts as 0',
    (_label, value) => {
      expect(parseHookEvent({ hook_event_name: 'Stop', background_tasks: value })?.backgroundTaskCount).toBe(0);
    },
  );

  it('an absent background_tasks counts as 0', () => {
    expect(parseHookEvent({ hook_event_name: 'Stop' })?.backgroundTaskCount).toBe(0);
  });

  it('session_crons never counts as background work, and is not read (AC27)', () => {
    const raw = { hook_event_name: 'Stop', background_tasks: [] as unknown[] };
    Object.defineProperty(raw, 'session_crons', { enumerable: true, get: () => { throw new Error('session_crons was read'); } });
    expect(parseHookEvent(raw)?.backgroundTaskCount).toBe(0);
    expect(parseHookEvent({ hook_event_name: 'Stop', session_crons: [{ id: 'c1', schedule: '* * * * *' }] })?.backgroundTaskCount).toBe(0);
  });

  it('is parsed for every event, not only Stop', () => {
    expect(parseHookEvent({ hook_event_name: 'PreToolUse', background_tasks: [task] })?.backgroundTaskCount).toBe(1);
  });
});

describe('classifyHookEvent', () => {
  const notif = (notificationType: string | null) => ({ hookEventName: 'Notification', notificationType, message: 'm', backgroundTaskCount: 0 });

  it.each(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])(
    'Notification/%s is needs-input (AC1)',
    (type) => { expect(classifyHookEvent(notif(type))).toBe('needs-input'); },
  );

  it.each([
    'idle_prompt', 'auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed',
    'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled', 'some_future_type',
  ])('Notification/%s is ignored (AC3)', (type) => {
    expect(classifyHookEvent(notif(type))).toBe('ignored');
  });

  it('Notification without a notification_type is ignored', () => {
    expect(classifyHookEvent(notif(null))).toBe('ignored');
  });

  it('Stop is finished (AC2)', () => {
    expect(classifyHookEvent({ hookEventName: 'Stop', notificationType: null, message: null, backgroundTaskCount: 0 })).toBe('finished');
  });

  it.each(['SubagentStop', 'UserPromptSubmit', 'SessionEnd', 'PreToolUse', 'stop'])('%s is ignored (AC3)', (name) => {
    expect(classifyHookEvent({ hookEventName: name, notificationType: null, message: null, backgroundTaskCount: 0 })).toBe('ignored');
  });

  it('notification_type only counts on a Notification event', () => {
    expect(classifyHookEvent({ hookEventName: 'Stop', notificationType: 'permission_prompt', message: null, backgroundTaskCount: 0 })).toBe('finished');
    expect(classifyHookEvent({ hookEventName: 'PreToolUse', notificationType: 'permission_prompt', message: null, backgroundTaskCount: 0 })).toBe('ignored');
  });

  it('the needs-input set is exactly the four documented blocking types', () => {
    expect([...NEEDS_INPUT_TYPES].sort()).toEqual(['agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog', 'permission_prompt']);
  });
});

describe('stateTransitionFor (spec transition table)', () => {
  const ev = (hookEventName: string, notificationType: string | null = null, backgroundTaskCount = 0): HookEvent =>
    ({ hookEventName, notificationType, message: null, backgroundTaskCount });

  it.each(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'])('%s → busy (AC2, AC3)', (name) => {
    expect(stateTransitionFor(ev(name))).toBe('busy');
  });

  it('PermissionRequest → blocked (AC4)', () => {
    expect(stateTransitionFor(ev('PermissionRequest'))).toBe('blocked');
  });

  it.each(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])(
    'Notification/%s → blocked-unless-stale (AC4, stale needs-input row)',
    (type) => { expect(stateTransitionFor(ev('Notification', type))).toBe('blocked-unless-stale'); },
  );

  it.each([1, 2, 50])('Stop with %i background tasks → background (AC24)', (count) => {
    expect(stateTransitionFor(ev('Stop', null, count))).toBe('background');
  });

  it('Stop with no background tasks → idle (AC6, AC26)', () => {
    expect(stateTransitionFor(ev('Stop', null, 0))).toBe('idle');
  });

  it('StopFailure → idle, whatever its background count (AC6)', () => {
    expect(stateTransitionFor(ev('StopFailure'))).toBe('idle');
    expect(stateTransitionFor(ev('StopFailure', null, 3))).toBe('idle');
  });

  it('Notification/idle_prompt → idle-unless-waiting (AC6, AC25)', () => {
    expect(stateTransitionFor(ev('Notification', 'idle_prompt'))).toBe('idle-unless-waiting');
  });

  it('a background count on events other than Stop changes nothing', () => {
    expect(stateTransitionFor(ev('PreToolUse', null, 2))).toBe('busy');
    expect(stateTransitionFor(ev('PermissionRequest', null, 2))).toBe('blocked');
    expect(stateTransitionFor(ev('SubagentStop', null, 2))).toBeNull();
  });

  it.each([
    ['Notification', 'auth_success'], ['Notification', 'elicitation_complete'], ['Notification', 'agent_completed'],
    ['Notification', 'some_future_type'], ['Notification', null],
    ['PermissionDenied', null], ['SubagentStop', null], ['SessionEnd', null], ['SomeFutureEvent', null],
    ['stop', null], ['pretooluse', null],
  ])('%s/%s leaves the state unchanged (AC5)', (name, type) => {
    expect(stateTransitionFor(ev(name, type))).toBeNull();
  });

  it('notification_type only counts on a Notification event', () => {
    expect(stateTransitionFor(ev('SubagentStop', 'permission_prompt'))).toBeNull();
    expect(stateTransitionFor(ev('PermissionDenied', 'idle_prompt'))).toBeNull();
    expect(stateTransitionFor(ev('Stop', 'permission_prompt'))).toBe('idle');
  });

  it('does not treat inherited object keys as events', () => {
    expect(stateTransitionFor(ev('constructor'))).toBeNull();
    expect(stateTransitionFor(ev('toString'))).toBeNull();
    expect(stateTransitionFor(ev('__proto__'))).toBeNull();
  });
});
