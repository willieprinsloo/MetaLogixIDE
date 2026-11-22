/**
 * Split shell cards (docs/specs/2026-10-06-split-shell-cards.md AC1–AC37,
 * Amendment 3 AC59–AC60, Amendment 4 AC61–AC62). Motion (AC42–AC57) lives
 * in motion.spec.ts.
 *
 * Every test launches its own app (helpers/focus.ts `launch`: isolated HOME,
 * SHELL=/bin/sh so the split's plain shell echoes typed commands, mock
 * Claude in shell 0). Colours are compared after the browser resolves them
 * (helpers/chrome-colour.ts), never as strings.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { SPLIT_COPY, SPLIT_TESTIDS } from '../../src/renderer/split-copy';
import { abbreviatePath } from '../../src/renderer/abbreviate-path';
import {
  launch, openProject, projectIdByName, projectRow, typeReachesPty, marker, waitForShellOutput,
  type Launched,
} from './helpers/focus';
import { colourDistance, elementColour, fmtColour, resolveToken, resolveColour } from './helpers/chrome-colour';
import { recordInsertions, insertions, recordIpc, ipcLog, startFrames, collectFrames, frameLog } from './helpers/frames';
import {
  RIGHT, LEFT, chipSel, splitState, openSplit, waitSettled, aliveIndices, paneLines,
  startPaneShellFrames, paneShellFrames, computedFor,
} from './helpers/split';

type Api = { invoke: (c: string, r: unknown) => Promise<never> };

const PALETTES = ['default', 'catppuccin', 'rose-pine'] as const;
const THEMES = ['dark', 'light'] as const;

/* ─────────────────────────────── helpers ─────────────────────────────── */

async function withApp(names: string[], body: (h: Launched) => Promise<void>): Promise<void> {
  const h = await launch(names);
  try {
    await openProject(h.win, names[0]!);
    await body(h);
  } finally {
    await h.app.close();
    h.cleanup();
  }
}

async function css(el: Locator, props: string[]): Promise<Record<string, string>> {
  return el.evaluate((node, ps) => {
    const cs = getComputedStyle(node);
    return Object.fromEntries(ps.map((p) => [p, cs.getPropertyValue(p)]));
  }, props);
}

async function rect(el: Locator): Promise<{ x: number; y: number; width: number; height: number; right: number }> {
  return el.evaluate((n) => {
    const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right };
  });
}

/** Asserts an element's resolved colour property equals a resolved token (within rounding). */
async function expectColour(
  win: Page, el: Locator, prop: 'color' | 'background-color', token: `--${string}`, what: string, soft = false,
): Promise<void> {
  const got = await elementColour(win, el, prop);
  const want = await resolveToken(win, token, el);
  (soft ? expect.soft : expect)(colourDistance(got, want), `${what}: ${prop} ${fmtColour(got)} should be ${token} ${fmtColour(want)}`).toBeLessThanOrEqual(3);
}

/** Left card width over the row's content width (the row is the left pane's parent). */
async function leftShare(win: Page): Promise<number> {
  return win.evaluate((sel) => {
    const left = document.querySelector(sel)!;
    const row = left.parentElement!;
    return left.getBoundingClientRect().width / row.getBoundingClientRect().width;
  }, LEFT);
}

async function projectPath(win: Page, name: string): Promise<string> {
  return win.evaluate(async (n: string) => {
    const { projects } = (await (window as unknown as { api: Api }).api.invoke('projects:list', undefined)) as unknown as {
      projects: Array<{ name: string; path: string }>;
    };
    return projects.find((p) => p.name === n)!.path;
  }, name);
}

/** The header label span: the header child right after the status dot. */
function headerLabel(header: Locator): Locator {
  return header.locator(':scope > span').nth(1);
}

async function hoverTooltip(win: Page, el: Locator): Promise<Locator> {
  await moveMouseAway(win);
  await el.hover();
  const tip = win.locator('[role="tooltip"]');
  await expect(tip, 'tooltip after hover (a physical pointer over the test window can steal the hover)').toBeVisible({ timeout: 3000 });
  return tip;
}

/** Selects a project by its sidebar row when the split may be showing (openProject expects one terminal). */
async function selectProject(win: Page, name: string): Promise<void> {
  await projectRow(win, name).click();
  await expect.poll(() => win.title()).toBe(`${name} — MetaLogix IDE`);
  await expect(win.locator(`${LEFT} .xterm-screen`)).toBeVisible({ timeout: 10000 });
}

async function moveMouseAway(win: Page): Promise<void> {
  const sb = await rect(win.getByTestId('status-bar'));
  await win.mouse.move(sb.x + 5, sb.y + sb.height / 2);
}

/** Keyboard-focus facts of the focused element. */
async function focusRing(el: Locator): Promise<{ focused: boolean; visible: boolean; outline: string; radius: string }> {
  return el.evaluate((n) => {
    const cs = getComputedStyle(n);
    return { focused: document.activeElement === n, visible: n.matches(':focus-visible'), outline: cs.outlineStyle, radius: cs.borderTopLeftRadius };
  });
}

/** Where DOM focus is: 'left-xterm', 'right-xterm', or a short description of the active element. */
async function focusWhere(win: Page): Promise<string> {
  return win.evaluate(({ l, r }) => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.classList.contains('xterm-helper-textarea')) {
      if (el.closest(l)) return 'left-xterm';
      if (el.closest(r)) return 'right-xterm';
      return 'other-xterm';
    }
    if (!el) return 'none';
    return `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}${el === document.body ? '(body)' : ''}`;
  }, { l: LEFT, r: RIGHT });
}

