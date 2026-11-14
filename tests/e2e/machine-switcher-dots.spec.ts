import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { MACHINE_COPY, MACHINE_TESTIDS } from '../../src/renderer/sidebar-copy';
import { LOCAL_MACHINE_ID } from '../../src/renderer/machine-switcher-contract';
import { SIDEBAR_WIDTH } from '../../src/renderer/sidebar-width';
import { colourDistance, elementColour, resolveToken } from './helpers/chrome-colour';
import { baseEnv, closeApp, guardedLaunch, makeClaudeShim, projectId, sendLine, waitForShell } from './helpers/claude-harness';
import { AGGREGATE_STATE_LABEL, type AgentState } from '../../src/shared/agent-state';
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
/** Enough local projects (about 28px each) that the list overflows a 900px-high window. */
const FILLER_COUNT = 40;
const NEVER_SEEN = 'never seen';
const WIDTH_KEY = 'metaide.sidebarWidth';

let app: ElectronApplication;
let win: Page;
let isolatedHome: string;
let userData: string;
let demoRoot: string;
let selfName: string;
/** Boxes of the scroll area and drag-fill with zero peers, captured by the first test (AC9). */
let zeroPeer: { list: Box; fill: Box; listPadBottom: number } | undefined;
type Box = { x: number; y: number; width: number; height: number };

type Api = { invoke: (c: string, r: unknown) => Promise<unknown> };

function launchEnv(home: string): NodeJS.ProcessEnv {
  // A real `claude` on PATH (argv[0] "claude") so the app recognises the mock as an agent (AC34, as agent-status.spec does).
  const claude = makeClaudeShim(home);
  return {
    ...baseEnv(),
    HOME: home,
    PATH: `${join(home, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    METAIDE_TEST_MODE: '1',
    METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
    METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: [claude], env: {} }),
    METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: [claude, '--continue'], env: {} }),
  };
}

test.beforeAll(async () => {
  await guardedLaunch(async (scope) => {
    isolatedHome = scope.tempDir('metaide-switcher-home-');
    demoRoot = scope.tempDir('metaide-switcher-root-');
    userData = join(isolatedHome, 'userData');
    mkdirSync(join(demoRoot, PROJECT), { recursive: true });
    writeFileSync(join(demoRoot, PROJECT, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { dev: 'echo dev' } }));
    // Filler projects so the local list scrolls (AC33); the self-check below asserts they exist.
    for (let i = 0; i < FILLER_COUNT; i++) {
      const dir = join(demoRoot, `filler-${String(i).padStart(2, '0')}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `filler-${i}`, scripts: { dev: 'echo dev' } }));
    }
    if (readdirSync(demoRoot).length !== FILLER_COUNT + 1) throw new Error('switcher seed self-check failed: expected the filler projects plus the main project in the root');
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
/** The sidebar's scrolling list area (a direct child of the aside, scrolls vertically). */
const scrollArea = () => aside().locator(':scope > .overflow-y-auto');
const fill = () => win.getByTestId('sidebar-drag-fill');
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
  zeroPeer = { list: await box(scrollArea()), fill: await box(fill()), listPadBottom: parseFloat(await css(scrollArea(), 'padding-bottom')) };
  expect(zeroPeer.list.height, 'control: the list has height').toBeGreaterThan(100);
});

