import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SIDEBAR_COPY, SIDEBAR_TESTIDS, SECTION_PERSIST_KEYS } from '../../src/renderer/sidebar-copy';
import { closeApp, guardedLaunch } from './helpers/claude-harness';

/**
 * Sidebar header: one row with a filter field and a "+" button whose menu
 * holds New project, Add root folder and Rescan roots; the full list is
 * headed "Projects"; section rhythm
 * (docs/specs/2026-10-06-shell-chrome-cleanup.md AC16–AC23, AC21a).
 *
 * One app with one root holding `alpha` and `beta`. Tests run in file order
 * and share the app; the collapsed-state test reloads, so it runs last. The
 * section tests (AC23–AC24d) each seed their own In use and Recents rows with
 * `seedSections`, so a worker restart after an earlier failure cannot leave
 * them without rows.
 * Not covered here, by ruling Q3: the "Rescanning…" disabled state and the
 * Add-root wiring for a picked folder (unit tests, A1.2) — the native picker
 * resolves null under METAIDE_TEST_MODE.
 */

type Api = { invoke: (c: string, r: unknown) => Promise<never> };

const COLLAPSED_KEY = 'metaide.sectionsCollapsed';

let app: ElectronApplication;
let win: Page;
let isolatedHome: string;
let demoRoot: string;

test.beforeAll(async () => {
  await guardedLaunch(async (scope) => {
    const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
    isolatedHome = scope.tempDir('metaide-addmenu-home-');
    demoRoot = scope.tempDir('metaide-addmenu-root-');
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(demoRoot, name));
      mkdirSync(join(demoRoot, name, '.git'));
    }

    app = scope.own(await electron.launch({
      args: ['.', `--user-data-dir=${join(isolatedHome, 'userData')}`],
      env: {
        ...process.env,
        HOME: isolatedHome,
        METAIDE_TEST_MODE: '1',
        METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
        METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],              env: {} }),
        METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'], env: {} }),
      },
    }));
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1400, 900); });
    await win.evaluate(async (path: string) => {
      await (window as unknown as { api: Api }).api.invoke('roots:add', { path });
    }, demoRoot);
    for (const name of ['alpha', 'beta']) await expect(projectRow(name)).toBeVisible({ timeout: 5000 });
  });
});

test.afterAll(async () => {
  if (app) await closeApp(app);
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(demoRoot, { recursive: true, force: true });
});

/* ─────────────────────────────── helpers ─────────────────────────────── */

const aside = () => win.locator('aside[data-view="projects"]');
const addBtn = () => win.getByTestId(SIDEBAR_TESTIDS.addButton);
const menu = () => win.getByTestId('context-menu');
const item = (id: string) => win.getByTestId(id);
const dialog = () => win.getByTestId('new-project-dialog');
/** The filter's text input, whether the test id sits on the input or on its wrapping field. */
const filterInput = () =>
  win.locator(`input[data-testid="${SIDEBAR_TESTIDS.filter}"], [data-testid="${SIDEBAR_TESTIDS.filter}"] input`);

function projectRow(name: string): Locator {
  return win.locator('[data-testid="project-row"]').filter({ has: win.getByText(name, { exact: true }) }).first();
}

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('element has no bounding box (not rendered)');
  return b;
}

function css(l: Locator, prop: string): Promise<string> {
  return l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
}

function radii(l: Locator): Promise<string[]> {
  return l.evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
  });
}

async function invoke<T>(channel: string, req: unknown): Promise<T> {
  return win.evaluate(({ channel, req }) => (window as unknown as { api: Api }).api.invoke(channel, req), { channel, req }) as Promise<T>;
}

async function projectIdOf(name: string): Promise<number> {
  const { projects } = await invoke<{ projects: { id: number; name: string }[] }>('projects:list', undefined);
  const p = projects.find((x) => x.name === name);
  if (!p) throw new Error(`no project ${name}`);
  return p.id;
}

/**
 * Marks the filter field and the header row in the page so they can be
 * measured: the field is the input's wrapping `<label>` (or the input), and
 * the header row is the nearest element holding both the field and "+".
 */
