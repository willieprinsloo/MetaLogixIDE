// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MetaprojectSessionProvider, useSignInIntent } from '@renderer/metaproject/session';
import { ChatTab } from '@renderer/components/ChatTab';
import { MetaprojectPanel } from '@renderer/components/settings/MetaprojectPanel';
import { useAssignment } from '@renderer/metaproject/useAssignment';

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn<(channel: string, listener: (event: unknown) => void) => () => void>(() => () => {}), toast: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: bridge }));
vi.mock('@renderer/hooks/useToasts', () => ({ toast: bridge.toast }));
const origin = 'https://fixture.invalid';
const out = { phase: 'signed-out', epoch: 1, origin, configuredOrigin: origin };
const signed = { ...out, phase: 'signed-in', epoch: 2, actor: { id: 1, username: 'fixture' }, connected: true };
let root: Root;
let node: HTMLDivElement;
let resolveLogin: (value: unknown) => void;

function Entry({ target, resume }: { target: number; resume: () => void }) {
  const signIn = useSignInIntent(target);
  return <><button onClick={() => signIn(`Board for ${target}`, resume)}>Board</button>
    <button onClick={() => signIn('Chat')}>Chat</button></>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', { randomUUID: () => '0856d88e-bbed-4f3e-8157-b9d3a4b34eea' });
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation((channel) => {
    if (channel === 'metaproject:session-status' || channel === 'metaproject:session-cancel') return Promise.resolve(out);
    if (channel === 'metaproject:session-login') return new Promise((resolve) => { resolveLogin = resolve; });
    throw new Error(`Unexpected ${channel}`);
  });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(() => { act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); bridge.on.mockReset().mockImplementation(() => () => {}); bridge.toast.mockReset(); });

async function openAndSubmit() {
  await act(async () => node.querySelectorAll('button')[0]?.click());
  const dialog = node.querySelector('[role=dialog]');
  const username = dialog?.querySelector<HTMLInputElement>('input[name=username]');
  const password = dialog?.querySelector<HTMLInputElement>('input[name=password]');
  if (!username || !password) throw new Error('Missing sign-in fields');
  username.value = 'fixture'; password.value = 'fixture-only';
  await act(async () => dialog?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

it('shares one prompt and only resumes its owner after a successful sign-in', async () => {
  const resume = vi.fn();
  await act(async () => root.render(<MetaprojectSessionProvider><Entry target={1} resume={resume} /></MetaprojectSessionProvider>));
  await openAndSubmit();
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:session-login', expect.objectContaining({ epoch: 1, remember: false }));
  await act(async () => node.querySelectorAll('button')[1]?.click());
  expect(node.querySelectorAll('[role=dialog]')).toHaveLength(1);
  await act(async () => resolveLogin({ ok: true, value: signed }));
  expect(resume).toHaveBeenCalledWith(signed);
  expect(node.querySelector('[role=dialog]')).toBeNull();
});

it('cancels the submitted attempt when its target changes and ignores late completion', async () => {
  const resume = vi.fn();
  const show = (target: number) => <MetaprojectSessionProvider><Entry target={target} resume={resume} /></MetaprojectSessionProvider>;
  await act(async () => root.render(show(1)));
  await openAndSubmit();
  const login = bridge.invoke.mock.calls.find(([channel]) => channel === 'metaproject:session-login');
  expect(login).toBeDefined();
  await act(async () => root.render(show(2)));
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:session-cancel', { attemptId: login?.[1].attemptId });
  await act(async () => resolveLogin({ ok: true, value: signed }));
  expect(resume).not.toHaveBeenCalled();
});

async function renderSettings(snapshot: object) {
  const listeners = new Map<string, (event: unknown) => void>();
  bridge.on.mockImplementation((channel, listener) => { listeners.set(channel, listener); return () => { listeners.delete(channel); }; });
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:session-status') return snapshot;
    throw new Error(`Unexpected ${channel}`);
  });
  await act(async () => root.render(<MetaprojectSessionProvider><MetaprojectPanel /></MetaprojectSessionProvider>));
  const input = node.querySelector<HTMLInputElement>('input[data-testid="metaproject-base-url"]');
  if (!input) throw new Error('Missing service origin control');
  const button = (text: string) => [...node.querySelectorAll('button')].find((b) => b.textContent === text);
  return {
    input, button,
    click: async (text: string) => {
      const control = button(text);
      if (!control || control.disabled) throw new Error(`Unavailable ${text} button`);
      await act(async () => control.click());
    },
    change: (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }),
    changeSession: (snapshot: object) => act(async () => {
      const listener = listeners.get('metaproject:session-changed');
      if (!listener) throw new Error('Missing account status listener');
      listener(snapshot);
    }),
  };
}