const pill = (win: Page) => win.getByTestId(SPLIT_TESTIDS.toggle);
const headers = (win: Page) => win.getByTestId(SPLIT_TESTIDS.header);
const gutter = (win: Page) => win.getByRole('separator', { name: SPLIT_COPY.resize });
const paneFocused = (win: Page) => win.evaluate(({ l, r }) => ({
  left: document.querySelector(l)?.getAttribute('data-pane-focused') ?? null,
  right: document.querySelector(r)?.getAttribute('data-pane-focused') ?? null,
}), { l: LEFT, r: RIGHT });

/* ─────────────────────────────── Split toolbar button ─────────────────────────────── */

test('the Split icon is an accessible toggle immediately before Popout, with Add beside the terminal tabs', async () => {
  await withApp(['alpha'], async ({ app, win }) => {
    const p = pill(win);
    await expect(p).toHaveText('');
    await expect(p.locator('svg')).toBeVisible();

    // AC2/AC3 unpressed.
    await expect(p).toHaveAttribute('aria-pressed', 'false');
    await expect(p).toHaveAccessibleName(SPLIT_COPY.buttonLabel);
    await moveMouseAway(win);
    const offBg = await elementColour(win, p, 'background-color');
    expect(offBg.a, 'unpressed background is transparent').toBe(0);
    await expectColour(win, p, 'color', '--text-muted', 'unpressed pill');
    await expect(await hoverTooltip(win, p)).toHaveText(SPLIT_COPY.tooltipOff);
    await expectColour(win, p, 'background-color', '--surface-hover', 'hovered unpressed pill');

    // The two far-right controls stay together, separate from the centered terminal strip.
    const geo = await win.evaluate((sel) => {
      const pillEl = document.querySelector(`[data-testid="${sel}"]`)!;
      const plus = document.querySelector('[data-testid="tabbar-new-shell"]')!;
      const chips = [...document.querySelectorAll('[data-testid="shell-tab-button"]')];
      const bar = pillEl.closest('[data-testid="main-tab-bar"]');
      if (!bar) throw new Error('Split must be in the workspace bar');
      return {
        chipsRight: Math.max(...chips.map((c) => c.getBoundingClientRect().right)),
        plusX: plus.getBoundingClientRect().x,
        plusRight: plus.getBoundingClientRect().right,
        pillX: pillEl.getBoundingClientRect().x,
        lastControls: [...bar.querySelectorAll('button')].slice(-2).map(el => el.getAttribute('data-testid')),
      };
    }, SPLIT_TESTIDS.toggle);
    expect(geo.chipsRight, 'chips come before the new-shell button').toBeLessThanOrEqual(geo.plusX);
    expect(geo.plusRight, 'new-shell button comes before the pill').toBeLessThan(geo.pillX);
    expect(geo.lastControls).toEqual([SPLIT_TESTIDS.toggle, 'popout-shell']);

    // AC4a: the + is outside the chips' horizontal scroller.
    const outside = await win.evaluate(() => {
      const chip = document.querySelector('[data-testid="shell-tab-button"]')!;
      let scroller: Element | null = chip.parentElement;
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
      const plus = document.querySelector('[data-testid="tabbar-new-shell"]')!;
      return { hasScroller: !!scroller, containsPlus: !!scroller?.contains(plus) };
    });
    expect(outside, 'the chips scroll, the + button is not inside that scroller').toEqual({ hasScroller: true, containsPlus: false });

    // AC4a: the menu stays beside Add, clamped to the workspace in a 900px window.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(900, 700); });
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(900);
    await win.getByTestId('tabbar-new-shell').click();
    const menu = win.locator('[data-new-shell-menu="1"]');
    await expect(menu).toBeVisible();
    await waitSettled(win);
    const m = await rect(menu);
    const plus = await rect(win.getByTestId('tabbar-new-shell'));
    const bar = await rect(win.getByTestId('main-tab-bar'));
    const left = Math.max(bar.x, Math.min(plus.x, bar.right - m.width));
    expect(m.x, 'menu anchors to Add when space permits, otherwise stays inside the bar').toBeCloseTo(left, 0);
    expect(m.y).toBeGreaterThanOrEqual(plus.y + plus.height);
    expect(m.right, 'menu fits in the workspace').toBeLessThanOrEqual(bar.right + 0.5);
    await win.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1400, 900); });

    // Keyboard reaches Split just before Popout, with a visible focus ring.
    await win.getByTestId('reveal-project-folder').focus();
    await win.keyboard.press('Tab');
    const ring = await focusRing(p);
    expect(ring.focused, 'Tab from Reveal Folder lands on Split').toBe(true);
    expect(ring.visible && ring.outline !== 'none', 'visible keyboard focus ring').toBe(true);

    // Keyboard activation opens the split.
    await win.keyboard.press('Space');
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toBeVisible();
    await expect(p).toHaveAttribute('aria-pressed', 'true');
    await expect(p, 'the name does not change with state').toHaveAccessibleName(SPLIT_COPY.buttonLabel);
    await expect(await hoverTooltip(win, p)).toHaveText(SPLIT_COPY.tooltipOn);
    await moveMouseAway(win);
    await p.blur();
    await expectColour(win, p, 'background-color', '--accent-soft', 'pressed pill', true);
    await expectColour(win, p, 'color', '--accent-soft-text', 'pressed pill', true);

    await p.click();
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toHaveCount(0);
    await expect(p).toHaveAttribute('aria-pressed', 'false');
  });
});

