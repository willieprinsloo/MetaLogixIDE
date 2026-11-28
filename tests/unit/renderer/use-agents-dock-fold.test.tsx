// @vitest-environment jsdom
/** useAgentsDockFold against the real terminal geometry hold: who holds, when it is released, and the fold's flags. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentsDockFold } from '@renderer/hooks/useAgentsDockFold';
import type { DockFoldInput } from '@renderer/agents-dock-fold';
import type { FoldCustom } from '@renderer/pane-fold';
import { holdTerminalGeometry, isTerminalGeometryHeld, onTerminalGeometryRelease } from '@renderer/terminal-geometry-hold';

interface Result { custom: FoldCustom; onFoldComplete: () => void }

let root: Root | null = null;
let latest: Result | null = null;
const media = { matches: false, listeners: new Set<() => void>() };

function Probe(props: DockFoldInput) {
  latest = useAgentsDockFold(props);
  return null;
}

function render(input: DockFoldInput): void {
  act(() => { root!.render(<Probe {...input} />); });
}

const result = (): Result => latest!;
const complete = (): void => { act(() => { result().onFoldComplete(); }); };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  media.matches = false;
  media.listeners.clear();
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return media.matches; },
    addEventListener: (_: 'change', cb: () => void) => { media.listeners.add(cb); },
    removeEventListener: (_: 'change', cb: () => void) => { media.listeners.delete(cb); },
  }));
  root = createRoot(document.createElement('div'));
  render({ setting: false, context: true, source: 'migration' });
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  latest = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAgentsDockFold', () => {
  it('starts at rest with no hold and one-step flags', () => {
    expect(isTerminalGeometryHeld()).toBe(false);
    expect(result().custom).toEqual({ instant: true, reduced: false });
  });

  it('holds terminal geometry through a pointer open and releases it when the fold completes (AC13)', () => {
    render({ setting: true, context: true, source: 'pointer' });
    expect(result().custom).toEqual({ instant: false, reduced: false });
    expect(isTerminalGeometryHeld()).toBe(true);
    complete();
    expect(isTerminalGeometryHeld()).toBe(false);
  });

  it('holds through a pointer close too (AC13)', () => {
    render({ setting: true, context: true, source: 'shortcut' });
    render({ setting: false, context: true, source: 'pointer' });
    expect(isTerminalGeometryHeld()).toBe(true);
    complete();
    expect(isTerminalGeometryHeld()).toBe(false);
  });

  it('releases the hold within the 1s watchdog when completion is never reported (AC14)', () => {
    vi.useFakeTimers();
    render({ setting: true, context: true, source: 'pointer' });
    expect(isTerminalGeometryHeld()).toBe(true);
    act(() => { vi.advanceTimersByTime(999); });
    expect(isTerminalGeometryHeld()).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(isTerminalGeometryHeld()).toBe(false);
  });

  it('takes a fresh hold for the next slide after the watchdog gave up on a lost completion (AC13, AC14)', () => {
    vi.useFakeTimers();
    render({ setting: true, context: true, source: 'pointer' });
    act(() => { vi.advanceTimersByTime(1000); });
    render({ setting: false, context: true, source: 'pointer' });
    expect(isTerminalGeometryHeld()).toBe(true);
    complete();
    expect(isTerminalGeometryHeld()).toBe(false);
  });

  it('shares the hold with another fold and releases once, when the later one ends (AC15)', () => {
    const releases = vi.fn();
    const unsubscribe = onTerminalGeometryRelease(releases);
    render({ setting: true, context: true, source: 'pointer' });
    const releaseOther = holdTerminalGeometry();
    complete();
    expect(isTerminalGeometryHeld()).toBe(true);
    expect(releases).not.toHaveBeenCalled();
    releaseOther();
    expect(isTerminalGeometryHeld()).toBe(false);
    expect(releases).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('waits for the dock when the other fold ends first (AC15)', () => {
    render({ setting: true, context: true, source: 'pointer' });
    const releaseOther = holdTerminalGeometry();
    releaseOther();
    expect(isTerminalGeometryHeld()).toBe(true);
    complete();
    expect(isTerminalGeometryHeld()).toBe(false);
  });

  it.each(['shortcut', 'migration'] as const)('takes no hold for a %s toggle, and switches in one step (AC9, AC13, AC16)', (source) => {
    render({ setting: true, context: true, source });
    expect(isTerminalGeometryHeld()).toBe(false);
    expect(result().custom.instant).toBe(true);
  });

  it('keeps holding when a pointer toggle reverses the slide, and renews the watchdog (AC6)', () => {
    vi.useFakeTimers();
    render({ setting: true, context: true, source: 'pointer' });
    act(() => { vi.advanceTimersByTime(600); });
    render({ setting: false, context: true, source: 'pointer' });
    act(() => { vi.advanceTimersByTime(600); });
    expect(isTerminalGeometryHeld()).toBe(true);
    expect(result().custom.instant).toBe(false);
    complete();
    expect(isTerminalGeometryHeld()).toBe(false);
  });

  it.each([
    ['⌘J flips', false],
    ['⇧⌘A leaves the setting open', true],
  ] as const)('keeps the hold until the fold completes when %s mid-slide, then switches in one step (AC11, AC13)', (_, setting) => {
    render({ setting: true, context: true, source: 'pointer' });
    render({ setting, context: true, source: 'shortcut' });
    expect(result().custom).toEqual({ instant: true, reduced: false });
    expect(isTerminalGeometryHeld()).toBe(true);
    complete();
    expect(isTerminalGeometryHeld()).toBe(false);
  });

  it.each([false, true])('refits the terminals exactly once when a shortcut ends a pointer slide (setting %s) and the fold then completes (AC13)', (setting) => {
    const releases = vi.fn();
    const unsubscribe = onTerminalGeometryRelease(releases);
    render({ setting: true, context: true, source: 'pointer' });
    render({ setting, context: true, source: 'shortcut' });
    render({ setting, context: true, source: 'shortcut' });
    expect(releases).not.toHaveBeenCalled();
    complete();
    complete();
    expect(releases).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('releases a shortcut-ended slide within the 1s watchdog when completion is never reported (AC11, AC14)', () => {
    vi.useFakeTimers();
    render({ setting: true, context: true, source: 'pointer' });
    render({ setting: false, context: true, source: 'shortcut' });
    act(() => { vi.advanceTimersByTime(999); });
    expect(isTerminalGeometryHeld()).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(isTerminalGeometryHeld()).toBe(false);
  });

  it('releases at once when the context changes mid-fold (AC22)', () => {
    render({ setting: true, context: true, source: 'pointer' });
    render({ setting: true, context: false, source: 'pointer' });
    expect(isTerminalGeometryHeld()).toBe(false);
    expect(result().custom.instant).toBe(true);
  });

  it('follows a live reduced-motion change (AC12)', () => {
    render({ setting: true, context: true, source: 'pointer' });
    expect(result().custom.reduced).toBe(false);
    act(() => {
      media.matches = true;
      for (const cb of [...media.listeners]) cb();
    });
    expect(result().custom).toEqual({ instant: false, reduced: true });
  });
});