async function markHeader(): Promise<void> {
  await win.evaluate(({ filterSel, addId }) => {
    const input = document.querySelector<HTMLInputElement>(filterSel);
    const add = document.querySelector(`[data-testid="${addId}"]`);
    if (!input || !add) throw new Error('filter input or "+" button not found');
    const field = input.closest('label') ?? input;
    field.setAttribute('data-e2e', 'filter-field');
    let row: Element | null = field.parentElement;
    while (row && !row.contains(add)) row = row.parentElement;
    if (!row) throw new Error('no common header row');
    row.setAttribute('data-e2e', 'header-row');
  }, {
    filterSel: `input[data-testid="${SIDEBAR_TESTIDS.filter}"], [data-testid="${SIDEBAR_TESTIDS.filter}"] input`,
    addId: SIDEBAR_TESTIDS.addButton,
  });
}

/**
 * Marks the sidebar's scroll region (the aside's child that scrolls vertically)
 * and returns its box, content-box edges and padding.
 */
async function markScrollRegion(): Promise<{ left: number; right: number; contentLeft: number; contentRight: number; paddingRight: string }> {
  return aside().evaluate((el) => {
    const region = [...el.children].find((c) => getComputedStyle(c).overflowY === 'auto' || getComputedStyle(c).overflowY === 'scroll');
    if (!region) throw new Error('no scroll region in the sidebar');
    region.setAttribute('data-e2e', 'scroll-region');
    const r = region.getBoundingClientRect();
    const cs = getComputedStyle(region);
    return {
      left: r.left,
      right: r.right,
      contentLeft: r.left + parseFloat(cs.paddingLeft),
      contentRight: r.right - parseFloat(cs.paddingRight) - (region.clientWidth < r.width ? r.width - region.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth) : 0),
      paddingRight: cs.paddingRight,
    };
  });
}


/**
 * Seeds the sections the row and header tests measure: In use holds `beta`
 * (alive), Recents holds `alpha` (opened, then its shell killed). Clears the
 * filter and expands every section first. Safe to repeat: re-opening an
 * alive or recent project is harmless.
 */
async function seedSections(): Promise<void> {
  await filterInput().fill('');
  for (const id of ['section-in-use', 'section-recents', SIDEBAR_TESTIDS.sectionAll]) {
    const t = win.getByTestId(`${id}-toggle`);
    if ((await t.count()) > 0 && (await t.getAttribute('aria-expanded')) === 'false') await t.click();
  }
  await projectRow('alpha').click();
  await expect(projectRow('alpha')).toHaveAttribute('data-alive', '1', { timeout: 10000 });
  await projectRow('beta').click();
  await expect(projectRow('beta')).toHaveAttribute('data-alive', '1', { timeout: 10000 });
  // Kill every alpha shell: a re-opened project need not get shell index 0 again.
  const alphaId = await projectIdOf('alpha');
  const { shells } = await invoke<{ shells: { projectId: number; shellIndex: number }[] }>('shells:alive-list', undefined);
  const alphaShells = shells.filter((sh) => sh.projectId === alphaId);
  expect(alphaShells.length, 'seed: alpha has a live shell to kill').toBeGreaterThan(0);
  for (const sh of alphaShells) await invoke('shells:kill', { projectId: alphaId, shellIndex: sh.shellIndex });
  const inUse = win.getByTestId('section-in-use');
  const recents = win.getByTestId('section-recents');
  await expect(inUse.getByTestId('project-row'), 'seed: In use holds beta only').toHaveText(['beta'], { timeout: 10000 });
  await expect(recents.getByTestId('project-row').filter({ hasText: 'alpha' }), 'seed: Recents holds alpha').toHaveCount(1);
  await expect(win.getByTestId('section-recents-toggle'), 'seed: Recents expanded').toHaveAttribute('aria-expanded', 'true');
}

async function openMenuByClick(): Promise<void> {
  await addBtn().click();
  await expect(menu()).toBeVisible();
}

async function closeDialog(): Promise<void> {
  await win.getByTestId('new-project-name').press('Escape');
  await expect(dialog()).toHaveCount(0);
}

/* ─────────────────────────────── header ─────────────────────────────── */