/* ─────────────────────────────── cards and gutter ─────────────────────────────── */

test('split cards expose workspace chrome through the gap and keep drag and keyboard resize', async () => {
  await withApp(['alpha'], async ({ app, win }) => {
    const projectId = await projectIdByName(win, 'alpha');
    const workspace = win.locator('main');
    const single = await rect(win.locator('[data-testid="shell-tab"]'));

    // AC12 single mode: no card, inset or header.
    await expect(headers(win)).toHaveCount(0);
    expect((await css(win.locator(LEFT), ['border-top-left-radius'])) ['border-top-left-radius'], 'single pane has no card radius').toBe('0px');
    expect(await win.evaluate((s) => getComputedStyle(document.querySelector(s)!.parentElement!).padding, LEFT), 'single pane has no inset').toBe('0px');
    const singleSurface = await elementColour(win, workspace, 'background-color');
    await expect(workspace).toHaveCSS('border-top-width', '1px');

    await openSplit(win, 'alpha');
    expect.soft((await elementColour(win, workspace, 'background-color')).a, 'no shared terminal background under the gutter').toBe(0);
    expect.soft((await css(workspace, ['border-width']))['border-width'], 'no border framing both cards').toBe('0px');
    // Each card paints the terminal surface independently and reaches the workspace edges.
    for (const sel of [LEFT, RIGHT]) {
      const card = win.locator(sel);
      expect.soft((await css(card, ['border-top-left-radius', 'border-bottom-right-radius'])), `${sel} radius`).toEqual({
        'border-top-left-radius': '14px', 'border-bottom-right-radius': '14px',
      });
      expect.soft(await elementColour(win, card, 'background-color'), `${sel} uses the same surface as the single terminal`).toEqual(singleSurface);
    }
    const [outer, left, right] = await Promise.all([workspace, win.locator(LEFT), win.locator(RIGHT)].map(rect));
    expect.soft([left.x, left.y, left.height], 'left card aligns with the workspace').toEqual([outer.x, outer.y, outer.height]);
    expect.soft([right.x + right.width, right.y, right.height], 'right card aligns with the workspace').toEqual([outer.x + outer.width, outer.y, outer.height]);

    // AC7 gutter and grip.
    const g = gutter(win);
    const gb = await rect(g);
    expect(gb.width, 'gutter 10px').toBe(10);
    expect(gb.x).toBeCloseTo(left.x + left.width, 1);
    expect(gb.x + gb.width).toBeCloseTo(right.x, 1);
    const gcss = await css(g, ['cursor', 'background-color']);
    expect(gcss.cursor).toBe('col-resize');
    expect((await resolveColour(win, gcss['background-color']!)).a, 'gutter transparent').toBe(0);
    const grip = g.locator(':scope > *').first();
    const gripBox = await rect(grip);
    expect([gripBox.width, gripBox.height], 'grip 3x36').toEqual([3, 36]);
    expect((await css(grip, ['border-top-left-radius']))['border-top-left-radius']).toBe('2px');
    expect(Math.abs(gripBox.x + 1.5 - (gb.x + 5)), 'grip centred horizontally').toBeLessThanOrEqual(0.5);
    await moveMouseAway(win);
    await expectColour(win, grip, 'background-color', '--split-grip', 'grip at rest');
    await g.hover();
    await expectColour(win, grip, 'background-color', '--accent', 'grip on hover');

    // AC8 semantics.
    await expect(g).toHaveAttribute('aria-orientation', 'vertical');
    await expect(g).toHaveAttribute('aria-valuemin', '15');
    await expect(g).toHaveAttribute('aria-valuemax', '85');
    await expect(g).toHaveAttribute('aria-valuenow', '50');
    // AC11 fresh split at 0.5.
    expect(await leftShare(win), 'fresh split left share').toBeCloseTo(0.5, 2);

    // AC9 drag: live value and accent while dragging, clamped, persisted.
    const row = await win.evaluate((s) => { const r = document.querySelector(s)!.parentElement!.getBoundingClientRect(); return { x: r.x, right: r.right }; }, LEFT);
    await win.mouse.move(gb.x + 5, gb.y + gb.height / 2);
    await win.mouse.down();
    await win.mouse.move(row.x + 2, gb.y + gb.height / 2, { steps: 6 });
    await expect(g, 'live during the drag, clamped at 15').toHaveAttribute('aria-valuenow', '15');
    await win.mouse.move(row.x + (row.right - row.x) * 0.3, gb.y + gb.height / 2, { steps: 3 });
    await expectColour(win, grip, 'background-color', '--accent', 'grip while dragging, pointer off the gutter');
    await win.mouse.move(row.right - 2, gb.y + gb.height / 2, { steps: 6 });
    await expect(g, 'clamped at 85').toHaveAttribute('aria-valuenow', '85');
    await win.mouse.up();
    await expect.poll(async () => (await splitState(win, projectId))?.splitRatio, { message: 'drag ratio persisted' }).toBe(0.85);
    expect(await leftShare(win)).toBeCloseTo(0.85, 2);

    // AC11: opening a split resets to 0.5, at any window width.
    await pill(win).click();
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toHaveCount(0);
    await openSplit(win, 'alpha');
    await expect(g).toHaveAttribute('aria-valuenow', '50');
    expect(await leftShare(win), 'reopened split resets to 0.5').toBeCloseTo(0.5, 2);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 800); });
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(1000);
    await waitSettled(win);
    expect(await leftShare(win), '0.5 at a 1000px window').toBeCloseTo(0.5, 2);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(1400, 900); });
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(1400);
    await waitSettled(win);

    // AC10 keyboard: focusing the gutter leaves the mark on the left; arrows step 0.02, clamp, persist.
    expect(await paneFocused(win)).toEqual({ left: 'true', right: 'false' });
    await g.focus();
    for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowLeft');
    await expect(g).toHaveAttribute('aria-valuenow', '44');
    await expect.poll(async () => (await splitState(win, projectId))?.splitRatio).toBe(0.44);
    expect(await leftShare(win)).toBeCloseTo(0.44, 2);
    expect(await paneFocused(win), 'focusing the gutter (inside the right pane wrapper) does not mark a pane').toEqual({ left: 'true', right: 'false' });
    await win.keyboard.press('ArrowRight');
    await expect(g).toHaveAttribute('aria-valuenow', '46');
    for (let i = 0; i < 20; i++) await win.keyboard.press('ArrowLeft');
    await expect(g, 'keyboard clamps at 15').toHaveAttribute('aria-valuenow', '15');
    await expect.poll(async () => (await splitState(win, projectId))?.splitRatio).toBe(0.15);
    // Gutter focus ring: reached by Shift+Tab from the To tab button.
    await win.getByTestId(SPLIT_TESTIDS.toTab).focus();
    await win.keyboard.press('Shift+Tab');
    const ring = await focusRing(g);
    expect(ring.focused && ring.visible && ring.outline !== 'none', 'gutter is in the Tab order with a visible ring').toBe(true);
    await expect(g).toHaveAttribute('tabindex', '0');

    // AC12 after close: no header, left full width, shell-tab geometry as before.
    await pill(win).click();
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toHaveCount(0);
    await waitSettled(win);
    await expect(headers(win)).toHaveCount(0);
    const widths = await win.evaluate((s) => {
      const l = document.querySelector(s)!;
      return { left: l.getBoundingClientRect().width, parent: l.parentElement!.getBoundingClientRect().width };
    }, LEFT);
    expect(Math.abs(widths.left - widths.parent), '.split-left fills its parent after close').toBeLessThan(0.5);
    expect(await rect(win.locator('[data-testid="shell-tab"]')), 'single-mode shell-tab geometry unchanged').toEqual(single);
    await expect(workspace).toHaveCSS('border-top-width', '1px');
    expect(await elementColour(win, workspace, 'background-color')).toEqual(singleSurface);
  });
});