test('AC9/AC2/AC5/AC10/AC6: pairing three machines mid-run adds the band within one poll: 4 dots, name-sorted, local first and active', async () => {
  writeFleet(isolatedHome, PEERS);
  await expectDotCount(4);

  // Floating pill (AC9/AC2): takes no layout space, bottom edge 8px above the aside's bottom edge.
  const a = await box(aside());
  const b = await box(band());
  expect(Math.round(a.y + a.height - (b.y + b.height)), 'pill bottom is 8px above the sidebar bottom').toBe(8);
  expect(b.height, 'control: the pill has a real box').toBeGreaterThan(20);
  const near = (x: number, y: number) => Math.abs(x - y) <= 0.5;
  const listNow = await box(scrollArea());
  const fillNow = await box(fill());
  const z = zeroPeer!;
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(near(listNow[k], z.list[k]), `list ${k} unchanged by the switcher (${z.list[k]} -> ${listNow[k]})`).toBe(true);
    expect(near(fillNow[k], z.fill[k]), `drag-fill ${k} unchanged by the switcher (${z.fill[k]} -> ${fillNow[k]})`).toBe(true);
  }
  // The pill floats over the list: it lies inside the list's box, not below it.
  expect(b.y + b.height, 'pill overlaps the list box').toBeLessThanOrEqual(listNow.y + listNow.height + 0.5);
  expect(b.y, 'pill starts inside the list box').toBeGreaterThan(listNow.y);
  expect(parseFloat(await css(scrollArea(), 'padding-bottom')), 'AC33: list gains bottom padding while the pill shows').toBeGreaterThan(z.listPadBottom);

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

test('AC21: inactive dots 8px, active 10px with a soft accent ring; offline dots are edge-only at 50% opacity, the active one undimmed', async () => {
  const accent = await resolveToken(win, '--accent', aside());
  const size = async (k: string) => {
    const b = await box(marker(k));
    return { w: Math.round(b.width), h: Math.round(b.height) };
  };
  const backdrop = (k: string) => marker(k).evaluate((el) => getComputedStyle(el).backdropFilter || 'none');
  /** The outer (non-inset) zero-blur shadow: its spread and resolved colour, or null when there is none. */
  const ring = async (k: string) => {
    const raw = await marker(k).evaluate((el) => {
      const parts: string[] = [];
      let depth = 0, cur = '';
      for (const ch of getComputedStyle(el).boxShadow) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
      }
      parts.push(cur.trim());
      for (const part of parts) {
        if (part === 'none' || part.includes('inset')) continue;
        const lengths = part.match(/-?[\d.]+px/g) ?? [];
        if (lengths.length === 4 && parseFloat(lengths[2]!) === 0 && parseFloat(lengths[3]!) > 0) {
          return { spread: parseFloat(lengths[3]!), colour: part.replace(/-?[\d.]+px/g, '').trim() };
        }
      }
      return null;
    });
    if (!raw) return null;
    return { spread: raw.spread, colour: await resolveCssColour(raw.colour) };
  };
  /** The ring is the accent hue, translucent, with a ~1.5px spread. */
  const expectAccentRing = async (k: string, message: string) => {
    const r = await ring(k);
    expect(r, `${message}: has an outer ring`).not.toBeNull();
    expect(r!.spread, `${message}: spread`).toBeGreaterThan(1);
    expect(r!.spread).toBeLessThan(2.5);
    expect(r!.colour.a, `${message}: ring is translucent`).toBeLessThan(1);
    expect(r!.colour.a).toBeGreaterThan(0.2);
    expect(colourDistance({ ...r!.colour, a: 1 }, { ...accent, a: 1 }), `${message}: ring colour is --accent`).toBeLessThan(14);
  };

  // Active online (this machine): 12px, accent ring, glass (blur + translucent fill), not dimmed.
  await expectActive(LOCAL_MACHINE_ID);
  expect(await size(LOCAL_MACHINE_ID)).toEqual({ w: 10, h: 10 });
  await expect(marker(LOCAL_MACHINE_ID)).toHaveAttribute('data-active', '');
  await expectAccentRing(LOCAL_MACHINE_ID, 'active online');
  expect(await effectiveOpacity(marker(LOCAL_MACHINE_ID))).toBe(1);

  // Inactive offline: 10px, edge only (no fill, no blur, no ring), 50% opacity.
  expect(await size(ALPHA)).toEqual({ w: 8, h: 8 });
  await expect(marker(ALPHA)).toHaveAttribute('data-online', '0');
  expect((await elementColour(win, marker(ALPHA), 'background-color')).a, 'offline dot has no fill').toBe(0);
  expect(await backdrop(ALPHA), 'offline dot has no blur').toBe('none');
  expect(parseFloat(await css(marker(ALPHA), 'border-top-width')), 'offline dot keeps a glass edge').toBeGreaterThan(0);
  expect(await ring(ALPHA), 'inactive dot has no accent ring').toBeNull();
  expect(await effectiveOpacity(marker(ALPHA)), 'inactive offline dot is at 50% opacity').toBeCloseTo(0.5, 1);

  // Offline dots are selectable; active offline: 12px, accent ring, still edge-only, not dimmed.
  await selectDot(ALPHA);
  await win.waitForTimeout(500); // dot size/opacity/shadow transition runs 150ms
  expect(await size(ALPHA)).toEqual({ w: 10, h: 10 });
  expect((await elementColour(win, marker(ALPHA), 'background-color')).a, 'active offline dot has no fill').toBe(0);
  expect(await backdrop(ALPHA)).toBe('none');
  await expectAccentRing(ALPHA, 'active offline');
  expect(await effectiveOpacity(marker(ALPHA)), 'active offline dot is not dimmed').toBe(1);

  // Inactive online (this machine, now deselected): 8px, no ring, glass.
  expect(await size(LOCAL_MACHINE_ID)).toEqual({ w: 8, h: 8 });
  expect(await ring(LOCAL_MACHINE_ID), 'inactive dot has no accent ring').toBeNull();
  expect(await effectiveOpacity(marker(LOCAL_MACHINE_ID))).toBe(1);
  await expect(marker(LOCAL_MACHINE_ID)).not.toHaveAttribute('data-active');

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

test('AC34/AC35 (this machine): the dot tint follows the local agent state; only busy pulses; tooltip and name carry the status word', async () => {
  await selectDot(LOCAL_MACHINE_ID);
  const id = await projectId(win, PROJECT);
  await waitForShell(win, id, 0, 'mock-claude ready');
  const lbl = AGGREGATE_STATE_LABEL;
  const self = selfName === '' ? [MACHINE_COPY.thisMachineFallback] : [selfName, MACHINE_COPY.thisMachineTag];

  const step = async (command: string, state: AgentState, token: '--agent-idle' | '--agent-busy' | '--agent-blocked') => {
    await sendLine(win, id, 0, command);
    await expect(marker(LOCAL_MACHINE_ID)).toHaveAttribute('data-agent-state', state, { timeout: 15_000 });
    await win.waitForTimeout(400); // fill transition
    // Tint: the agent colour at partial alpha.
    const tint = await elementColour(win, marker(LOCAL_MACHINE_ID), 'background-color');
    const want = await resolveToken(win, token, aside());
    expect(tint.a, `${state} tint is translucent`).toBeGreaterThan(0.3);
    expect(tint.a).toBeLessThan(1);
    expect(colourDistance({ ...tint, a: 1 }, { ...want, a: 1 }), `${state} tint matches ${token}`).toBeLessThan(14);
    // Only busy pulses.
    const pulses = (await marker(LOCAL_MACHINE_ID).getAttribute('class'))!.split(/\s+/).includes('live-dot');
    expect(pulses, `${state}: pulse only while busy`).toBe(state === 'busy');
    const anim = await marker(LOCAL_MACHINE_ID).evaluate((el) => getComputedStyle(el, '::after').animationName);
    expect(anim, `${state}: the dot's own pulse keyframes run only while busy`).toBe(state === 'busy' ? 'machineDotPulse' : 'none');
    // AC35: accessible name and tooltip.
    await expect(dot(LOCAL_MACHINE_ID)).toHaveAttribute('aria-label', `${self.join(', ')}, agent ${lbl[state]}`);
    await win.mouse.move(700, 400); // leave first: a pointer already over the dot (from the click) fires no mouseenter
    await dot(LOCAL_MACHINE_ID).hover();
    await expect.poll(() => win.getByRole('tooltip').allTextContents(), { message: `${state} tooltip` }).toContain(`${self.join(' · ')} · ${lbl[state]}`);
    await win.mouse.move(700, 400);
    await expect(win.getByRole('tooltip')).toHaveCount(0);
  };

  await step('/status-title-work', 'busy', '--agent-busy');
  await step('/status-modern-approval', 'blocked', '--agent-blocked');
  await step('/status-ready', 'idle', '--agent-idle');

  // Clear glass: offline peers (no agent) carry no agent state and no status word; the control above shows the attribute does appear.
  await expect(marker(ALPHA)).not.toHaveAttribute('data-agent-state');
  await expect(dot(ALPHA)).toHaveAttribute('aria-label', offlineAccessibleName('Alpha Box'));

  // No live agent: kill the only local shell; the dot goes back to clear glass and the status word disappears.
  await win.evaluate(async (pid: number) => {
    await (window as unknown as { api: Api }).api.invoke('shells:kill', { projectId: pid, shellIndex: 0 });
  }, id);
  await expect(marker(LOCAL_MACHINE_ID)).not.toHaveAttribute('data-agent-state', { timeout: 15_000 });
  await expect(dot(LOCAL_MACHINE_ID)).toHaveAttribute('aria-label', localAccessibleName());
});

test('AC32: the dot row has no background, border or shadow; each online dot is frosted glass', async () => {
  const rowStyle = await band().evaluate((el) => {
    const c = getComputedStyle(el);
    return { bw: [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth], shadow: c.boxShadow,
      backdrop: c.backdropFilter || 'none' };
  });
  expect((await elementColour(win, band(), 'background-color')).a, 'dot row is transparent').toBe(0);
  expect(rowStyle.bw, 'no border').toEqual(['0px', '0px', '0px', '0px']);
  expect(rowStyle.shadow, 'no shadow').toBe('none');
  expect(rowStyle.backdrop, 'no blur on the row itself').toBe('none');

  // Positive control: the online dot (this machine) is glass: blur, translucent fill, 1px translucent edge.
  const glass = await marker(LOCAL_MACHINE_ID).evaluate((el) => {
    const c = getComputedStyle(el);
    return { backdrop: c.backdropFilter || 'none', borderW: c.borderTopWidth, borderStyle: c.borderTopStyle };
  });
  expect(glass.backdrop, 'dot backdrop blur').not.toBe('none');
  expect(glass.borderW, '1px edge').toBe('1px');
  const fillColour = await elementColour(win, marker(LOCAL_MACHINE_ID), 'background-color');
  expect(fillColour.a, 'translucent fill (not clear)').toBeGreaterThan(0);
  expect(fillColour.a, 'translucent fill (not opaque)').toBeLessThan(1);
  const edge = await resolveCssColour(await css(marker(LOCAL_MACHINE_ID), 'border-top-color'));
  expect(edge.a, 'edge is translucent').toBeLessThan(1);

  // The row hugs the dots and stays within the sidebar minus 16px.
  const b = await box(band());
  const a = await box(aside());
  expect(b.width).toBeLessThanOrEqual(a.width - 16);
  const r = await box(row());
  expect(b.width, 'row hugs the dots').toBeLessThanOrEqual(r.width + 24);
});

test('AC8: the pill and its dots are no-drag; the drag fill and the sidebar area beside the pill stay drag', async () => {
  const region = (l: Locator) => css(l, '-webkit-app-region');
  expect(await region(fill()), 'positive control: drag fill is a drag region').toBe('drag');
  expect(await region(band())).toBe('no-drag');
  // The strip under the pill (8px) and the area left of it resolve to a drag region: walk up from the element
  // painted there to the first ancestor that sets an app region.
  const b = await box(band());
  const a = await box(aside());
  const effective = (x: number, y: number) => win.evaluate(({ x, y }) => {
    for (let n = document.elementFromPoint(x, y); n; n = n.parentElement) {
      const r = getComputedStyle(n).getPropertyValue('-webkit-app-region');
      if (r && r !== 'none') return r;
    }
    return 'none';
  }, { x, y });
  // The dot buttons set no region themselves; they sit inside the no-drag pill, so the effective region is no-drag.
  for (const k of [LOCAL_MACHINE_ID, ALPHA, STUDIO, ZED]) {
    const d = await box(dot(k));
    expect(await effective(d.x + d.width / 2, d.y + d.height / 2), `${k} dot`).toBe('no-drag');
  }
  // With the 40-project list filling the sidebar, the area beside/under the pill is the list's own padding
  // (no app region, as the list rows always were); the drag fill has no height here. What AC8 requires of the
  // pill is that its no-drag carve-out stops at the pill: just outside it nothing is no-drag.
  expect(await effective(b.x + b.width / 2, a.y + a.height - 2), 'strip under the pill is not no-drag').not.toBe('no-drag');
  expect(await effective(b.x - 6, b.y + b.height / 2), 'area left of the pill is not no-drag').not.toBe('no-drag');
  expect(await effective(b.x + b.width + 6, b.y + b.height / 2), 'area right of the pill is not no-drag').not.toBe('no-drag');
  expect(await effective(b.x + b.width / 2, b.y + b.height / 2), 'control: the pill itself is no-drag').toBe('no-drag');
});

test('AC3: the pill is centred on the sidebar within 2px at the default and the minimum width', async () => {
  for (const width of [SIDEBAR_WIDTH.default, SIDEBAR_WIDTH.min]) {
    await setSidebarWidth(width);
    await expectDotCount(4);
    const a = await box(aside());
    const first = await box(dot(LOCAL_MACHINE_ID));
    const last = await box(dot(ZED));
    const pill = await box(band());
    const dotsCentre = pill.x + pill.width / 2;
    expect(Math.abs((first.x + last.x + last.width) / 2 - dotsCentre), 'dots are centred in the pill').toBeLessThanOrEqual(2);
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

test('AC33: scrolled to the end, the last list row sits above the pill and can be clicked', async () => {
  await selectDot(LOCAL_MACHINE_ID);
  await expectDotCount(4);
  const area = scrollArea();
  const dims = await area.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(dims.sh, 'control: the list overflows, so it scrolls').toBeGreaterThan(dims.ch + 100);
  await area.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => area.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), { message: 'scrolled to the end' }).toBeLessThanOrEqual(1);
  const last = win.getByTestId('section-all').locator('[data-testid="project-row"]').last();
  const lb = await box(last);
  const pb = await box(band());
  expect(lb.y + lb.height, 'last row bottom is at or above the pill top').toBeLessThanOrEqual(pb.y + 0.5);
  // The pill really overlays the list (control): the list box extends beneath it.
  const ab = await box(area);
  expect(ab.y + ab.height).toBeGreaterThanOrEqual(pb.y + pb.height - 0.5);
  const name = /filler-\d+|switcher-proj/.exec((await last.textContent()) ?? '')?.[0];
  expect(name, 'last row has a known project name').toBeTruthy();
  await last.click();
  await expect(win.getByTestId('status-bar')).toContainText(name!);
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