test('AC16: the header is one row holding exactly the filter and one "+" button', async () => {
  await expect(addBtn(), 'positive control: the "+" button renders').toBeVisible();
  await expect(filterInput(), 'positive control: the filter renders').toBeVisible();
  await markHeader();
  const row = win.locator('[data-e2e="header-row"]');
  const controls = await row.evaluate((el) =>
    [...el.querySelectorAll('input, button, select, textarea, a[href], [role="button"]')]
      .map((c) => c.getAttribute('data-testid') ?? c.tagName.toLowerCase()));
  expect(controls.length, `header controls: ${controls.join(', ')}`).toBe(2);
  expect(controls).toContain(SIDEBAR_TESTIDS.addButton);
  await expect(row.locator('input')).toHaveCount(1);

  const field = await box(win.locator('[data-e2e="filter-field"]'));
  const plus = await box(addBtn());
  expect(Math.abs((field.y + field.height / 2) - (plus.y + plus.height / 2)), 'filter and "+" share one row').toBeLessThanOrEqual(1);

  await expect(aside().getByText('+ Root', { exact: true })).toHaveCount(0);
  await expect(aside().getByText('+ Project', { exact: true })).toHaveCount(0);
  await expect(win.getByTestId('sidebar-rescan'), 'no standalone rescan button').toHaveCount(0);
  await expect(win.getByTestId('new-project-btn')).toHaveCount(0);
});

test('AC17: the filter is 36px with a 10px radius, a search icon left of the input, placeholder "Filter projects", and filters as before', async () => {
  await markHeader();
  const field = win.locator('[data-e2e="filter-field"]');
  const input = filterInput();
  expect((await box(field)).height).toBe(36);
  expect(await radii(field)).toEqual(['10px', '10px', '10px', '10px']);
  await expect(input).toHaveAttribute('placeholder', SIDEBAR_COPY.filterPlaceholder);
  await expect(win.getByRole('textbox', { name: SIDEBAR_COPY.filterLabel })).toHaveCount(1);

  const icon = field.locator('svg');
  await expect(icon, 'search icon inside the field').toHaveCount(1);
  const ib = await box(icon);
  const inb = await box(input);
  expect(ib.x + ib.width, 'search icon sits left of the input').toBeLessThanOrEqual(inb.x + 0.5);

  await expect(projectRow('alpha')).toBeVisible();
  await expect(projectRow('beta'), 'positive control: both rows before filtering').toBeVisible();
  await input.fill('alp');
  await expect(projectRow('alpha')).toBeVisible();
  await expect(projectRow('beta')).toHaveCount(0);
  await input.fill('');
  await expect(projectRow('beta')).toBeVisible();
});

test('AC18: "+" is 36x36 with a 10px radius and is named "New project"', async () => {
  const b = await box(addBtn());
  expect([b.width, b.height]).toEqual([36, 36]);
  expect(await radii(addBtn())).toEqual(['10px', '10px', '10px', '10px']);
  await expect(addBtn()).toHaveAccessibleName(SIDEBAR_COPY.addButtonLabel);
});

/* ─────────────────────────────── "+" menu ─────────────────────────────── */

test('AC19: a click opens three items in order with the ⌘⇧N hint; Escape and an outside click close it with no action', async () => {
  const rootsBefore = (await invoke<{ roots: unknown[] }>('roots:list', undefined)).roots.length;
  await openMenuByClick();
  const ids = await menu().getByRole('menuitem').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(ids).toEqual([SIDEBAR_TESTIDS.menuNewProject, SIDEBAR_TESTIDS.menuAddRoot, SIDEBAR_TESTIDS.menuRescan]);
  await expect(item(SIDEBAR_TESTIDS.menuNewProject)).toContainText(SIDEBAR_COPY.menuNewProject);
  await expect(item(SIDEBAR_TESTIDS.menuNewProject).getByText(SIDEBAR_COPY.menuNewProjectHint, { exact: true })).toBeVisible();
  await expect(item(SIDEBAR_TESTIDS.menuAddRoot)).toHaveText(SIDEBAR_COPY.menuAddRoot);
  await expect(item(SIDEBAR_TESTIDS.menuRescan)).toHaveText(SIDEBAR_COPY.menuRescan);
  await expect(item(SIDEBAR_TESTIDS.menuRescan)).toBeEnabled();

  await win.keyboard.press('Escape');
  await expect(menu()).toHaveCount(0);
  await expect(dialog()).toHaveCount(0);

  await openMenuByClick();
  const status = await box(win.getByTestId('status-bar'));
  await win.mouse.click(status.x + status.width / 2, status.y + status.height / 2);
  await expect(menu()).toHaveCount(0);
  await expect(dialog()).toHaveCount(0);
  expect((await invoke<{ roots: unknown[] }>('roots:list', undefined)).roots.length, 'no root added').toBe(rootsBefore);
});