test('AC11a: a corrupt persisted split ratio renders at 0.5', async () => {
  await withApp(['alpha'], async ({ win }) => {
    const projectId = await projectIdByName(win, 'alpha');
    await openSplit(win, 'alpha');
    for (const bad of ['"abc"', 'null', '{}', '2', '-1', '0.05']) {
      await win.evaluate(({ id, bad }) => {
        const all = JSON.parse(localStorage.getItem('metaide.projectStates')!) as Record<string, Record<string, unknown>>;
        all[String(id)]!.splitRatio = JSON.parse(bad);
        localStorage.setItem('metaide.projectStates', JSON.stringify(all));
      }, { id: projectId, bad });
      await win.reload();
      await win.waitForLoadState('domcontentloaded');
      if (await win.title() !== 'alpha — MetaLogix IDE') await selectProject(win, 'alpha');
      await expect(win.getByTestId(SPLIT_TESTIDS.right), `split restored with splitRatio ${bad}`).toBeVisible();
      await waitSettled(win);
      const now = await gutter(win).getAttribute('aria-valuenow');
      expect.soft(now, `splitRatio ${bad}: aria-valuenow`).toBe('50');
      const share = await leftShare(win);
      expect.soft(Number.isNaN(share), `splitRatio ${bad}: left width is a number`).toBe(false);
      expect.soft(share, `splitRatio ${bad}: left share`).toBeCloseTo(0.5, 2);
    }
  });
});

/* ─────────────────────────────── headers ─────────────────────────────── */

