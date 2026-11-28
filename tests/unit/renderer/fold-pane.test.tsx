// @vitest-environment jsdom
/** FoldPane under real motion: its size forms, the start bleed, and the inert-while-leaving opt-in. */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnimatePresence, LazyMotion, domAnimation } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoldPane, type FoldOptions, type FoldSize } from '@renderer/components/FoldPane';
import type { FoldCustom } from '@renderer/pane-fold';

const SLIDE: FoldCustom = { instant: false, reduced: false };
const INSTANT: FoldCustom = { instant: true, reduced: false };

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let setShown: (shown: boolean) => void = () => undefined;
let observed = 0;

interface HarnessProps { size: FoldSize; custom: FoldCustom; options?: FoldOptions; onFoldComplete?: (phase: 'enter' | 'exit') => void; children?: ReactNode }

function Harness({ size, custom, options, onFoldComplete, children }: HarnessProps) {
  const [shown, set] = useState(true);
  setShown = set;
  return (
    <LazyMotion features={domAnimation} strict>
      <AnimatePresence initial={false} custom={custom}>
        {shown && (
          <FoldPane key="pane" size={size} anchor="start" custom={custom} options={options} onFoldComplete={onFoldComplete}>
            {children ?? <button type="button">inside</button>}
          </FoldPane>
        )}
      </AnimatePresence>
    </LazyMotion>
  );
}

function mount(props: HarnessProps): void {
  act(() => { root!.render(<Harness {...props} />); });
}

