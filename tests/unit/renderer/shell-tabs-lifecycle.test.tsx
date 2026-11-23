// @vitest-environment jsdom
/** Exercises shell chip membership commits in React with controlled browser geometry and animation completion. */
import {
  ShellTabsBar,
  type ShellTabMotion,
  type ShellTabsBarItem,
} from '@renderer/components/ShellTabsBar';
import { SHELL_TAB_TEST_ID } from '@shared/agent-state';
import { act, createRef, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProfiles = vi.hoisted(() => vi.fn());
vi.mock('@renderer/api', () => ({
  api: {
    invoke(channel: string, payload: unknown) {
      if (channel !== 'shells:cli-profiles-list') throw new Error(`Unexpected IPC: ${channel}`);
      return listProfiles(payload);
    },
  },
}));
vi.mock('@renderer/components/ShellTabDot', () => ({ ShellTabDot: () => null }));

type TabsProps = ComponentProps<typeof ShellTabsBar>;

interface RecordedAnimation {
  readonly target: Element;
  readonly frames: Keyframe[];
  readonly cancel: () => void;
  onfinish: (() => void) | null;
}

const PROJECT = 7;
const CHIP = `[data-testid="${SHELL_TAB_TEST_ID}"]`;
const GHOST = '[data-testid="shell-tab-leaving"]';
const MENU = '[data-new-shell-menu]';
const ANIMATE_DESCRIPTOR = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
const A = shell(0, 'Terminal');
const B = shell(1, 'Editor');
const C = shell(2, 'Monitor');

let container: HTMLDivElement;
let root: Root;
let time: number;
let scrollLeft: number;
let media: EventTarget & { matches: boolean };
let animations: RecordedAnimation[];

function shell(
  shellIndex: number,
  launchName: string,
  startedAt = '2026-02-01T10:00:00Z',
): ShellTabsBarItem {
  return {
    projectId: PROJECT,
    shellIndex,
    pinned: false,
    startedAt,
    lastActiveAt: null,
    launchName,
  };
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

function query(selector: string): HTMLElement {
  return requireValue(container.querySelector<HTMLElement>(selector), selector);
}

function chip(index: number): HTMLElement {
  return query(`${CHIP}[data-shell-index="${index}"]`);
}

function members(): Array<string | undefined> {
  return Array.from(
    container.querySelectorAll<HTMLElement>(CHIP),
    (node) => node.dataset.shellIndex,
  );
}

function menuButton(text: string): HTMLButtonElement {
  return requireValue(
    Array.from(container.querySelectorAll<HTMLButtonElement>(`${MENU} button`)).find((button) =>
      button.textContent?.includes(text),
    ),
    text,
  );
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click();
  });
}

function setup() {
  const motionRef = createRef<ShellTabMotion>();
  const onClose = vi.fn<TabsProps['onClose']>();
  const onSelect = vi.fn<TabsProps['onSelect']>();
  const onLaunchPlainTab = vi.fn<TabsProps['onLaunchPlainTab']>();
  const onLaunchProfile = vi.fn<TabsProps['onLaunchProfile']>();
  const onLaunchCustom = vi.fn<TabsProps['onLaunchCustom']>();
  return {
    onClose,
    onSelect,
    onLaunchPlainTab,
    onLaunchProfile,
    onLaunchCustom,
    motion: () => requireValue(motionRef.current, 'chip motion ref'),
    async commit(shells: readonly ShellTabsBarItem[], active = 0) {
      await act(async () => {
        root.render(
          <ShellTabsBar
            projectId={PROJECT}
            defaultCliName={null}
            shells={shells}
            active={active}
            motionRef={motionRef}
            onClose={onClose}
            onSelect={onSelect}
            onLaunchPlainTab={onLaunchPlainTab}
            onLaunchProfile={onLaunchProfile}
            onLaunchCustom={onLaunchCustom}
          />,
        );
      });
    },
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  time = 1000;
  scrollLeft = 0;
  animations = [];
  listProfiles.mockReset();
  listProfiles.mockResolvedValue({ profiles: [{ name: 'Editor', scope: 'global' }] });
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => media);
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches(CHIP) && this.parentElement) {
      const position = Array.from(this.parentElement.children).indexOf(this);
      return new DOMRect(30 + position * 60 - scrollLeft, 21, 56, 24);
    }
    if (this.firstElementChild?.matches(CHIP))
      return new DOMRect(30, 18, this.childElementCount * 60 - 20, 30);
    return new DOMRect(10, 12, 200, 30);
  });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value(this: Element, frames: Keyframe[]) {
      const animation = { target: this, frames, cancel: vi.fn(), onfinish: null };
      animations.push(animation);
      return animation;
    },
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (ANIMATE_DESCRIPTOR) Object.defineProperty(Element.prototype, 'animate', ANIMATE_DESCRIPTOR);
  else Reflect.deleteProperty(Element.prototype, 'animate');
});