test('AC13–AC20: pane headers show dot, label and path; the right header holds To tab and close; close kills and refocuses left', async () => {
  await withApp(['alpha'], async ({ app, win }) => {
    const right = await openSplit(win, 'alpha');
    await expect(headers(win)).toHaveCount(2);
    const leftH = win.locator(`${LEFT} [data-testid="${SPLIT_TESTIDS.header}"]`);
    const rightH = win.locator(`${RIGHT} [data-testid="${SPLIT_TESTIDS.header}"]`);
    await expect(leftH).toHaveCount(1);
    await expect(rightH).toHaveCount(1);

    for (const [name, h] of [['left', leftH], ['right', rightH]] as const) {
      expect(await css(h, ['height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'column-gap', 'font-size']), `${name} header box`).toEqual({
        height: '34px', 'padding-top': '0px', 'padding-right': '8px', 'padding-bottom': '0px', 'padding-left': '14px', 'column-gap': '8px', 'font-size': '12px',
      });
      expect(await h.evaluate((n) => n.parentElement === n.closest('.split-left, [data-testid="split-right"]') && n.parentElement!.firstElementChild === n),
        `${name} header is the card's first child`).toBe(true);
      // AC13 order: dot, label, path, spacer, actions.
      const order = await h.evaluate((n) => [...n.children].map((c) => ({
        dot: c.getAttribute('data-testid') === 'claude-dot' || c.getAttribute('role') === 'img', x: c.getBoundingClientRect().x, title: c.getAttribute('title'),
      })));
      expect(order[0]!.dot, `${name}: first item is the status dot`).toBe(true);
      expect(order[1]!.x, `${name}: label after dot`).toBeGreaterThan(order[0]!.x);
      expect(order[2]!.x, `${name}: path after label`).toBeGreaterThan(order[1]!.x);
    }

    // AC14: the left header dot reports the same state as shell 0's chip dot.
    const dotFacts = (l: Locator) => l.evaluate((n) => ({ state: n.getAttribute('data-claude-state'), label: n.getAttribute('aria-label') }));
    const chipDot = win.locator(`${chipSel(0)} [role="img"]`);
    await expect.poll(async () => JSON.stringify(await dotFacts(leftH.locator('[role="img"]').first())), { message: 'left header dot = chip dot' })
      .toBe(JSON.stringify(await dotFacts(chipDot)));

    // AC15: label equals the chip text.
    const chipText = (await win.locator(chipSel(0)).innerText()).trim();
    await expect(headerLabel(leftH)).toHaveText(chipText);
    await expect(headerLabel(rightH), 'the right label is a shell name').not.toHaveText('');

    // AC16: abbreviated path + full title, muted, single line with ellipsis.
    const path = await projectPath(win, 'alpha');
    for (const [name, h] of [['left', leftH], ['right', rightH]] as const) {
      const p = h.locator(`[title="${path}"]`);
      await expect(p, `${name} path title holds the full path`).toHaveCount(1);
      await expect(p).toHaveText(abbreviatePath(path));
      expect(await css(p, ['white-space', 'text-overflow', 'overflow-x'])).toEqual({ 'white-space': 'nowrap', 'text-overflow': 'ellipsis', 'overflow-x': 'hidden' });
      await expectColour(win, p, 'color', '--text-muted', `${name} path`);
    }

    // AC17/AC18 actions.
    await expect(leftH.locator('button'), 'left header has no actions').toHaveCount(0);
    const ids = await rightH.locator('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('data-testid')));
    expect(ids).toEqual([SPLIT_TESTIDS.toTab, SPLIT_TESTIDS.close]);
    const toTab = win.getByTestId(SPLIT_TESTIDS.toTab);
    const close = win.getByTestId(SPLIT_TESTIDS.close);
    await expect(toTab).toHaveText(SPLIT_COPY.toTab);
    await expect(toTab).toHaveAccessibleName(SPLIT_COPY.toTab);
    await expect(toTab.locator('svg')).toHaveCount(1);
    expect((await rect(toTab)).height).toBe(24);
    await expect(close).toHaveAccessibleName(SPLIT_COPY.close);
    await expect(close.locator('svg')).toHaveCount(1);
    const cb = await rect(close);
    expect([cb.width, cb.height]).toEqual([24, 24]);
    expect((await css(close, ['border-top-left-radius']))['border-top-left-radius']).toBe('6px');
    expect(cb.x, 'close after To tab').toBeGreaterThan((await rect(toTab)).right - 0.5);
    await expect(await hoverTooltip(win, toTab)).toHaveText(SPLIT_COPY.toTabTooltip);
    await moveMouseAway(win);

    // AC19: the floating X is gone — nothing else in the right pane is a close-split control.
    const strays = await win.evaluate((sel) => [...document.querySelectorAll(`${sel} button, ${sel} [role="button"]`)]
      .filter((b) => !b.closest('[data-testid="split-pane-header"]'))
      .map((b) => `${b.getAttribute('aria-label') ?? ''}|${b.getAttribute('title') ?? ''}|${b.textContent ?? ''}`)
      .filter((s) => /close/i.test(s)), RIGHT);
    expect(strays, 'no close control outside the right header').toEqual([]);

    // AC20: Tab reaches both buttons with a 6px ring.
    await gutter(win).focus();
    await win.keyboard.press('Tab');
    let ring = await focusRing(toTab);
    expect(ring, 'Tab from the gutter reaches To tab').toMatchObject({ focused: true, visible: true, radius: '6px' });
    expect(ring.outline).not.toBe('none');
    await win.keyboard.press('Tab');
    ring = await focusRing(close);
    expect(ring, 'Tab reaches close').toMatchObject({ focused: true, visible: true, radius: '6px' });
    expect(ring.outline).not.toBe('none');

    // AC19: close folds out, kills the right shell, focus returns to the left terminal.
    expect(await aliveIndices(win, 'alpha'), 'right shell alive before close').toContain(right);
    await recordIpc(app);
    await close.click();
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toHaveCount(0);
    await expect.poll(() => aliveIndices(win, 'alpha'), { message: 'right shell killed after close' }).not.toContain(right);
    expect((await ipcLog(app)).filter((c) => c.ch === 'shells:kill').map((c) => c.req)).toEqual([{ projectId: await projectIdByName(win, 'alpha'), shellIndex: right }]);
    await expect.poll(() => focusWhere(win), { message: 'focus lands in the left terminal' }).toBe('left-xterm');
    await expect(pill(win)).toHaveAttribute('aria-pressed', 'false');
  });
});

/* ─────────────────────────────── focused pane ─────────────────────────────── */

test('AC21–AC26: exactly one pane is marked; clicks move the mark and keystrokes; blur, overlays, strip and gutter do not', async () => {
  await withApp(['alpha', 'beta'], async ({ app, win }) => {
    const projectId = await projectIdByName(win, 'alpha');
    await expect(win.locator('[data-pane-focused]'), 'no mark in single mode').toHaveCount(0);
    const right = await openSplit(win, 'alpha');
    expect(await paneFocused(win), 'AC22: left marked on open').toEqual({ left: 'true', right: 'false' });

    // Tailwind prepends its (transparent, zero) ring layers to any box-shadow; drop those.
    const ringOf = async (sel: string) => {
      const raw = await win.evaluate((s) => getComputedStyle(document.querySelector(s)!).boxShadow, sel);
      const layers = raw.split(/,(?![^(]*\))/).map((l) => l.trim()).filter((l) => l !== 'rgba(0, 0, 0, 0) 0px 0px 0px 0px');
      return layers.length ? layers.join(', ') : 'none';
    };
    const wantRing = await computedFor(win, 'box-shadow', 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)');
    const checkEmphasis = async (on: 'left' | 'right') => {
      const off = on === 'left' ? 'right' : 'left';
      const sel = { left: LEFT, right: RIGHT };
      const [leftBorder, rightBorder] = await Promise.all([LEFT, RIGHT].map(async (selector) => {
        const card = win.locator(selector);
        expect.soft(await css(card, ['border-width', 'border-style']), `${selector} has a border regardless of focus`).toEqual({
          'border-width': '1px', 'border-style': 'solid',
        });
        return elementColour(win, card, 'border-top-color');
      }));
      expect.soft(leftBorder, 'both cards use the same border color').toEqual(rightBorder);
      expect.soft([leftBorder.r, leftBorder.g, leftBorder.b], 'neutral gray border').toEqual(Array(3).fill(leftBorder.r));
      expect.soft(leftBorder.a, 'border is visible').toBeGreaterThan(0);
      expect(await ringOf(sel[on]), `AC23: ${on} card ring`).toBe(wantRing);
      expect(await ringOf(sel[off]), `AC23: ${off} card has no ring`).toBe('none');
      const onH = win.locator(`${sel[on]} [data-testid="${SPLIT_TESTIDS.header}"]`);
      const offH = win.locator(`${sel[off]} [data-testid="${SPLIT_TESTIDS.header}"]`);
      expect((await css(headerLabel(onH), ['font-weight']))['font-weight'], `${on} label weight`).toBe('600');
      await expectColour(win, headerLabel(onH), 'color', '--text', `${on} label`);
      expect((await css(headerLabel(offH), ['font-weight']))['font-weight'], `${off} label weight`).toBe('400');
      await expectColour(win, offH, 'color', '--text-muted', `${off} header text`);
    };
    await checkEmphasis('left');

    // AC25: click into the right terminal.
    await win.locator(`${RIGHT} .xterm`).click();
    await expect.poll(() => paneFocused(win)).toEqual({ left: 'false', right: 'true' });
    await checkEmphasis('right');
    await waitForShellOutput(win, 'alpha', right, '$');
    await typeReachesPty(win, 'alpha', right, `echo ${marker('right')}`);
    expect((await splitState(win, projectId))?.activeShellIndex, 'the strip selection does not change').toBe(0);

    // AC22: window blur, overlays, the strip and the gutter keep the mark.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.blur(); });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.focus(); });
    expect(await paneFocused(win), 'window blur/refocus').toEqual({ left: 'false', right: 'true' });
    await win.keyboard.press('ControlOrMeta+Shift+P');
    await expect(win.getByTestId('command-palette')).toBeVisible();
    expect(await paneFocused(win), 'opening an overlay').toEqual({ left: 'false', right: 'true' });
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('command-palette')).toHaveCount(0);
    await pill(win).focus();
    await gutter(win).focus();
    expect(await paneFocused(win), 'focusing the strip and the gutter').toEqual({ left: 'false', right: 'true' });

    // AC22: header buttons mark their card. AC25: clicking back moves the mark back.
    await win.locator(`${LEFT} .xterm`).click();
    await expect.poll(() => paneFocused(win)).toEqual({ left: 'true', right: 'false' });
    await checkEmphasis('left');
    await win.getByTestId(SPLIT_TESTIDS.toTab).focus();
    expect(await paneFocused(win), 'focus on a right header button marks the right card').toEqual({ left: 'false', right: 'true' });

    // AC26: after a project switch and back, the left pane is marked again.
    await selectProject(win, 'beta');
    await selectProject(win, 'alpha');
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toBeVisible();
    expect(await paneFocused(win), 'mark resets to the left after a project switch').toEqual({ left: 'true', right: 'false' });
    const marks = await win.locator('[data-pane-focused="true"]').count();
    expect(marks, 'AC21: exactly one marked card').toBe(1);
  });
});

/* ─────────────────────────────── To tab ─────────────────────────────── */

test('AC27–AC29, AC31–AC32, AC59, AC61: To tab moves the right shell to its own active, focused tab without killing it', async () => {
  await withApp(['alpha'], async ({ app, win }) => {
    const projectId = await projectIdByName(win, 'alpha');
    const chips = `[data-testid="shell-tab-button"]:not([data-shell-index="0"])`;

    // AC59: opening the split adds no chip, at any point.
    await recordInsertions(win, 'open', chips);
    const right = await openSplit(win, 'alpha');
    await expect.poll(() => aliveIndices(win, 'alpha'), { message: 'the right shell is listed live' }).toContain(right);
    await win.waitForTimeout(500); // let the projects:changed / shells listing settle
    expect(await insertions(win, 'open'), 'AC59: no chip appeared while opening the split').toEqual([]);
    await expect(win.locator(chipSel(right))).toHaveCount(0);
    await expect(win.locator(chipSel(0)), 'shell 0 is never hidden').toHaveCount(1);

    const label = (await headerLabel(win.locator(`${RIGHT} [data-testid="${SPLIT_TESTIDS.header}"]`)).innerText()).trim();
    const mark = marker('totab');
    await win.locator(`${RIGHT} .xterm`).click();
    await waitForShellOutput(win, 'alpha', right, '$');
    await typeReachesPty(win, 'alpha', right, `echo ${mark}`);

    await recordIpc(app);
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));
    win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await recordInsertions(win, 'totab', chips);
    await startPaneShellFrames(win, 1200);
    await win.getByTestId(SPLIT_TESTIDS.toTab).click();
    // AC61: before the fold-out ends the active shell is unchanged.
    expect((await splitState(win, projectId))?.activeShellIndex, 'AC61: activation waits for the fold-out').toBe(0);
    expect((await splitState(win, projectId))?.rightShellIndex, 'AC27: rightShellIndex cleared').toBeNull();
    const frames = await paneShellFrames(win);
    const both = frames.filter((f) => f.left === right && f.right === right);
    expect(both, 'AC61: the moved shell never shows in both panes').toEqual([]);
    expect(frames.some((f) => f.right === right), 'positive control: the right pane was sampled while folding').toBe(true);
    expect(frames.at(-1), 'AC61: after the fold-out the single pane shows the moved shell').toEqual({ left: right, right: null });

    // AC28: never killed; chip present at 1s.
    await win.waitForTimeout(1000);
    expect((await ipcLog(app)).filter((c) => c.ch === 'shells:kill'), 'AC28: no shells:kill').toEqual([]);
    expect(await aliveIndices(win, 'alpha'), 'AC28: shell still live').toContain(right);
    await expect(win.locator(chipSel(right)), 'AC59: chip appears after To tab').toHaveCount(1);
    expect((await insertions(win, 'totab')).length, 'positive control: the chip insertion was observed').toBeGreaterThan(0);
    await expect(win.locator(chipSel(right)), 'AC15: chip text = former header label').toHaveText(label);

    // AC61: active tab and DOM focus.
    expect((await splitState(win, projectId))?.activeShellIndex, 'AC61: moved shell is the active tab').toBe(right);
    await expectColour(win, win.locator(chipSel(right)), 'background-color', '--surface-active', 'active chip');
    await expect.configure({ soft: true }).poll(() => focusWhere(win), { message: 'AC61: DOM focus in the moved shell terminal' }).toBe('left-xterm');
    // Whatever the outcome above, the rest checks content and input, so put focus in the moved shell explicitly.
    if (await focusWhere(win) !== 'left-xterm') await win.locator(`${LEFT} .xterm`).click();

    // AC31 pill state; AC29 earlier output intact and input still accepted.
    await expect(pill(win)).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await paneLines(win, LEFT))?.join('\n') ?? '', { message: 'AC29: marker visible in the moved shell' }).toContain(mark);
    await typeReachesPty(win, 'alpha', right, `echo ${marker('after')}`);

    // AC32: renderer-only — every invoke went to a registered handler.
    expect(errors.filter((e) => /No handler registered|Error invoking remote method/i.test(e)), 'AC32: no unknown IPC channel').toEqual([]);

    // AC29: clicking chip 0 then the moved chip shows it again with its output.
    await win.locator(chipSel(0)).click();
    await win.locator(chipSel(right)).click();
    await expect.poll(async () => (await paneLines(win, LEFT))?.join('\n') ?? '').toContain(mark);
  });
});

