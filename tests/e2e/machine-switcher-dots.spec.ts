import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MACHINE_COPY, MACHINE_TESTIDS } from '../../src/renderer/sidebar-copy';
import { LOCAL_MACHINE_ID } from '../../src/renderer/machine-switcher-contract';
import { SIDEBAR_WIDTH } from '../../src/renderer/sidebar-width';
import { colourDistance, elementColour, fmtColour, resolveToken } from './helpers/chrome-colour';
import { closeApp, guardedLaunch } from './helpers/claude-harness';
import { FLEET_POLL_WAIT_MS, peer, peerPub, writeFleet, type FleetPeer } from './helpers/fleet-fixture';

/**
 * Sidebar machine switcher dots (docs/specs/machine-switcher-dots.md AC1-AC15, AC21-AC22, AC25-AC28, AC31 header).
 *
 * Paired machines are real *offline* peers written to `<HOME>/.metaide/known_devices.json` (helpers/fleet-fixture.ts);
 * the fleet re-reads it every 5 s poll. An online peer needs a second instance and a relay, so the online-remote
 * ACs (AC16-AC20, AC23, AC24, the remote half of AC14) are covered by the renderer component tests, not here.
 * Reconnect is asserted present and enabled only, never clicked (it dials the relay). No assertion depends on
 * the outcome of the app's auto-dial: every peer is offline-or-unknown and the tests only rely on "offline".
 *
 * Fixture facts (peers) -- sorted by name the dot order is: this machine, Alpha Box, Studio Mac, Zed Desktop.
 * Peers have no `devices` row in the DB, so their last-seen text is "never seen".
 * Tests run in file order and share one app; the relaunch test (AC10) runs last.
 */

const PEERS: readonly FleetPeer[] = [peer(1, 'Zed Desktop'), peer(2, 'Alpha Box'), peer(3, 'Studio Mac')];
const SORTED_NAMES = ['Alpha Box', 'Studio Mac', 'Zed Desktop'] as const;
const ALPHA = peerPub(2);
const STUDIO = peerPub(3);
const ZED = peerPub(1);
const PROJECT = 'switcher-proj';
const NEVER_SEEN = 'never seen';
const WIDTH_KEY = 'metaide.sidebarWidth';

let app: ElectronApplication;
let win: Page;
let isolatedHome: string;
let userData: string;
let demoRoot: string;
let selfName: string;

type Api = { invoke: (c: string, r: unknown) => Promise<unknown> };

function launchEnv(home: string): NodeJS.ProcessEnv {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  return {
    ...process.env,
    HOME: home,
    METAIDE_TEST_MODE: '1',
    METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
    METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: ['node', mockClaude], env: {} }),
    METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
  };
}

test.beforeAll(async () => {
  await guardedLaunch(async (scope) => {
    isolatedHome = scope.tempDir('metaide-switcher-home-');
    demoRoot = scope.tempDir('metaide-switcher-root-');
    userData = join(isolatedHome, 'userData');
    mkdirSync(join(demoRoot, PROJECT), { recursive: true });
    writeFileSync(join(demoRoot, PROJECT, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { dev: 'echo dev' } }));
    // Seed self-check: the fixture file must be accepted by loadKnownDevices (checked in writeFleet) and start empty.
    writeFleet(isolatedHome, []);

    app = scope.own(await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: launchEnv(isolatedHome) }));
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resizeMain(1440, 900);
    await win.evaluate(async (path: string) => {
      await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
    }, demoRoot);
    await expect(projectRow(PROJECT)).toBeVisible({ timeout: 5000 });
    selfName = await readSelfName();
  });
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(demoRoot, { recursive: true, force: true });
});

/* ─────────────────────────────── helpers ─────────────────────────────── */

async function resizeMain(width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('popout=1'));
    if (!main) throw new Error('main window not found');
    main.setContentSize(s.width, s.height);
  }, { width, height });
  await expect.poll(() => win.evaluate(() => window.innerWidth), { message: `window width ${width}` }).toBe(width);
}

/** The device name the sidebar uses for this machine, straight from the P2P settings the app itself reads (AC6). */
async function readSelfName(): Promise<string> {
  const s = await win.evaluate(() => (window as unknown as { api: Api }).api.invoke('p2p:settings-get', undefined)) as { deviceName: string };
  return s.deviceName.trim();
}

