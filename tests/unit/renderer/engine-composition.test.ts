// @vitest-environment jsdom
import { Terminal } from '@xterm/headless';
import { afterEach, expect, it, vi } from 'vitest';
import { registerClipboardOsc } from '@renderer/osc52';
import { openGhosttyWithStandby } from '@renderer/terminal/engine-composition';

const openGhosttyView = vi.hoisted(() => vi.fn());
vi.mock('@renderer/terminal/ghostty-view-engine', () => ({ openGhosttyView }));

const esc = '\x1b';
const osc = (payload: string) => `${esc}]52;c;${payload}\x07`;
const cleanups: (() => void)[] = [];

function setup({ snapshot = '', standbyAvailable = true } = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const term = new Terminal({ allowProposedApi: true });
  const clipboard = vi.fn<(text: string) => Promise<void>>(async () => {});
  const write = vi.fn((data: string, parsed?: () => void) => parsed?.());
  const candidate = { write, fit: () => undefined, dispose: vi.fn(() => host.replaceChildren()) };
  const candidateReady = Promise.withResolvers<typeof candidate>();
  let fault: (() => void) | undefined;
  openGhosttyView.mockImplementation((_host, _appearance, _signal, hooks: { fault: () => void }) => {
    fault = hooks.fault;
    return candidateReady.promise;
  });
  let advanceDrain: (() => void) | undefined;
  const standby = { write(data: string, parsed?: () => void) {
    if (data === '' && parsed) advanceDrain = () => term.write(data, parsed);
    else term.write(data, parsed);
  } };
  const states: string[] = [];
  const enableXterm = vi.fn();
  const view = openGhosttyWithStandby({
    host, standby, standbyAvailable: () => standbyAvailable, snapshot,
    enableClipboard: () => registerClipboardOsc(term, { writeText: clipboard, onError: vi.fn() }),
    canRefit: () => true, alignGrid: vi.fn(), send: vi.fn(), enableXterm,
    appearance: () => ({ fontSize: 12 }), onState: state => states.push(state.kind),
  });
  cleanups.push(() => { view.dispose(); term.dispose(); host.remove(); });
  return { host, candidateReady, candidate, view, clipboard, states, enableXterm,
    fault: () => fault?.(), isDraining: () => Boolean(advanceDrain),
    releaseDrain: () => { const finish = advanceDrain; advanceDrain = undefined; finish?.(); },
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  openGhosttyView.mockReset();
  document.body.replaceChildren();
});

it('handles live clipboard writes once during Ghostty startup and fallback, not replay or queries', async () => {
  const r = setup({ snapshot: `${osc('aGlzdG9yeQ==')}${esc}]52;c;` });
  r.view.write('cGFydGlhbA==\x07'); // Cannot complete the replay's truncated OSC.
  const message = osc('c3RhcnQ=');
  r.view.write(message.slice(0, -2));
  r.view.write(message.slice(-2));
  r.candidateReady.resolve(r.candidate);
  await vi.waitFor(() => expect(r.clipboard.mock.calls).toEqual([['start']]));
  expect(r.states.at(-1)).toBe('ghostty');
  r.fault();
  await vi.waitFor(() => expect(r.isDraining()).toBe(true));
  r.view.write(osc('ZHJhaW4='));
  r.view.write(osc('?'));
  await vi.waitFor(() => expect(r.clipboard.mock.calls).toEqual([['start'], ['drain']]));
  expect(r.enableXterm).not.toHaveBeenCalled();
  r.releaseDrain();
  await vi.waitFor(() => expect(r.isDraining()).toBe(true));
  r.releaseDrain();
  await vi.waitFor(() => expect(r.states.at(-1)).toBe('xterm'));
  r.view.write(osc('YWZ0ZXI='));
  await vi.waitFor(() => expect(r.clipboard.mock.calls).toEqual([['start'], ['drain'], ['after']]));
});

it.each(['none', 'field', 'field then blur', 'window blur'] as const)('focus restoration after drain with interaction: %s', async (interaction) => {
  const r = setup();
  r.candidateReady.resolve(r.candidate);
  await vi.waitFor(() => expect(r.states.at(-1)).toBe('ghostty'));
  const terminalInput = document.createElement('textarea');
  const otherInput = document.createElement('input');
  r.host.append(terminalInput);
  document.body.append(otherInput);
  terminalInput.focus();
  expect(document.activeElement).toBe(terminalInput);
  r.fault();
  await vi.waitFor(() => expect(r.isDraining()).toBe(true));
  if (interaction === 'field' || interaction === 'field then blur') otherInput.focus();
  if (interaction === 'field then blur') otherInput.blur();
  if (interaction === 'window blur') window.dispatchEvent(new Event('blur'));
  r.releaseDrain();
  await vi.waitFor(() => expect(r.enableXterm).toHaveBeenCalledWith(interaction === 'none'));
});

it('reveals Ghostty independently of an unavailable standby and then reports a failed handoff', async () => {
  const r = setup({ standbyAvailable: false });
  r.candidateReady.resolve(r.candidate);
  await vi.waitFor(() => expect(r.states.at(-1)).toBe('ghostty'));
  r.fault();
  await vi.waitFor(() => expect(r.states).toEqual(['loading', 'ghostty', 'recovering', 'failed']));
  expect(r.enableXterm).not.toHaveBeenCalled();
});