test('AC59: closing the split never shows a chip for the right shell', async () => {
  await withApp(['alpha'], async ({ win }) => {
    const right = await openSplit(win, 'alpha');
    await recordInsertions(win, 'close', `[data-testid="shell-tab-button"]:not([data-shell-index="0"])`);
    await startFrames(win, { chip: chipSel(right), fold: `${RIGHT}^^` }, 1200);
    await pill(win).click();
    const frames = await collectFrames(win);
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toHaveCount(0);
    await expect.poll(() => aliveIndices(win, 'alpha')).not.toContain(right);
    await win.waitForTimeout(300);
    const shown = frames.filter((f) => f.s.chip!.present);
    expect(shown.length, `frames with a chip for the closing right shell (of ${frames.length}; spans ${
      shown.length ? Math.round(shown.at(-1)!.t - shown[0]!.t) : 0}ms)\n${frameLog(frames, [['chip', 'present'], ['fold', 'w']])}`).toBe(0);
    expect(await insertions(win, 'close'), 'no chip appeared while closing').toEqual([]);
    await expect(win.locator(chipSel(0))).toHaveCount(1);
  });
});

test('AC62: a project switch or leaving the Shell tab during the fold-out cancels the activation', async () => {
  await withApp(['alpha', 'beta'], async ({ win }) => {
    const projectId = await projectIdByName(win, 'alpha');

    // Project switch in the same task as the click.
    const r1 = await openSplit(win, 'alpha');
    await win.evaluate((ids) => {
      (document.querySelector(`[data-testid="${ids.toTab}"]`) as HTMLElement).click();
      const row = [...document.querySelectorAll<HTMLElement>('[data-testid="project-row"]')].find((r) => r.textContent?.trim() === 'beta')!;
      row.click();
    }, SPLIT_TESTIDS);
    await expect.poll(() => win.title()).toBe('beta — MetaLogix IDE');
    await win.waitForTimeout(600);
    await selectProject(win, 'alpha');
    expect(await splitState(win, projectId), 'project switch: shell 0 stays active, split cleared')
      .toMatchObject({ activeShellIndex: 0, rightShellIndex: null });
    await expect(win.locator(chipSel(r1)), 'the moved shell is a chip').toHaveCount(1);
    expect(await aliveIndices(win, 'alpha')).toContain(r1);

    // Leaving the Shell tab in the same task as the click.
    const r2 = await openSplit(win, 'alpha');
    await win.evaluate((ids) => {
      (document.querySelector(`[data-testid="${ids.toTab}"]`) as HTMLElement).click();
      const files = document.querySelector<HTMLButtonElement>('button[aria-label="Files"]');
      if (!files) throw new Error('Files tab button missing');
      files.click();
    }, SPLIT_TESTIDS);
    await win.waitForTimeout(600);
    await win.getByRole('button', { name: 'Shell', exact: true }).click();
    await expect(win.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible();
    expect(await splitState(win, projectId), 'leaving the Shell tab: shell 0 stays active')
      .toMatchObject({ activeShellIndex: 0, rightShellIndex: null });
    expect(await aliveIndices(win, 'alpha')).toEqual(expect.arrayContaining([r1, r2]));
  });
});

test('AC29a, AC62, AC33: To tab on a popped-out right shell leaves it in its window, unkilled, and keeps the left terminal', async () => {
  await withApp(['alpha'], async ({ app, win }) => {
    const projectId = await projectIdByName(win, 'alpha');
    const right = await openSplit(win, 'alpha');
    await win.evaluate(() => {
      (document.querySelector('[data-testid="shell-tab"] .xterm') as HTMLElement & { __e2eLeft?: boolean }).__e2eLeft = true;
    });
    const [popout] = await Promise.all([
      app.waitForEvent('window'),
      win.evaluate(async (a) => { await (window as unknown as { api: Api }).api.invoke('windows:popout-shell', a); }, { projectId, shellIndex: right }),
    ]);
    await popout.waitForLoadState('domcontentloaded');
    await expect(win.locator(`${RIGHT} [data-testid="return-popout"]`), 'right pane shows the popped placeholder').toBeVisible({ timeout: 8000 });
    await expect(win.getByTestId(SPLIT_TESTIDS.toTab), 'To tab offered for a popped shell').toBeVisible();

    await recordIpc(app);
    await win.getByTestId(SPLIT_TESTIDS.toTab).click();
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toHaveCount(0);
    await win.waitForTimeout(800);
    expect(await splitState(win, projectId), 'removed from the split, not activated').toMatchObject({ activeShellIndex: 0, rightShellIndex: null });
    expect((await ipcLog(app)).filter((c) => c.ch === 'shells:kill'), 'not killed').toEqual([]);
    expect(await aliveIndices(win, 'alpha')).toContain(right);
    expect(popout.isClosed(), 'the popout window stays open').toBe(false);
    await expect(popout.locator('[data-testid="shell-tab"] .xterm-screen')).toBeVisible();
    await expect.poll(() => focusWhere(win), { message: 'left terminal keeps focus' }).toBe('left-xterm');
    expect(await win.evaluate(() => (document.querySelector('.split-left [data-testid="shell-tab"] .xterm') as HTMLElement & { __e2eLeft?: boolean } | null)?.__e2eLeft === true),
      'AC33: left terminal not remounted by To tab').toBe(true);
  });
});

/* ─────────────────────────────── cross-cutting ─────────────────────────────── */

test('AC33: opening and closing the split by pill and by split-close never remounts the left terminal', async () => {
  await withApp(['alpha'], async ({ win }) => {
    const tag = () => win.evaluate(() => {
      (document.querySelector('.split-left [data-testid="shell-tab"]') as HTMLElement & { __e2eTag?: boolean }).__e2eTag = true;
    });
    const kept = () => win.evaluate(() => (document.querySelector('.split-left [data-testid="shell-tab"]') as HTMLElement & { __e2eTag?: boolean } | null)?.__e2eTag === true);
    await tag();
    await openSplit(win, 'alpha');
    expect(await kept(), 'pill open').toBe(true);
    await pill(win).click();
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toHaveCount(0);
    await waitSettled(win);
    expect(await kept(), 'pill close').toBe(true);
    await openSplit(win, 'alpha');
    await win.getByTestId(SPLIT_TESTIDS.close).click();
    await expect(win.getByTestId(SPLIT_TESTIDS.right)).toHaveCount(0);
    await waitSettled(win);
    expect(await kept(), 'split-close').toBe(true);
  });
});

test('AC35: pane surface, ring, pressed pill and grip resolve to non-empty colours in every palette and theme', async () => {
  await withApp(['alpha'], async ({ win }) => {
    await openSplit(win, 'alpha');
    await moveMouseAway(win);
    for (const palette of PALETTES) {
      for (const theme of THEMES) {
        await win.evaluate(({ palette, theme }) => {
          document.documentElement.setAttribute('data-palette', palette);
          document.documentElement.setAttribute('data-theme', theme);
        }, { palette, theme });
        const at = `${palette}/${theme}`;
        for (const token of ['--surface-pane', '--pane-ring', '--accent-soft', '--accent-soft-text', '--split-grip'] as const) {
          expect.soft((await resolveToken(win, token)).a, `${at} ${token} alpha`).toBeGreaterThan(0);
        }
        expect.soft((await elementColour(win, win.locator(LEFT), 'background-color')).a, `${at} card surface`).toBeGreaterThan(0);
        expect.soft((await elementColour(win, pill(win), 'background-color')).a, `${at} pressed pill`).toBeGreaterThan(0);
        expect.soft((await elementColour(win, gutter(win).locator(':scope > *').first(), 'background-color')).a, `${at} grip`).toBeGreaterThan(0);
        expect.soft(await win.evaluate((s) => getComputedStyle(document.querySelector(s)!).boxShadow, LEFT), `${at} ring`).not.toBe('none');
      }
    }
  });
});