describe('shell tab motion', () => {
  it('fades a confirmed menu launch and shifts only the live chip displaced by the insertion', async () => {
    const view = setup();
    await view.commit([A, C]);
    const first = chip(0);
    const displaced = chip(2);
    const trigger = query('[data-testid="tabbar-new-shell"]');
    expect(first.parentElement?.contains(trigger)).toBe(false);
    expect(animations).toHaveLength(0);

    await click(trigger);
    expect(listProfiles).toHaveBeenCalledWith({ projectId: PROJECT });
    await click(menuButton('Terminal'));
    expect(container.querySelector(MENU)).toBeNull();
    expect(view.onLaunchPlainTab).toHaveBeenCalledOnce();
    const confirm = requireValue(view.onLaunchPlainTab.mock.calls[0]?.[0], 'launch confirmation');
    confirm(1);
    await view.commit([A, { ...C, lastActiveAt: '2026-02-01T11:00:00Z' }], 2);
    expect(animations).toHaveLength(0);
    await view.commit([A, B, C], 1);

    expect(members()).toEqual(['0', '1', '2']);
    expect(chip(0)).toBe(first);
    expect(chip(2)).toBe(displaced);
    expect(animations.map(({ target, frames }) => ({ target, frames }))).toEqual([
      {
        target: chip(1),
        frames: [
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'none' },
        ],
      },
      { target: displaced, frames: [{ transform: 'translateX(-60px)' }, { transform: 'none' }] },
    ]);
    const slide = requireValue(animations[1], 'insertion slide');
    requireValue(slide.onfinish, 'slide completion')();
    await view.commit([C, B, A]);
    expect(members()).toEqual(['2', '1', '0']);
    expect(animations).toHaveLength(2);
    expect(slide.cancel).not.toHaveBeenCalled();
  });

  it('shows a clipped, inert exit copy only after a requested close commits', async () => {
    const view = setup();
    scrollLeft = 12;
    await view.commit([A, B, C]);
    const closing = chip(1);
    const survivor = chip(2);
    await click(survivor);
    expect(view.onSelect).toHaveBeenCalledWith(2);
    view.onSelect.mockClear();
    await click(query('button[aria-label="Close Editor"]'));
    expect(view.onClose).toHaveBeenCalledWith(1, expect.any(Function));
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(chip(1)).toBe(closing);
    expect(container.querySelector(GHOST)).toBeNull();

    await view.commit([A, C]);
    expect(members()).toEqual(['0', '2']);
    expect(closing.isConnected).toBe(false);
    const ghost = query(GHOST);
    expect(ghost.textContent).toContain('Editor');
    expect(ghost.inert).toBe(true);
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.hasAttribute('data-shell-index')).toBe(false);
    expect(ghost.style).toMatchObject({ left: '48px', top: '3px', width: '56px', height: '24px' });
    expect(ghost.parentElement?.style).toMatchObject({
      overflow: 'hidden',
      left: '20px',
      top: '6px',
      width: '160px',
      height: '30px',
    });
    expect(animations.map(({ target, frames }) => ({ target, frames }))).toEqual([
      {
        target: ghost,
        frames: [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'translateY(6px)' },
        ],
      },
      { target: survivor, frames: [{ transform: 'translateX(60px)' }, { transform: 'none' }] },
    ]);
    const exit = requireValue(animations[0], 'exit fade');
    const clip = ghost.parentElement;
    requireValue(exit.onfinish, 'exit completion')();
    expect(clip?.isConnected).toBe(false);
    expect(container.querySelector(GHOST)).toBeNull();
    expect(chip(2)).toBe(survivor);

    await view.commit([C, A]);
    expect(requireValue(animations[1], 'close reflow').cancel).toHaveBeenCalledOnce();
    expect(animations).toHaveLength(2);
  });

  it.each([false, true])(
    'tracks individual close cancellations (one close remains: %s)',
    async (stillPending) => {
      const view = setup();
      await view.commit([A, B]);
      expect(view.motion().beginClose(9)).toBeUndefined();
      const cancelFirst = requireValue(view.motion().beginClose(1), 'first close cancellation');
      const cancelSecond = requireValue(view.motion().beginClose(1), 'second close cancellation');
      cancelFirst();
      if (!stillPending) cancelSecond();
      await view.commit([A]);
      expect(members()).toEqual(['0']);
      expect(container.querySelector(GHOST)?.textContent ?? null).toBe(
        stillPending ? 'Editor' : null,
      );
      expect(animations).toHaveLength(stillPending ? 1 : 0);
    },
  );

  it('does not animate a close copy outside the old scroller viewport', async () => {
    const view = setup();
    scrollLeft = 60;
    await view.commit([A, B]);
    expect(chip(0).getBoundingClientRect().right).toBeLessThan(
      chip(1).parentElement?.getBoundingClientRect().left ?? 0,
    );
    expect(view.motion().beginClose(0)).toBeTypeOf('function');
    await view.commit([B]);
    expect(members()).toEqual(['1']);
    expect(container.querySelector(GHOST)).toBeNull();
    expect(animations.map(({ target }) => target)).toEqual([chip(1)]);
  });

  it.each([
    ['unconfirmed', null, [A, B, C]],
    ['popout or split removal', null, [C]],
    ['wrong index', 5, [A, B, C]],
    ['multi-add', 1, [A, B, C, shell(3, 'Other')]],
    ['replacement', 1, [A, B]],
  ] as const)('does not animate unsolicited membership changes: %s', async (_, confirmed, next) => {
    const view = setup();
    await view.commit([A, C]);
    if (confirmed !== null)
      requireValue(view.motion().launchResult(), 'launch confirmation')(confirmed);
    await view.commit(next);
    expect(members()).toEqual(next.map((member) => String(member.shellIndex)));
    expect(animations).toHaveLength(0);
  });

  it('ignores a stale launch callback following an intervening membership commit', async () => {
    const view = setup();
    await view.commit([A, C]);
    const confirm = requireValue(view.motion().launchResult(), 'launch confirmation');
    await view.commit([C, A]);
    confirm(1);
    await view.commit([C, B, A]);
    expect(members()).toEqual(['2', '1', '0']);
    expect(animations).toHaveLength(0);
  });

  it('does not carry a pending close from an old process into the same index after reuse', async () => {
    const view = setup();
    await view.commit([A, B]);
    const old = chip(1);
    expect(view.motion().beginClose(1)).toBeTypeOf('function');
    await view.commit([A, shell(1, 'Replacement', '2026-02-01T12:00:00Z')]);
    expect(chip(1)).not.toBe(old);
    expect(chip(1).textContent).toContain('Replacement');
    expect(query(GHOST).textContent).toContain('Editor');
    await view.commit([A]);
    expect(members()).toEqual(['0']);
    expect(animations).toHaveLength(1);
    expect(container.querySelectorAll(GHOST)).toHaveLength(1);
  });

  it('expires a confirmed entrance if the membership update takes too long', async () => {
    const view = setup();
    await view.commit([A, C]);
    requireValue(view.motion().launchResult(), 'launch confirmation')(1);
    time += 1000;
    await view.commit([A, B, C]);
    expect(members()).toEqual(['0', '1', '2']);
    expect(animations).toHaveLength(0);
  });

  it('cancels current reflow when reduced motion changes and fades subsequent adds and closes without translation', async () => {
    const view = setup();
    const inserted = shell(3, 'Second editor');
    await view.commit([A, C]);
    requireValue(view.motion().launchResult(), 'launch confirmation')(1);
    await view.commit([A, B, C]);
    const slide = requireValue(animations[1], 'normal-motion reflow');
    expect(slide.target).toBe(chip(2));

    await act(async () => {
      media.matches = true;
      media.dispatchEvent(new Event('change'));
    });
    expect(slide.cancel).toHaveBeenCalledOnce();
    animations.length = 0;
    requireValue(view.motion().launchResult(), 'reduced-motion confirmation')(3);
    await view.commit([A, B, inserted, C]);
    expect(animations.map(({ target, frames }) => ({ target, frames }))).toEqual([
      { target: chip(3), frames: [{ opacity: 0 }, { opacity: 1 }] },
    ]);
    expect(view.motion().beginClose(3)).toBeTypeOf('function');
    await view.commit([A, B, C]);
    expect(animations).toHaveLength(2);
    expect(animations[1]).toMatchObject({
      target: query(GHOST),
      frames: [{ opacity: 1 }, { opacity: 0 }],
    });
  });
});