const aside = () => win.locator('aside[data-view="projects"]');
const band = () => win.getByTestId(MACHINE_TESTIDS.band);
const row = () => win.getByTestId(MACHINE_TESTIDS.row);
const dot = (key: string) => win.getByTestId(MACHINE_TESTIDS.dot(key));
const tabs = () => row().getByRole('tab');
/** The Projects section header button (the section wrapper carries the test id). */
const sectionToggle = () => win.getByTestId('section-all').getByRole('button').first();
/** The row wrapper (`.group`) wears `bg-[--accent-soft]` while selected. */
const isHighlighted = (name: string) => projectRow(name).evaluate((el) => !!el.closest('.group')?.className.includes('accent-soft'));
/** The project's row inside the Projects section only (an opened project also appears under In use / Recents). */
const sectionRow = (name: string) => win.getByTestId('section-all').locator('[data-testid="project-row"]').filter({ has: win.getByText(name, { exact: true }) });
const projectRow = (name: string) => win.locator('[data-testid="project-row"]').filter({ has: win.getByText(name, { exact: true }) }).first();

/** AC26 accessible names. */
const localAccessibleName = () => (selfName === '' ? MACHINE_COPY.thisMachineFallback : `${selfName}, ${MACHINE_COPY.thisMachineTag}`);
const offlineAccessibleName = (name: string) => `${name}, ${MACHINE_COPY.offline}, ${NEVER_SEEN}`;
/** AC25 tooltips. */
const localTooltip = () => (selfName === '' ? MACHINE_COPY.thisMachineFallback : `${selfName} · ${MACHINE_COPY.thisMachineTag}`);
const offlineTooltip = (name: string) => `${name} · ${MACHINE_COPY.offline} · ${NEVER_SEEN}`;

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('element has no bounding box (not rendered)');
  return b;
}
const css = (l: Locator, prop: string) => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

/** Waits for the band to show `n` dots (one fleet poll after a fixture write). */
async function expectDotCount(n: number): Promise<void> {
  await expect(tabs()).toHaveCount(n, { timeout: FLEET_POLL_WAIT_MS });
}

async function activeDotKeys(): Promise<string[]> {
  return row().getByRole('tab').evaluateAll((els) =>
    els.filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.getAttribute('data-testid') ?? ''));
}

/** Exactly one dot is active, and it is `key`. Positive control: all dots render. */
async function expectActive(key: string): Promise<void> {
  await expect(dot(key)).toHaveAttribute('aria-selected', 'true');
  expect(await activeDotKeys(), 'exactly one dot is active').toEqual([MACHINE_TESTIDS.dot(key)]);
}

async function selectDot(key: string): Promise<void> {
  await dot(key).click();
  await expect(dot(key)).toHaveAttribute('aria-selected', 'true');
}

async function setSidebarWidth(width: number): Promise<void> {
  await win.evaluate(({ k, w }) => localStorage.setItem(k, String(w)), { k: WIDTH_KEY, w: width });
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await expect(aside()).toBeVisible();
  await expect.poll(async () => Math.round((await box(aside())).width), { message: `sidebar width ${width}` }).toBe(width);
}

/** The visible marker inside a dot button (assumption: the button's first element child). */
const marker = (key: string) => dot(key).locator(':scope > *').first();