test('AC19/AC21a: Enter and Space open the menu; focus starts on the first item, arrows move and wrap, Escape returns focus to "+"', async () => {
  for (const key of ['Enter', 'Space'] as const) {
    await addBtn().focus();
    await win.keyboard.press(key);
    await expect(menu(), `${key} opens the menu`).toBeVisible();
    await expect(item(SIDEBAR_TESTIDS.menuNewProject)).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(menu()).toHaveCount(0);
    await expect(addBtn()).toBeFocused();
  }

  await addBtn().focus();
  await win.keyboard.press('Enter');
  await expect(item(SIDEBAR_TESTIDS.menuNewProject)).toBeFocused();
  await win.keyboard.press('ArrowDown');
  await expect(item(SIDEBAR_TESTIDS.menuAddRoot)).toBeFocused();
  await win.keyboard.press('ArrowUp');
  await expect(item(SIDEBAR_TESTIDS.menuNewProject)).toBeFocused();
  await win.keyboard.press('ArrowUp');
  await expect(item(SIDEBAR_TESTIDS.menuRescan), 'ArrowUp from the first item wraps to the last').toBeFocused();
  await win.keyboard.press('ArrowDown');
  await expect(item(SIDEBAR_TESTIDS.menuNewProject), 'ArrowDown from the last item wraps to the first').toBeFocused();

  await win.keyboard.press('Enter');
  await expect(menu()).toHaveCount(0);
  await expect(dialog(), 'Enter activates New project…').toBeVisible();
  await closeDialog();
});

test('AC20: "New project…" opens the new-project dialog with its name field focused', async () => {
  await openMenuByClick();
  await item(SIDEBAR_TESTIDS.menuNewProject).click();
  await expect(menu()).toHaveCount(0);
  await expect(dialog()).toBeVisible();
  await expect(win.getByTestId('new-project-name')).toBeFocused();
  await closeDialog();
});

test('AC20: "Add root folder…" with a cancelled picker adds nothing; "Rescan roots" picks up a folder created on disk', async () => {
  const rootsBefore = (await invoke<{ roots: unknown[] }>('roots:list', undefined)).roots.length;
  mkdirSync(join(demoRoot, 'gamma'));
  writeFileSync(join(demoRoot, 'gamma', 'package.json'), '{"name":"gamma"}\n');
  const listed = (await invoke<{ projects: { name: string }[] }>('projects:list', undefined)).projects.map((p) => p.name);
  expect(listed, 'input state: gamma is not known before the rescan').not.toContain('gamma');
  await expect(projectRow('gamma')).toHaveCount(0);

  // The folder picker resolves null under METAIDE_TEST_MODE.
  await openMenuByClick();
  await item(SIDEBAR_TESTIDS.menuAddRoot).click();
  await expect(menu()).toHaveCount(0);

  await openMenuByClick();
  await item(SIDEBAR_TESTIDS.menuRescan).click();
  await expect(menu()).toHaveCount(0);
  await expect(projectRow('gamma')).toBeVisible({ timeout: 10000 });
  await expect(win.getByTestId('toast').filter({ hasText: 'Rescanned 1 root' }), 'positive control: toasts render').toBeVisible();
  await expect(win.getByTestId('toast').filter({ hasText: /fail|error/i }), 'no error toast').toHaveCount(0);
  expect((await invoke<{ roots: unknown[] }>('roots:list', undefined)).roots.length, 'the cancelled picker added no root').toBe(rootsBefore);
  await expect(win.getByTestId('root-toggle')).toHaveCount(rootsBefore);
});

test('AC21: ⌘⇧N opens the new-project dialog and the menu never shows', async () => {
  await win.evaluate(() => {
    const w = window as unknown as { __menuSeen: boolean; __menuObserver?: MutationObserver };
    w.__menuSeen = false;
    w.__menuObserver?.disconnect();
    w.__menuObserver = new MutationObserver(() => {
      if (document.querySelector('[data-testid="context-menu"]')) w.__menuSeen = true;
    });
    w.__menuObserver.observe(document.body, { childList: true, subtree: true });
  });
  const seen = () => win.evaluate(() => (window as unknown as { __menuSeen: boolean }).__menuSeen);

  await openMenuByClick();
  expect(await seen(), 'positive control: the observer sees the menu').toBe(true);
  await win.keyboard.press('Escape');
  await expect(menu()).toHaveCount(0);
  await win.evaluate(() => { (window as unknown as { __menuSeen: boolean }).__menuSeen = false; });

  await win.keyboard.press('ControlOrMeta+Shift+N');
  await expect(dialog()).toBeVisible();
  expect(await seen(), 'the menu never rendered').toBe(false);
  await expect(menu()).toHaveCount(0);
  await closeDialog();
  await win.evaluate(() => (window as unknown as { __menuObserver?: MutationObserver }).__menuObserver?.disconnect());
});