it('validates and normalizes origin, and does not forget sign-in until the user confirms', async () => {
  const ui = await renderSettings(signed);
  const newOrigin = 'https://other.invalid';
  let fail = true;
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:session-origin') return fail ? { ok: false, reason: 'network' } : { ok: true, value: { ...out, epoch: 3, origin: newOrigin, configuredOrigin: newOrigin } };
    throw new Error(`Unexpected ${channel}`);
  });
  await ui.change(`${origin}/board`);
  await ui.click('Save service origin');
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('Enter an HTTPS origin');
  await ui.change('https://FIXTURE.invalid:443/');
  await ui.click('Save service origin');
  expect(ui.input.value).toBe(origin);
  await ui.change('https://OTHER.invalid:443/');
  await ui.click('Save service origin');
  const confirmation = node.querySelector('[aria-label="Confirm service origin change"]');
  expect(confirmation?.textContent).toContain(`Switch to ${newOrigin}? This signs you out`);
  expect(ui.button('Save service origin')?.disabled).toBe(true);
  await ui.click('Cancel origin change');
  expect(ui.button('Switch origin')).toBeUndefined();
  expect(bridge.invoke).not.toHaveBeenCalledWith('metaproject:session-origin', expect.anything());
  await ui.click('Save service origin');
  await ui.click('Switch origin');
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:session-origin', { epoch: 2, origin: newOrigin });
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('Could not reach Metaproject');
  expect(ui.input.value).toBe('https://OTHER.invalid:443/');
  fail = false;
  await ui.click('Save service origin');
  await ui.click('Switch origin');
  expect(ui.input.value).toBe(newOrigin);
  expect(ui.button('Sign out and forget')).toBeUndefined();
  expect(node.querySelector('[role="alert"]')).toBeNull();
});

it('discards an earlier epoch’s confirmation and lets the user retry incomplete forget', async () => {
  const ui = await renderSettings(signed);
  await ui.change('https://other.invalid');
  await ui.click('Save service origin');
  expect(ui.button('Switch origin')).toBeDefined();
  await ui.changeSession({ ...out, phase: 'signing-in', epoch: 3, attemptId: 'fixture-attempt' });
  expect(ui.button('Switch origin')).toBeUndefined();
  expect(ui.input.disabled).toBe(true);
  expect(ui.button('Save service origin')?.disabled).toBe(true);
  const incomplete = { ...out, epoch: 4, warning: 'forget-incomplete' };
  await ui.changeSession({ ...signed, epoch: 3 });
  let finish: ((value: unknown) => void) | undefined;
  bridge.invoke.mockImplementation(async (channel, input) => {
    if (channel === 'metaproject:session-logout' && input.epoch === 3) return new Promise((resolve) => { finish = resolve; });
    if (channel === 'metaproject:session-logout' && input.epoch === 4) return { ok: true, value: { ...out, epoch: 5 } };
    throw new Error(`Unexpected ${channel}`);
  });
  await ui.click('Sign out and forget');
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:session-logout', { epoch: 3 });
  expect(ui.button('Sign out and forget')?.disabled).toBe(true);
  expect(ui.input.disabled).toBe(true);
  await act(async () => finish?.({ ok: true, value: incomplete }));
  expect(node.textContent).toContain('could not clear remembered sign-in');
  await ui.click('Retry sign-out');
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:session-logout', { epoch: 4 });
  expect(bridge.invoke).not.toHaveBeenCalledWith('metaproject:session-origin', expect.anything());
  expect(ui.button('Retry sign-out')).toBeUndefined();
  expect(node.textContent).not.toContain('could not clear remembered sign-in');
});

const channelId = 9;
const remoteProjectId = 42;
const msg = (id: number, message: string) => ({ id, channel_id: channelId, user_id: 1, message, created_at: '2026-11-23T12:00:00Z', parent_message_id: null });