/** Opacity multiplied up from the marker through the button (the dim may sit on either). */
function effectiveOpacity(l: Locator): Promise<number> {
  return l.evaluate((el) => {
    let o = 1;
    for (let n: Element | null = el; n && n.tagName !== 'ASIDE'; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  });
}

/* ─────────────────────────────── tests ─────────────────────────────── */

test('AC1/AC7 (zero peers): no band, no Machines section, no machine-* test ids; the local list renders', async () => {
  await expect(win.getByTestId('sidebar-filter'), 'positive control: the sidebar renders').toBeVisible();
  await expect(projectRow(PROJECT), 'positive control: local project list renders').toBeVisible();
  await expect(band()).toHaveCount(0);
  await expect(row()).toHaveCount(0);
  await expect(aside().getByText('Machines', { exact: true })).toHaveCount(0);
  await expect(win.locator('[data-testid^="machine-"]')).toHaveCount(0);
});

test('AC9/AC2/AC5/AC10/AC6: pairing three machines mid-run adds the band within one poll: 4 dots, name-sorted, local first and active', async () => {
  writeFleet(isolatedHome, PEERS);
  await expectDotCount(4);

  // Band geometry (AC9): 28px tall, no divider, flush with the sidebar bottom; below the scrolling list (AC2).
  const a = await box(aside());
  const b = await box(band());
  expect(b.height, 'band is 28px tall').toBe(28);
  expect(Math.round(b.y + b.height), 'band bottom is flush with the sidebar bottom').toBe(Math.round(a.y + a.height));
  expect(await css(band(), 'border-top-width'), 'no divider line').toBe('0px');
  expect(await css(band(), 'border-bottom-width')).toBe('0px');
  // The list wrapper is `display: contents` (no box); the scrolling area is the tabpanel the dots control.
  const list = await box(win.getByRole('tabpanel'));
  expect(b.y, 'band sits below the scrollable list').toBeGreaterThanOrEqual(list.y + list.height - 1);

  // Order (AC5): this machine, then paired machines by name. Accessible names carry the machine name (AC26).
  const names = await tabs().evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
  expect(names).toEqual([
    localAccessibleName(),
    offlineAccessibleName(SORTED_NAMES[0]),
    offlineAccessibleName(SORTED_NAMES[1]),
    offlineAccessibleName(SORTED_NAMES[2]),
  ]);
  const ids = await tabs().evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(ids).toEqual([LOCAL_MACHINE_ID, ALPHA, STUDIO, ZED].map((k) => MACHINE_TESTIDS.dot(k)));
  // Never a second "this machine" dot.
  expect(names.filter((n) => n === localAccessibleName())).toHaveLength(1);

  // Launch default (AC10): this machine active, local list shown.
  await expectActive(LOCAL_MACHINE_ID);
  await expect(win.getByTestId(MACHINE_TESTIDS.localList)).toBeVisible();
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteList)).toHaveCount(0);

  // Order is stable across fleet refreshes (AC5): wait out another poll.
  await win.waitForTimeout(5500);
  expect(await tabs().evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(ids);

  // The old Machines UI is gone while peers exist (AC7).
  await expect(aside().getByText('Machines', { exact: true })).toHaveCount(0);
  await expect(win.locator('[data-testid^="machine-"]')).toHaveCount(0);
});

test('AC26: the row is a labelled tablist of tabs with aria-selected on the active dot only', async () => {
  await expect(win.getByRole('tablist', { name: MACHINE_COPY.tablistLabel })).toHaveCount(1);
  await expect(tabs()).toHaveCount(4);
  await expect(dot(LOCAL_MACHINE_ID)).toHaveAttribute('aria-selected', 'true');
  for (const k of [ALPHA, STUDIO, ZED]) await expect(dot(k)).toHaveAttribute('aria-selected', 'false');
  await expect(win.getByRole('tab', { name: localAccessibleName(), exact: true })).toHaveCount(1);
  await expect(win.getByRole('tab', { name: offlineAccessibleName('Studio Mac'), exact: true })).toHaveCount(1);
});

