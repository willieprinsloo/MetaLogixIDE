// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MetaprojectSessionProvider, useSignInIntent } from '@renderer/metaproject/session';

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }));
vi.mock('@renderer/api', () => ({ api: bridge }));
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
afterEach(() => { act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); });

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