const outer = (): HTMLElement | null => (host!.firstElementChild as HTMLElement | null);
const inner = (): HTMLElement => outer()!.firstElementChild as HTMLElement;
const classes = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const CLAMP = 'clamp(248px, calc(100cqw - 360px), 348px)';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  observed = 0;
  vi.stubGlobal('ResizeObserver', class {
    observe() { observed += 1; }
    disconnect() {}
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

describe('FoldPane size forms', () => {
  it('keeps the intrinsic form as before: measured, w-max, no bleed (AC27)', () => {
    mount({ size: 'intrinsic', custom: INSTANT });
    expect(outer()!.style.width).toBe('calc(var(--fold-size) * var(--fold))');
    expect(outer()!.style.marginInlineStart).toBe('');
    expect(outer()!.style.paddingInlineStart).toBe('');
    expect(classes(inner())).toEqual(expect.arrayContaining(['shrink-0', 'w-max']));
    expect(inner().getAttribute('style')).toBeNull();
    expect(observed).toBe(1);
  });

  it('keeps the share form as before (AC27)', () => {
    mount({ size: { share: 0.4 }, custom: INSTANT });
    expect(outer()!.style.width).toBe('calc(0.4 * 100% * var(--fold))');
    expect(outer()!.style.getPropertyValue('--fold-size')).toBe('');
    expect(outer()!.style.marginInlineStart).toBe('');
    expect(inner().style.width).toBe('calc(100% / max(var(--fold), 0.001))');
    expect(classes(inner())).not.toContain('w-max');
    expect(observed).toBe(0);
  });

  it('sizes the clamp form from its container in CSS, with no measuring (AC28, AC4)', () => {
    mount({ size: { clamp: { min: 248, max: 348, reserve: 360 } }, custom: INSTANT });
    expect(outer()!.style.getPropertyValue('--fold-size')).toBe(CLAMP);
    expect(outer()!.style.width).toBe('calc(var(--fold-size) * var(--fold))');
    expect(inner().style.width).toBe('var(--fold-size)');
    expect(classes(inner())).not.toContain('w-max');
    expect(classes(inner())).toContain('shrink-0');
    expect(observed).toBe(0);
  });

  it('bleeds the outer box to the start without moving its layout edge (AC23, AC24a)', () => {
    mount({ size: { clamp: { min: 248, max: 348, reserve: 360 } }, custom: INSTANT, options: { startBleedPx: 2 } });
    expect(outer()!.style.marginInlineStart).toBe('-2px');
    expect(outer()!.style.paddingInlineStart).toBe('2px');
    expect(outer()!.style.width).toBe('calc(var(--fold-size) * var(--fold) + 2px)');
    expect(outer()!.style.getPropertyValue('--fold-size')).toBe(CLAMP);
  });

  it('bleeds the share form the same way', () => {
    mount({ size: { share: 0.4 }, custom: INSTANT, options: { startBleedPx: 2 } });
    expect(outer()!.style.width).toBe('calc(0.4 * 100% * var(--fold) + 2px)');
    expect(outer()!.style.marginInlineStart).toBe('-2px');
  });
});

describe('FoldPane inertWhileExiting', () => {
  it('makes the leaving pane inert and blurs focus inside it the moment removal starts (AC5)', async () => {
    mount({ size: { clamp: { min: 248, max: 348, reserve: 360 } }, custom: SLIDE, options: { inertWhileExiting: true } });
    const pane = outer()!;
    expect(pane.hasAttribute('inert')).toBe(false);
    host!.querySelector('button')!.focus();
    expect(document.activeElement?.textContent).toBe('inside');
    act(() => { setShown(false); });
    expect(outer()).toBe(pane);
    expect(pane.hasAttribute('inert')).toBe(true);
    expect(pane.contains(document.activeElement)).toBe(false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(outer()).toBeNull();
  });

  it('does not take focus from outside the pane when it starts leaving', () => {
    mount({ size: 'intrinsic', custom: SLIDE, options: { inertWhileExiting: true } });
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    act(() => { setShown(false); });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('leaves the pane interactive while leaving when the option is off (AC27)', () => {
    mount({ size: 'intrinsic', custom: SLIDE });
    const pane = outer()!;
    host!.querySelector('button')!.focus();
    act(() => { setShown(false); });
    expect(outer()).toBe(pane);
    expect(pane.hasAttribute('inert')).toBe(false);
    expect(document.activeElement?.textContent).toBe('inside');
  });
});

const REDUCED: FoldCustom = { instant: false, reduced: true };
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const fold = (): number => Number(outer()!.style.getPropertyValue('--fold'));

async function slideIn(props: Omit<HarnessProps, 'custom'>, custom: FoldCustom = SLIDE): Promise<void> {
  mount({ ...props, custom: INSTANT });
  act(() => { setShown(false); });
  await wait(20);
  mount({ ...props, custom });
  act(() => { setShown(true); });
  await wait(90);
}

describe('FoldPane snapOnInstant', () => {
  const size: FoldSize = { clamp: { min: 248, max: 348, reserve: 360 } };

  it('ends a running slide-in at full open within two frames when the flags turn instant, and reports the enter (AC11)', async () => {
    const onFoldComplete = vi.fn();
    await slideIn({ size, options: { snapOnInstant: true }, onFoldComplete });
    expect(fold()).toBeGreaterThan(0);
    expect(fold()).toBeLessThan(1);
    onFoldComplete.mockClear();
    mount({ size, custom: INSTANT, options: { snapOnInstant: true }, onFoldComplete });
    await wait(34);
    expect(fold()).toBe(1);
    expect(onFoldComplete).toHaveBeenCalledWith('enter');
    await wait(300);
    expect(fold()).toBe(1);
  });

  it('ends a reduced-motion fade-in fully opaque when the flags turn instant (AC11, AC12)', async () => {
    await slideIn({ size, options: { snapOnInstant: true } }, REDUCED);
    expect(Number(outer()!.style.opacity)).toBeGreaterThan(0);
    expect(Number(outer()!.style.opacity)).toBeLessThan(1);
    mount({ size, custom: { instant: true, reduced: true }, options: { snapOnInstant: true } });
    await wait(34);
    expect(fold()).toBe(1);
    expect(outer()!.style.opacity).toBe('1');
    await wait(300);
    expect(outer()!.style.opacity).toBe('1');
  });

  it('does nothing to a pane that mounts or rests with instant flags', async () => {
    const onFoldComplete = vi.fn();
    mount({ size, custom: INSTANT, options: { snapOnInstant: true }, onFoldComplete });
    mount({ size, custom: INSTANT, options: { snapOnInstant: true }, onFoldComplete });
    await wait(34);
    expect(onFoldComplete).not.toHaveBeenCalled();
    expect(outer()!.style.opacity).toBe('');
  });

  it('keeps tweening when the option is off, as the sidebar and split do (AC27)', async () => {
    await slideIn({ size });
    const before = fold();
    mount({ size, custom: INSTANT });
    await wait(34);
    expect(fold()).toBeGreaterThan(before);
    expect(fold()).toBeLessThan(1);
  });
});