test('AC11/AC22/AC31/AC13/AC14: selecting an offline machine shows its header, last seen and Reconnect, no rows; the main pane is unchanged; switching back restores the local list', async () => {
  // Put a local project in the main pane and collapse the Projects section (local collapse state, AC14).
  await projectRow(PROJECT).click();
  await expect(win.getByTestId('status-bar')).toContainText(PROJECT);
  expect(await isHighlighted(PROJECT), 'control: the clicked project row is highlighted').toBe(true);
  await sectionToggle().click();
  await expect(sectionRow(PROJECT), 'positive control: collapsing hid the project row').toBeHidden();

  await selectDot(STUDIO);
  await expectActive(STUDIO);
  const header = win.getByTestId(MACHINE_TESTIDS.remoteHeader);
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteList)).toBeVisible();
  await expect(header).toContainText('Studio Mac');
  await expect(header).toContainText(MACHINE_COPY.offline);
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteLastSeen)).toHaveText(NEVER_SEEN);
  const reconnect = win.getByTestId(MACHINE_TESTIDS.remoteReconnect);
  await expect(reconnect).toBeVisible();
  await expect(reconnect).toBeEnabled(); // never clicked: it dials the relay
  await expect(reconnect).toContainText(MACHINE_COPY.reconnect);
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteProjectRow), 'offline panel lists no projects').toHaveCount(0);
  await expect(win.getByTestId(MACHINE_TESTIDS.localList), 'local list swapped out').toBeHidden();
  await expect(win.getByTestId('sidebar-filter'), 'filter stays visible for the offline panel (AC31)').toBeVisible();
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteInUse)).toHaveCount(0);
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteRecents)).toHaveCount(0);
  // AC31: the header is the first item of the scrolling list area.
  expect(await win.getByTestId(MACHINE_TESTIDS.remoteList).evaluate((el, id) => el.firstElementChild?.getAttribute('data-testid') === id,
    MACHINE_TESTIDS.remoteHeader)).toBe(true);

  // AC13: the main pane did not change on the switch.
  await expect(win.getByTestId('status-bar')).toContainText(PROJECT);

  // Another offline machine shows its own header (exactly one active throughout).
  await selectDot(ALPHA);
  await expectActive(ALPHA);
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteHeader)).toContainText('Alpha Box');
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteHeader)).not.toContainText('Studio Mac');

  // AC14 (local half): back on this machine, the list is back, the Projects section is still collapsed,
  // and the main pane is untouched.
  await selectDot(LOCAL_MACHINE_ID);
  await expect(win.getByTestId(MACHINE_TESTIDS.localList)).toBeVisible();
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteList)).toHaveCount(0);
  await expect(sectionRow(PROJECT), 'local collapse state survived the round trip').toBeHidden();
  await sectionToggle().click();
  await expect(sectionRow(PROJECT), 'positive control: expanding shows the row again').toBeVisible();
  expect(await isHighlighted(PROJECT), 'AC14: the selected local row is still highlighted').toBe(true);
  await expect(win.getByTestId('status-bar')).toContainText(PROJECT);
});

test('AC12: selecting the already-active dot changes nothing', async () => {
  await selectDot(STUDIO);
  const before = await win.getByTestId(MACHINE_TESTIDS.remoteHeader).textContent();
  await dot(STUDIO).click();
  await expectActive(STUDIO);
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteHeader)).toHaveText(before ?? "");
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteList)).toBeVisible();
  await selectDot(LOCAL_MACHINE_ID);
  await dot(LOCAL_MACHINE_ID).click();
  await expectActive(LOCAL_MACHINE_ID);
  await expect(win.getByTestId(MACHINE_TESTIDS.localList)).toBeVisible();
  await expect(projectRow(PROJECT)).toBeVisible();
});

test('AC15: unpairing the shown machine falls back to this machine and stays there when it reappears', async () => {
  await selectDot(STUDIO);
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteHeader)).toContainText('Studio Mac');

  writeFleet(isolatedHome, PEERS.filter((p) => p.pub !== STUDIO));
  await expectDotCount(3); // poll saw the removal (positive control: other dots still render)
  await expect(dot(STUDIO)).toHaveCount(0);
  await expectActive(LOCAL_MACHINE_ID);
  await expect(win.getByTestId(MACHINE_TESTIDS.localList)).toBeVisible();
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteList)).toHaveCount(0);

  writeFleet(isolatedHome, PEERS);
  await expectDotCount(4);
  await expect(dot(STUDIO), 'positive control: the machine reappeared').toHaveCount(1);
  await win.waitForTimeout(5500);
  await expectActive(LOCAL_MACHINE_ID);
  await expect(win.getByTestId(MACHINE_TESTIDS.localList)).toBeVisible();
});