/* ─────────────────────────────── sections ─────────────────────────────── */

test('AC23: sections are 28px apart, 28px below the header; aside padding 48/0/20/8 with a 16px right inset on header and scroll content; headers 11px uppercase 0.06em', async () => {
  // In use (beta, alive) and Recents (alpha, opened then unloaded) both show.
  await seedSections();
  const inUse = win.getByTestId('section-in-use');
  const recents = win.getByTestId('section-recents');
  const all = win.getByTestId(SIDEBAR_TESTIDS.sectionAll);

  const pad = await aside().evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft];
  });
  expect(pad, 'aside padding: no right padding, the right inset lives inside').toEqual(['48px', '0px', '20px', '8px']);

  await markHeader();
  const header = await box(win.locator('[data-e2e="header-row"]'));
  const asideBox = await box(aside());
  expect(asideBox.x + asideBox.width - (header.x + header.width), 'header row right inset').toBeCloseTo(16, 0);
  const scroll = await markScrollRegion();
  expect(scroll.right, 'scroll region reaches the aside edge').toBeCloseTo(asideBox.x + asideBox.width, 0);
  expect(scroll.paddingRight, 'scroll content right inset').toBe('16px');
  const [a, b, c] = [await box(inUse), await box(recents), await box(all)];
  expect(a.y - (header.y + header.height), 'header row to first section').toBeCloseTo(28, 0);
  expect(b.y - (a.y + a.height), 'In use to Recents').toBeCloseTo(28, 0);
  expect(c.y - (b.y + b.height), 'Recents to Projects').toBeCloseTo(28, 0);

  for (const id of ['section-in-use', 'section-recents', SIDEBAR_TESTIDS.sectionAll]) {
    const t = win.getByTestId(`${id}-toggle`);
    expect(await css(t, 'font-size'), `${id} header size`).toBe('11px');
    expect(await css(t, 'text-transform'), `${id} header case`).toBe('uppercase');
    expect(parseFloat(await css(t, 'letter-spacing')), `${id} header tracking`).toBeCloseTo(0.06 * 11, 2);
  }
});

test('AC24b: the scroll region never overflows sideways and every row sits inside its content box', async () => {
  await seedSections();
  const scroll = await markScrollRegion();
  const region = win.locator('[data-e2e="scroll-region"]');
  const rows = win.locator('[data-e2e="scroll-region"] [data-testid="project-row"]');
  expect(await rows.count(), 'positive control: rows in In use, Recents and Projects').toBeGreaterThanOrEqual(4);
  for (const id of ['section-in-use', 'section-recents']) {
    await expect(region.getByTestId(id).getByTestId('project-row'), `positive control: ${id} rows are measured`).not.toHaveCount(0);
  }
  const widths = await region.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(widths.scroll, 'no horizontal overflow').toBe(widths.client);
  for (const row of await rows.all()) {
    const name = (await row.textContent())?.trim();
    const b = await box(row.locator('xpath=..'));
    expect(b.x, `${name} row left inside content box`).toBeGreaterThanOrEqual(scroll.contentLeft - 0.5);
    expect(b.x + b.width, `${name} row right inside content box`).toBeLessThanOrEqual(scroll.contentRight + 0.5);
  }
});

test('AC24c: project rows are 34px tall with 10px side padding, 8px radius and a 10px dot-to-name gap', async () => {
  await seedSections();
  await markScrollRegion();
  const rows = win.locator('[data-e2e="scroll-region"] [data-testid="project-row"]');
  expect(await rows.count(), 'positive control: rows found').toBeGreaterThanOrEqual(4);
  for (const id of ['section-in-use', 'section-recents']) {
    await expect(win.getByTestId(id).getByTestId('project-row'), `positive control: ${id} rows are measured`).not.toHaveCount(0);
  }
  for (const row of await rows.all()) {
    const name = (await row.textContent())?.trim() ?? '';
    const wrapper = row.locator('xpath=..');
    expect((await box(wrapper)).height, `${name} height`).toBe(34);
    expect([await css(wrapper, 'padding-left'), await css(wrapper, 'padding-right')], `${name} padding`).toEqual(['10px', '10px']);
    expect(await radii(wrapper), `${name} radius`).toEqual(['8px', '8px', '8px', '8px']);
    const gap = await row.evaluate((el) => {
      const [dot, label] = [...el.children];
      if (!dot || !label) throw new Error('row lacks dot or name');
      return label.getBoundingClientRect().left - dot.getBoundingClientRect().right;
    });
    expect(gap, `${name} dot-to-name gap`).toBeCloseTo(10, 0);
  }
});