describe('new-shell popup', () => {
  it('keeps open on an inside press, dismisses on Escape and outside press, and wires a saved profile confirmation', async () => {
    const view = setup();
    await view.commit([A]);
    const trigger = query('[data-testid="tabbar-new-shell"]');
    await click(trigger);
    await act(async () => {
      menuButton('Editor').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector(MENU)).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(container.querySelector(MENU)).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector(MENU)).toBeNull();
    await click(trigger);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector(MENU)).toBeNull();
    await click(trigger);
    await click(menuButton('Editor'));
    expect(container.querySelector(MENU)).toBeNull();
    expect(view.onLaunchProfile).toHaveBeenCalledOnce();
    expect(view.onLaunchProfile).toHaveBeenCalledWith('Editor', expect.any(Function));
    requireValue(view.onLaunchProfile.mock.calls[0]?.[1], 'profile confirmation')(1);
    await view.commit([A, B]);
    expect(animations.map(({ target }) => target)).toEqual([chip(1)]);
  });

  it('only submits a valid custom command and wires its tab confirmation', async () => {
    const view = setup();
    await view.commit([A]);
    await click(query('[data-testid="tabbar-new-shell"]'));
    await click(menuButton('Add a custom command'));
    expect(menuButton('Run').disabled).toBe(true);
    const command = query('input[placeholder^="Command"]');
    const setInput = requireValue(
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set,
      'native input setter',
    );
    await act(async () => {
      setInput.call(command, '  monitor --follow  ');
      command.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(menuButton('Run').disabled).toBe(false);
    await click(menuButton('Run'));
    expect(container.querySelector(MENU)).toBeNull();
    expect(view.onLaunchCustom).toHaveBeenCalledOnce();
    expect(view.onLaunchCustom).toHaveBeenCalledWith(
      'monitor',
      'monitor --follow',
      true,
      expect.any(Function),
    );
    requireValue(view.onLaunchCustom.mock.calls[0]?.[3], 'custom command confirmation')(2);
    await view.commit([A, C]);
    expect(animations.map(({ target }) => target)).toEqual([chip(2)]);
  });
});