test('AC21: dot states differ by size and fill: active filled accent 8px, inactive online muted 6px, offline hollow and dimmed', async () => {
  const accent = await resolveToken(win, '--accent', aside());
  const muted = await resolveToken(win, '--text-muted', aside());
  const size = async (k: string) => {
    const b = await box(marker(k));
    return { w: Math.round(b.width), h: Math.round(b.height) };
  };

  // Active online (this machine).
  await expectActive(LOCAL_MACHINE_ID);
  expect(await size(LOCAL_MACHINE_ID)).toEqual({ w: 8, h: 8 });
  const activeFill = await elementColour(win, marker(LOCAL_MACHINE_ID), 'background-color');
  expect(colourDistance(activeFill, accent), `active online fill ${fmtColour(activeFill)} is --accent ${fmtColour(accent)}`).toBeLessThan(3);
  expect(await effectiveOpacity(marker(LOCAL_MACHINE_ID))).toBe(1);

  // Inactive offline: hollow muted outline, 6px, dimmed.
  expect(await size(ALPHA)).toEqual({ w: 6, h: 6 });
  const hollow = await elementColour(win, marker(ALPHA), 'background-color');
  expect(hollow.a, 'inactive offline dot has no fill').toBe(0);
  expect(parseFloat(await css(marker(ALPHA), 'border-top-width')), 'inactive offline dot has an outline').toBeGreaterThan(0);
  const outline = await resolveCssColour(await css(marker(ALPHA), 'border-top-color'));
  expect(colourDistance(outline, muted), 'outline is --text-muted').toBeLessThan(3);
  expect(await effectiveOpacity(marker(ALPHA)), 'inactive offline dot is dimmed').toBeLessThan(1);
  expect(await effectiveOpacity(marker(ALPHA))).toBeGreaterThan(0.2);

  // Offline dots are selectable; the active offline dot is hollow accent, larger, never dimmed.
  await selectDot(ALPHA);
  await win.waitForTimeout(500); // dot size/colour/opacity transition runs 150ms
  expect(await size(ALPHA)).toEqual({ w: 8, h: 8 });
  expect((await elementColour(win, marker(ALPHA), 'background-color')).a, 'active offline dot is hollow').toBe(0);
  const ring = await resolveCssColour(await css(marker(ALPHA), 'border-top-color'));
  expect(colourDistance(ring, accent), 'active offline ring is --accent').toBeLessThan(3);
  expect(await effectiveOpacity(marker(ALPHA)), 'active offline dot is not dimmed').toBe(1);

  // Inactive online (this machine, now deselected): 6px, filled muted, undimmed.
  expect(await size(LOCAL_MACHINE_ID)).toEqual({ w: 6, h: 6 });
  const mutedFill = await elementColour(win, marker(LOCAL_MACHINE_ID), 'background-color');
  expect(colourDistance(mutedFill, muted), 'inactive online fill is --text-muted').toBeLessThan(3);
  expect(await effectiveOpacity(marker(LOCAL_MACHINE_ID))).toBe(1);

  await selectDot(LOCAL_MACHINE_ID);
});

/** Resolves a computed CSS colour string through the same canvas oracle the token helper uses. */
async function resolveCssColour(c: string) {
  return win.evaluate((value) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0]!, g: d[1]!, b: d[2]!, a: d[3]! / 255 };
  }, c);
}

test('AC25: tooltip on hover and on keyboard focus: "<name> · online|offline · last seen", "<name> · this machine"', async () => {
  const tip = (text: string) => win.getByRole('tooltip').filter({ hasText: text });

  await dot(STUDIO).hover();
  await expect(tip(offlineTooltip('Studio Mac'))).toBeVisible();
  await win.mouse.move(700, 400);
  await expect(win.getByRole('tooltip'), 'tooltip hides on leave').toHaveCount(0);

  await dot(LOCAL_MACHINE_ID).hover();
  await expect(tip(localTooltip())).toBeVisible();
  await win.mouse.move(700, 400);
  await expect(win.getByRole('tooltip')).toHaveCount(0);

  // Keyboard focus (focus-visible): focus the active dot, then arrow to a neighbour.
  await dot(LOCAL_MACHINE_ID).focus();
  await win.keyboard.press('ArrowRight');
  await expect(dot(ALPHA)).toBeFocused();
  await expect(tip(offlineTooltip('Alpha Box'))).toBeVisible();
  await win.keyboard.press('Escape');
});