function chat() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  bridge.on.mockImplementation((channel, listener) => {
    const subscriptions = listeners.get(channel) ?? new Set();
    subscriptions.add(listener);
    listeners.set(channel, subscriptions);
    return () => { subscriptions.delete(listener); };
  });
  const emit = async (channel: string, event: unknown) => {
    const subscriptions = listeners.get(channel);
    if (!subscriptions?.size) throw new Error(`Missing listener for ${channel}`);
    await act(async () => { for (const listener of [...subscriptions]) listener(event); });
  };
  const defaultInvoke = (channel: string, allowed = true) => {
    if (channel === 'metaproject:session-status') return signed;
    if (channel === 'metaproject:list-users') return { users: [] };
    if (channel === 'metaproject:list-all-channels') return { channels: [{ id: channelId, project_id: null, name: 'general', is_private: false }] };
    if (channel === 'metaproject:assignment-list') return { ok: true, value: { epoch: 2, projects: allowed ? [{ id: remoteProjectId, name: 'Forty two' }] : [] } };
    if (channel === 'metaproject:join-channel') return { ok: true };
    throw new Error(`Unexpected ${channel}`);
  };
  const render = async () => act(async () => root.render(<MetaprojectSessionProvider><ChatTab projectId={0} assignment={{ kind: 'loading' }} compact /></MetaprojectSessionProvider>));
  const button = (name: string) => [...node.querySelectorAll('button')].find((item) => item.title === name || item.textContent === name);
  const click = async (name: string) => {
    const item = button(name);
    if (!item) throw new Error(`Missing ${name}`);
    await act(async () => item.click());
  };
  const input = async (value: string, edit = false) => {
    const field = node.querySelectorAll('textarea')[edit ? 0 : node.querySelectorAll('textarea').length - 1];
    if (!field) throw new Error('Missing chat draft');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return field;
  };
  return { emit, defaultInvoke, render, button, click, input };
}

it('uses the project room’s REST scope for all mutations and preserves a newer draft on refusal', async () => {
  const ui = chat();
  let rejectSend: ((reason: Error) => void) | undefined;
  let rejectEdit: ((reason: Error) => void) | undefined;
  vi.stubGlobal('confirm', () => true);
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:list-all-channels') return { channels: [{ id: channelId, project_id: remoteProjectId, name: 'project', is_private: false }] };
    if (channel === 'metaproject:list-messages') return { messages: [msg(10, 'original')] };
    if (channel === 'metaproject:send-message') return new Promise((_, reject) => { rejectSend = reject; });
    if (channel === 'metaproject:edit-message') return new Promise((_, reject) => { rejectEdit = reject; });
    if (channel === 'metaproject:delete-message') throw new Error('raw upstream failure');
    return ui.defaultInvoke(channel);
  });
  await ui.render();
  const scope = { channelId, projectId: remoteProjectId, epoch: 2 };
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:list-messages', { ...scope, limit: 50 });
  const composer = await ui.input('first message');
  await act(async () => composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:send-message', { ...scope, message: 'first message' });
  await ui.input('newer draft');
  await act(async () => rejectSend?.(new Error('raw upstream failure')));
  expect(composer.value).toBe('newer draft');
  expect(bridge.toast).toHaveBeenCalledWith('Could not send the message. Try again.', { kind: 'error' });
  await ui.click('Edit');
  const edit = await ui.input('first edit', true);
  await ui.click('Save');
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:edit-message', { ...scope, messageId: 10, message: 'first edit' });
  await ui.input('newer edit', true);
  await act(async () => rejectEdit?.(new Error('raw upstream failure')));
  expect(edit.value).toBe('newer edit');
  expect(bridge.toast).toHaveBeenCalledWith('Could not edit the message.', { kind: 'error' });
  await ui.click('Cancel');
  await ui.click('Delete');
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:delete-message', { ...scope, messageId: 10 });
  expect(bridge.toast).toHaveBeenCalledWith('Could not delete the message.', { kind: 'error' });
  for (const action of ['send-message', 'edit-message', 'delete-message']) expect(bridge.invoke.mock.calls.filter(([name]) => name === `metaproject:${action}`)).toHaveLength(1);
});