test('AC24d: section headers align with the filter, show a right-edge 11px chevron, and expose the full root path in a tooltip', async () => {
  await seedSections();
  await markHeader();
  const field = await box(win.locator('[data-e2e="filter-field"]'));
  for (const id of ['section-in-use', 'section-recents', SIDEBAR_TESTIDS.sectionAll]) {
    const t = win.getByTestId(`${id}-toggle`);
    const first = await box(t.locator('> *').first());
    expect(first.x, `${id} header content aligns with the filter`).toBeCloseTo(field.x, 0);
    await t.hover();
    expect(await css(t, 'background-color'), `${id} header has no hover background`).toBe('rgba(0, 0, 0, 0)');
    const chevron = t.locator('> svg').last();
    const cb = await box(chevron);
    const tb = await box(t);
    expect([cb.width, cb.height], `${id} chevron size`).toEqual([12, 12]);
    expect(tb.x + tb.width - (cb.x + cb.width), `${id} chevron at the right edge`).toBeCloseTo(0, 0);
  }

  // Chevron rotates when collapsed (Recents toggled twice to restore).
  const recents = win.getByTestId('section-recents-toggle');
  const rot = () => recents.locator('> svg').last().evaluate((el) => getComputedStyle(el).transform);
  expect(await rot(), 'open: chevron not rotated').toBe('none');
  await recents.click();
  await expect(recents).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(rot, { message: 'collapsed: chevron rotated' }).not.toBe('none');
  await recents.click();
  await expect(recents).toHaveAttribute('aria-expanded', 'true');

  // Root toggle: same right-edge chevron and full-path tooltip, independent of label wording.
  const { roots } = await invoke<{ roots: { path: string }[] }>('roots:list', undefined);
  expect(roots, 'one seeded root').toHaveLength(1);
  const root = roots[0];
  if (!root) throw new Error('seeded root missing');
  const fullPath = root.path;
  const rootToggle = win.getByTestId('root-toggle');
  const label = rootToggle.locator(`[title="${fullPath}"]`);
  await expect(label).toBeVisible();
  await expect(label).toHaveAttribute('title', fullPath);
  const rc = await box(rootToggle.locator('> svg').last());
  const rt = await box(rootToggle);
  expect([rc.width, rc.height], 'root chevron size').toEqual([12, 12]);
  expect(rt.x + rt.width - (rc.x + rc.width), 'root chevron at the right (inside the toggle padding)').toBeLessThanOrEqual(10.5);
  expect(rc.x, 'root chevron right of the label').toBeGreaterThan((await box(label)).x);
});

/* ─────────────────────────────── rename (reloads; keep last) ─────────────────────────────── */

test('AC22: the full list is headed "Projects" and a collapsed state stored under the old name survives', async () => {
  const toggle = win.getByTestId(`${SIDEBAR_TESTIDS.sectionAll}-toggle`);
  const section = win.getByTestId(SIDEBAR_TESTIDS.sectionAll);
  const stored = () => win.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]') as string[], COLLAPSED_KEY);

  await win.evaluate(({ k, v }) => localStorage.setItem(k, JSON.stringify([v])), { k: COLLAPSED_KEY, v: SECTION_PERSIST_KEYS.projects });
  await win.reload();
  await win.waitForLoadState('domcontentloaded');

  await expect(toggle.getByText(SIDEBAR_COPY.projectsHeading, { exact: true })).toBeVisible({ timeout: 5000 });
  await expect(section.getByText('All projects')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(section.getByTestId('root-toggle'), 'collapsed: no roots listed').toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(section.getByTestId('root-toggle'), 'positive control: expanding lists the root').toHaveCount(1);
  expect(await stored()).not.toContain(SECTION_PERSIST_KEYS.projects);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await stored(), 'collapse persists under the legacy key').toContain(SECTION_PERSIST_KEYS.projects);
});