test('AC27: roving tabindex, arrows/Home/End move focus only (wrapping), Enter/Space select, Tab leaves the row', async () => {
  const order = [LOCAL_MACHINE_ID, ALPHA, STUDIO, ZED];
  await expectActive(LOCAL_MACHINE_ID);
  const tabindexes = () => tabs().evaluateAll((els) => els.map((e) => e.getAttribute('tabindex')));
  expect(await tabindexes(), 'one tab stop, on the active dot').toEqual(['0', '-1', '-1', '-1']);

  await dot(LOCAL_MACHINE_ID).focus();
  await win.keyboard.press('ArrowRight');
  await expect(dot(ALPHA)).toBeFocused();
  await expectActive(LOCAL_MACHINE_ID); // moved focus only
  await expect(win.getByTestId(MACHINE_TESTIDS.localList), 'manual activation: list unchanged').toBeVisible();

  await win.keyboard.press('End');
  await expect(dot(ZED)).toBeFocused();
  await win.keyboard.press('ArrowRight'); // wraps to first
  await expect(dot(order[0]!)).toBeFocused();
  await win.keyboard.press('ArrowLeft'); // wraps to last
  await expect(dot(ZED)).toBeFocused();
  await win.keyboard.press('Home');
  await expect(dot(LOCAL_MACHINE_ID)).toBeFocused();
  await expectActive(LOCAL_MACHINE_ID);

  // Enter selects the focused dot.
  await win.keyboard.press('ArrowRight');
  await win.keyboard.press('ArrowRight'); // Studio Mac
  await expect(dot(STUDIO)).toBeFocused();
  await win.keyboard.press('Enter');
  await expectActive(STUDIO);
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteHeader)).toContainText('Studio Mac');
  expect(await tabindexes(), 'tab stop follows the active dot').toEqual(['-1', '-1', '0', '-1']);

  // Space selects too.
  await win.keyboard.press('ArrowLeft'); // Alpha Box
  await expect(dot(ALPHA)).toBeFocused();
  await expectActive(STUDIO);
  await win.keyboard.press('Space');
  await expectActive(ALPHA);
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteHeader)).toContainText('Alpha Box');

  // Tab leaves the row.
  await win.keyboard.press('Tab');
  expect(await row().evaluate((r) => r.contains(document.activeElement))).toBe(false);
  await win.keyboard.press('Shift+Tab');
  await expect(dot(ALPHA), 'Shift+Tab returns to the single tab stop').toBeFocused();

  await selectDot(LOCAL_MACHINE_ID);
});

test('AC28: every dot button is at least 20x20 and keyboard focus draws the 2px accent outline', async () => {
  for (const k of [LOCAL_MACHINE_ID, ALPHA, STUDIO, ZED]) {
    const b = await box(dot(k));
    expect(b.width, `${k} width`).toBeGreaterThanOrEqual(20);
    expect(b.height, `${k} height`).toBeGreaterThanOrEqual(20);
  }
  const accent = await resolveToken(win, '--accent', aside());

  // Control: a mouse-focused-free, unfocused dot has no outline.
  await win.mouse.move(700, 400);
  await dot(STUDIO).evaluate((el) => (el as HTMLElement).blur());
  expect(await css(dot(STUDIO), 'outline-style')).toBe('none');

  // Keyboard focus: Tab into the row lands on the active dot with a focus-visible ring.
  await win.getByTestId('sidebar-filter').focus();
  await win.keyboard.press('Tab');
  await dot(LOCAL_MACHINE_ID).evaluate((el) => (document.activeElement === el ? null : (el as HTMLElement).focus()));
  await win.keyboard.press('ArrowRight'); // keyboard modality => :focus-visible
  await expect(dot(ALPHA)).toBeFocused();
  expect(await css(dot(ALPHA), 'outline-width')).toBe('2px');
  expect(await css(dot(ALPHA), 'outline-style')).not.toBe('none');
  const outline = await resolveCssColour(await css(dot(ALPHA), 'outline-color'));
  // `button:focus-visible` is `color-mix(in oklab, var(--accent) 70%, transparent)`: accent hue at 70% alpha.
  expect(outline.a, 'ring is mostly opaque').toBeGreaterThan(0.5);
  expect(colourDistance({ ...outline, a: 1 }, { ...accent, a: 1 }), 'focus ring is the accent colour').toBeLessThan(12);
});