it.each(['empty', 'failed'])('submits in a global room with a %s project list and renders only a real echo', async (projects) => {
  const ui = chat();
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:send-global-message') return { submitted: true };
    if (channel === 'metaproject:assignment-list' && projects === 'failed') return { ok: false, reason: 'network' };
    return ui.defaultInvoke(channel, false);
  });
  await ui.render();
  expect(node.textContent).toContain('Message history is unavailable without an accessible Metaproject project');
  const composer = await ui.input('  real global message  ');
  expect(composer.disabled).toBe(false);
  await act(async () => composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:send-global-message', { epoch: 2, channelId, message: 'real global message' });
  expect(composer.value).toBe('');
  expect(bridge.invoke.mock.calls.some(([channel]) => channel === 'metaproject:list-messages' || channel === 'metaproject:send-message')).toBe(false);
  expect(node.textContent).not.toContain('real global message');
  const message = { ...msg(10, 'real global message'), project_id: null, attachments: [{ id: 8, filename: 'notes.txt', file_size: 10 }] };
  for (const [epoch, room, incoming] of [[1, channelId, message], [2, 11, { ...message, channel_id: 11 }], [2, channelId, { ...message, channel_id: 11 }]] as const) {
    await ui.emit('metaproject:chat-event', { epoch, event: 'channel_message', payload: { channel_id: room, message: incoming } });
    expect(node.textContent).not.toContain('real global message');
  }
  const echo = { epoch: 2, event: 'channel_message', payload: { channel_id: channelId, message } };
  await ui.emit('metaproject:chat-event', echo);
  await ui.emit('metaproject:chat-event', echo);
  expect(node.textContent?.match(/real global message/g)).toHaveLength(1);
  expect(ui.button('Edit')).toBeUndefined();
  expect(ui.button('Delete')).toBeUndefined();
  expect(node.textContent).toContain('notes.txt');
  expect(ui.button('Download to Downloads')?.disabled).toBe(true);
});

it('uses global dispatch even with a REST scope and retains unsent or newer input on failures', async () => {
  const ui = chat();
  let fail: ((reason: Error) => void) | undefined;
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:list-messages') return { messages: [] };
    if (channel === 'metaproject:send-global-message') return new Promise((_, reject) => { fail = reject; });
    return ui.defaultInvoke(channel);
  });
  await ui.render();
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:list-messages', { epoch: 2, channelId, projectId: remoteProjectId, limit: 50 });
  const composer = await ui.input('draft to keep');
  const enter = () => act(async () => composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await enter();
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:send-global-message', { epoch: 2, channelId, message: 'draft to keep' });
  await act(async () => fail?.(new Error('socket unavailable')));
  expect(composer.value).toBe('draft to keep');
  expect(bridge.toast).toHaveBeenCalledWith('Could not send the message. Try again.', { kind: 'error' });
  const sends = () => bridge.invoke.mock.calls.filter(([name]) => name === 'metaproject:send-global-message');
  expect(sends()).toHaveLength(1);
  await enter();
  await ui.input('different draft');
  await act(async () => fail?.(new Error('socket unavailable')));
  expect(composer.value).toBe('different draft');
  expect(sends()).toHaveLength(2);
  expect(bridge.invoke).not.toHaveBeenCalledWith('metaproject:send-message', expect.anything());
});

it('refreshes the scoped row after a REST edit acknowledgement without waiting for a socket echo', async () => {
  const ui = chat();
  let text = 'original';
  let reads = 0;
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:list-messages') { reads++; return { messages: [{ ...msg(10, text), project_id: null }] }; }
    if (channel === 'metaproject:edit-message') { text = 'acknowledged'; return { ok: true }; }
    return ui.defaultInvoke(channel);
  });
  await ui.render();
  expect(reads).toBe(1);
  await ui.click('Edit');
  await ui.input('acknowledged', true);
  await ui.click('Save');
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:edit-message', { epoch: 2, channelId, projectId: remoteProjectId, messageId: 10, message: 'acknowledged' });
  expect(reads).toBe(2);
  expect(node.textContent).toContain('acknowledged');
  expect(node.textContent).not.toContain('original');
});

it('refreshes only after a confirmed room rejoin and reconciles live edits and deletes before history resolves', async () => {
  const ui = chat();
  let reads = 0;
  let finish: ((value: unknown) => void) | undefined;
  let reconnect = false;
  const joins = new Map<number, (value: { ok: true }) => void>();
  bridge.invoke.mockImplementation(async (channel, input) => {
    if (channel === 'metaproject:list-all-channels') return { channels: [
      { id: channelId, project_id: null, name: 'general', is_private: false },
      { id: 11, project_id: remoteProjectId, name: 'project chat', is_private: false },
    ] };
    if (channel === 'metaproject:join-channel' && reconnect) return new Promise((resolve) => { joins.set(input.channelId, resolve); });
    if (channel === 'metaproject:list-messages') {
      if (++reads === 1) return { messages: [msg(10, 'stale edit')] };
      return new Promise((resolve) => { finish = resolve; });
    }
    return ui.defaultInvoke(channel);
  });
  await ui.render();
  expect(node.textContent).toContain('stale edit');
  await ui.emit('metaproject:session-changed', { ...signed, connected: false });
  expect(reads).toBe(1);
  reconnect = true;
  await ui.emit('metaproject:session-changed', signed);
  expect([...joins.keys()]).toEqual([channelId, 11]);
  expect(reads).toBe(1);
  await act(async () => joins.get(11)?.({ ok: true }));
  expect(reads).toBe(1);
  await act(async () => joins.get(channelId)?.({ ok: true }));
  expect(reads).toBe(2);
  expect(finish).toBeDefined();
  await ui.emit('metaproject:chat-event', { epoch: 2, event: 'channel_message_edited', payload: { channel_id: channelId, message: msg(10, 'live edit') } });
  await ui.emit('metaproject:chat-event', { epoch: 2, event: 'channel_message_deleted', payload: { channel_id: channelId, message_id: 11 } });
  await act(async () => finish?.({ messages: [msg(10, 'stale edit'), msg(11, 'stale deleted text'), { ...msg(12, '[message deleted]'), is_deleted: true }, msg(13, 'missed offline')] }));
  expect(node.textContent).toContain('live edit');
  expect(node.textContent).toContain('missed offline');
  expect(node.textContent).not.toContain('stale edit');
  expect(node.textContent).not.toContain('stale deleted text');
  expect([...node.querySelectorAll('button[title="Edit"]')]).toHaveLength(2);
});

it('keeps REST history available when the live join is refused and retries the subscription on request', async () => {
  const ui = chat();
  let denied = true;
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:join-channel' && denied) throw new Error('join refused');
    if (channel === 'metaproject:list-messages') return { messages: [msg(10, 'REST still works')] };
    return ui.defaultInvoke(channel);
  });
  await ui.render();
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:join-channel', { epoch: 2, channelId });
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('Could not subscribe to live Chat updates');
  expect(node.textContent).toContain('REST still works');
  const joins = () => bridge.invoke.mock.calls.filter(([name]) => name === 'metaproject:join-channel').length;
  const before = joins();
  denied = false;
  await ui.click('Retry Chat');
  expect(joins()).toBeGreaterThan(before);
  expect(node.querySelector('[role="alert"]')).toBeNull();
  expect(node.textContent).toContain('REST still works');
});

it('never borrows another project’s REST scope for its project room', async () => {
  const ui = chat();
  bridge.invoke.mockImplementation(async (channel) => {
    if (channel === 'metaproject:list-all-channels') return { channels: [{ id: channelId, project_id: 99, name: 'restricted', is_private: true }] };
    return ui.defaultInvoke(channel);
  });
  await ui.render();
  expect(node.textContent).toContain('No accessible Metaproject project for this channel');
  expect(node.querySelector('textarea')?.disabled).toBe(true);
  expect(bridge.invoke).not.toHaveBeenCalledWith('metaproject:list-messages', expect.anything());
});

function FolderChat() {
  const { state } = useAssignment(7);
  return <ChatTab projectId={7} assignment={state} compact />;
}

it('drops the old Chat draft and assignment scope when a generic rescan changes the linked file', async () => {
  const ui = chat();
  let currentId = 42;
  bridge.invoke.mockImplementation(async (channel, input) => {
    if (channel === 'metaproject:assignment-get') return { ok: true, value: { kind: 'linked', projectId: 7, remoteId: currentId, revision: String(currentId).padStart(64, '0'), localName: 'seven', localPath: '/fixture/seven', origin } };
    if (channel === 'metaproject:assignment-list') return { ok: true, value: { epoch: 2, projects: [{ id: 42, name: 'Forty two' }, { id: 43, name: 'Forty three' }] } };
    if (channel === 'metaproject:list-messages') return { messages: [msg(10, `history for ${input.projectId}`)] };
    return ui.defaultInvoke(channel);
  });
  await act(async () => root.render(<MetaprojectSessionProvider><FolderChat /></MetaprojectSessionProvider>));
  expect(node.textContent).toContain('history for 42');
  await ui.input('old assignment draft');
  const before = bridge.invoke.mock.calls.filter(([channel]) => channel === 'metaproject:assignment-get').length;
  currentId = 43;
  await ui.emit('projects:changed', { kind: 'updated' });
  expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'metaproject:assignment-get')).toHaveLength(before + 1);
  expect(bridge.invoke).toHaveBeenCalledWith('metaproject:list-messages', { projectId: 43, channelId, epoch: 2, limit: 50 });
  expect(node.textContent).toContain('history for 43');
  expect(node.textContent).not.toContain('history for 42');
  expect(node.querySelector('textarea')?.value).toBe('');
});