test('AC8: only the dots are no-drag; the empty band and the sidebar drag fill stay drag', async () => {
  const region = (l: Locator) => css(l, '-webkit-app-region');
  expect(await region(win.getByTestId('sidebar-drag-fill')), 'positive control: drag fill is a drag region').toBe('drag');
  expect(await region(band())).toBe('drag');
  expect(await region(row())).toBe('no-drag');
  for (const k of [LOCAL_MACHINE_ID, ALPHA, STUDIO, ZED]) expect(await region(dot(k)), `${k} dot`).toBe('no-drag');
  // The no-drag row hugs the dots; the band's empty sides remain draggable.
  const rb = await box(row());
  const bb = await box(band());
  expect(rb.width, 'row is narrower than the band, leaving drag area on both sides').toBeLessThan(bb.width - 40);
});

test('AC3: the dots are centred on the sidebar within 2px at the default and the minimum width', async () => {
  for (const width of [SIDEBAR_WIDTH.default, SIDEBAR_WIDTH.min]) {
    await setSidebarWidth(width);
    await expectDotCount(4);
    const a = await box(aside());
    const first = await box(dot(LOCAL_MACHINE_ID));
    const last = await box(dot(ZED));
    const dotsCentre = (first.x + last.x + last.width) / 2;
    const asideCentre = a.x + a.width / 2;
    expect(Math.abs(dotsCentre - asideCentre), `centre offset at ${width}px`).toBeLessThanOrEqual(2);
    // Control: all four dots fit inside the sidebar at this width.
    expect(first.x).toBeGreaterThanOrEqual(a.x);
    expect(last.x + last.width).toBeLessThanOrEqual(a.x + a.width);
  }
  await setSidebarWidth(SIDEBAR_WIDTH.default);
});

test('AC4: with too many dots the row scrolls sideways with no scrollbar, and the focused last dot is scrolled fully into view', async () => {
  const many: FleetPeer[] = Array.from({ length: 12 }, (_, i) => peer(10 + i, `Peer ${String(i).padStart(2, '0')}`));
  await setSidebarWidth(SIDEBAR_WIDTH.min);
  writeFleet(isolatedHome, many);
  await expectDotCount(13);

  const m = await row().evaluate((el) => ({
    scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, barHeight: (el as HTMLElement).offsetHeight - el.clientHeight,
    overflowX: getComputedStyle(el).overflowX,
  }));
  expect(m.scrollWidth, 'row overflows').toBeGreaterThan(m.clientWidth);
  expect(['auto', 'scroll']).toContain(m.overflowX);
  expect(m.barHeight, 'no visible horizontal scrollbar').toBe(0);

  const lastKey = peerPub(21);
  const rowBox = () => box(row());
  const outside = async () => {
    const r = await rowBox();
    const d = await box(dot(lastKey));
    return d.x < r.x - 0.5 || d.x + d.width > r.x + r.width + 0.5;
  };
  expect(await outside(), 'control: the last dot starts out of view').toBe(true);
  await dot(LOCAL_MACHINE_ID).focus();
  await win.keyboard.press('End');
  await expect(dot(lastKey)).toBeFocused();
  await expect.poll(outside, { message: 'focused last dot scrolled into view' }).toBe(false);

  // Selecting it keeps it in view too.
  await win.keyboard.press('Enter');
  await expectActive(lastKey);
  expect(await outside()).toBe(false);

  await selectDot(LOCAL_MACHINE_ID);
  writeFleet(isolatedHome, PEERS);
  await expectDotCount(4);
  await setSidebarWidth(SIDEBAR_WIDTH.default);
});

test('AC10: the selected machine is not remembered across a restart', async () => {
  await expectDotCount(4);
  await selectDot(ALPHA);
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteHeader)).toContainText('Alpha Box');

  await closeApp(app);
  await guardedLaunch(async (scope) => {
    app = scope.own(await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: launchEnv(isolatedHome) }));
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
  });
  await resizeMain(1440, 900);
  await expectDotCount(4);
  await expectActive(LOCAL_MACHINE_ID);
  await expect(win.getByTestId(MACHINE_TESTIDS.localList)).toBeVisible();
  await expect(win.getByTestId(MACHINE_TESTIDS.remoteList)).toHaveCount(0);
});
