/**
 * Markdown preview — Mermaid diagrams and LaTeX math (spec AC1–AC23, AC10a).
 * The theme test is AC7 of mermaid-app-palette.md, which supersedes AC6 here.
 *
 * Every fixture is copied from tests/e2e/fixtures/markdown/ (plus a few
 * generated ones) into one temp project, which is opened in the Files tab
 * of the built Electron app. Diagrams render asynchronously after the
 * preview's HTML lands, so every diagram assertion first waits for each
 * block's state attribute to leave `pending`.
 *
 * Three app instances: a shared one for rendering, security and
 * performance cases; a fresh one for the lazy-chunk check (AC21 needs a
 * renderer that has never loaded mermaid); and one for theme switching
 * (AC7), so theme changes cannot leak into the other groups.
 */

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MARKDOWN_PREVIEW_TESTID,
  MATH_ERROR_CLASS,
  MERMAID_BLOCK_CLASS,
  MERMAID_EMPTY_MESSAGE,
  MERMAID_ERROR_CLASS,
  MERMAID_ERROR_PREFIX,
  MERMAID_OUTPUT_CLASS,
  MERMAID_SOURCE_CLASS,
  MERMAID_STATE_ATTR,
  MERMAID_THEME_ATTR,
} from '../../src/renderer/markdown/contract';

const PROJECT = 'mdproj';
const FIXTURES = resolve(process.cwd(), 'tests/e2e/fixtures/markdown');
const BLOCK = `.${MERMAID_BLOCK_CLASS}`;
const OUTPUT = `.${MERMAID_OUTPUT_CLASS}`;
const PENDING = `${BLOCK}[${MERMAID_STATE_ATTR}="pending"]`;
const RENDERED = `${BLOCK}[${MERMAID_STATE_ATTR}="rendered"]`;
const ERRORED = `${BLOCK}[${MERMAID_STATE_ATTR}="error"]`;
// Mermaid stamps aria-roledescription on every SVG it produces; no app icon has one.
const MERMAID_SVG = 'svg[aria-roledescription]';
const CSP_TEXT = /Content Security Policy/i;
const MERMAID_CHUNK = /mermaid\.core-[^/]*\.js/;

/* ───────────────────────────── generated fixtures ───────────────────────────── */

/** `count` distinct flowcharts (distinct so the adapter cache cannot short-cut them). */
function diagramDoc(token: string, count: number, formulasPerSection: number): string {
  const parts = [`# ${token} document`, ''];
  for (let i = 1; i <= count; i++) {
    const formulas = Array.from(
      { length: formulasPerSection },
      (_, j) => `$x_{${i}}^{${j}} + ${j}$`,
    );
    parts.push(
      `## Section ${i}`,
      '',
      `Formulas ${formulas.join(' and ')}.`,
      '',
      '```mermaid',
      'flowchart LR',
      `  ${token}${i}A[${token} ${i} start] --> ${token}${i}B{${token} ${i} choice}`,
      `  ${token}${i}B -->|yes| ${token}${i}C[${token} ${i} yes]`,
      `  ${token}${i}B -->|no| ${token}${i}D[${token} ${i} no]`,
      '```',
      '',
    );
  }
  return parts.join('\n');
}

/* ─────────────────────────────── app harness ─────────────────────────────── */

interface Ide {
  app: ElectronApplication;
  win: Page;
  projDir: string;
  pageErrors: string[];
  cspConsole: string[];
  requests: string[];
  cleanup: () => Promise<void>;
}

async function launchIde(label: string): Promise<Ide> {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const home = mkdtempSync(join(tmpdir(), `metaide-md-${label}-home-`));
  const root = mkdtempSync(join(tmpdir(), `metaide-md-${label}-root-`));
  const projDir = join(root, PROJECT);
  mkdirSync(projDir);
  mkdirSync(join(projDir, '.git'));
  cpSync(FIXTURES, projDir, { recursive: true });
  rmSync(join(projDir, '.gitkeep'), { force: true });
  writeFileSync(join(projDir, 'perf.md'), diagramDoc('PERFDOC', 20, 10));
  writeFileSync(join(projDir, 'race-old.md'), diagramDoc('OLDDOC', 20, 0));
  writeFileSync(join(projDir, 'race-new.md'), diagramDoc('NEWDOC', 20, 0));
  mkdirSync(join(projDir, 'sub'));
  writeFileSync(join(projDir, 'sub', 'inside.txt'), 'inside\n');

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(home, 'userData')}`],
    env: {
      ...process.env,
      HOME: home,
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_DEFAULT_LAUNCH_FIRST: JSON.stringify({ argv: ['node', mockClaude], env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({
        argv: ['node', mockClaude, '--continue'],
        env: {},
      }),
    },
  });
  const win = await app.firstWindow();
  const ide: Ide = {
    app,
    win,
    projDir,
    pageErrors: [],
    cspConsole: [],
    requests: [],
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
  win.on('pageerror', (err) => ide.pageErrors.push(err.message));
  win.on('console', (msg) => {
    if (CSP_TEXT.test(msg.text())) ide.cspConsole.push(msg.text());
  });
  win.on('request', (req) => ide.requests.push(req.url()));
  await win.waitForLoadState('domcontentloaded');

  // Second CSP signal besides the console: the DOM violation event. The
  // resource-timing buffer (250 entries by default) is widened because the
  // shared instance loads many mermaid chunks and fonts before AC16 reads it.
  await win.evaluate(() => {
    performance.setResourceTimingBufferSize(100000);
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });

  // Record shell.openExternal instead of opening a browser. The main-process
  // handler rejects non-allow-listed schemes before calling it, so an empty
  // list proves no external open happened for any scheme.
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] };
    g.__opened = [];
    shell.openExternal = async (url: string) => {
      g.__opened.push(url);
    };
  });

  // Seed the root through IPC (dialogs are no-ops under METAIDE_TEST_MODE).
  await win.evaluate(async (path: string) => {
    const api = (
      window as unknown as { api: { invoke: (c: string, r: unknown) => Promise<unknown> } }
    ).api;
    await api.invoke('roots:add', { path });
  }, root);
  const projectButton = win.getByRole('button', { name: PROJECT, exact: true });
  await expect(projectButton).toBeVisible({ timeout: 10000 });
  await projectButton.click();
  await win.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(fileEntry(win, 'flowchart.md')).toBeVisible({ timeout: 10000 });
  return ide;
}

function fileEntry(win: Page, name: string): Locator {
  return win.getByTestId('file-entry').filter({ has: win.getByText(name, { exact: true }) });
}

function preview(win: Page): Locator {
  return win.getByTestId(MARKDOWN_PREVIEW_TESTID);
}

/** Opens a root-level fixture and returns its preview once the HTML has landed. */
async function openFixture(win: Page, name: string): Promise<Locator> {
  await fileEntry(win, name).click();
  const p = preview(win);
  await expect(p).toBeVisible({ timeout: 10000 });
  await expect(win.getByTestId('file-preview')).toContainText(name);
  return p;
}

/** Waits until exactly `count` diagram blocks exist and none is still pending. */
async function settleDiagrams(p: Locator, count: number, timeout = 20000): Promise<void> {
  await expect(p.locator(BLOCK)).toHaveCount(count, { timeout: 10000 });
  await expect(p.locator(PENDING)).toHaveCount(0, { timeout });
}

async function openedExternally(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.slice());
}

async function resetOpened(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    (globalThis as unknown as { __opened: string[] }).__opened = [];
  });
}

async function windowGlobal(win: Page, key: string): Promise<unknown> {
  return win.evaluate((k) => (window as unknown as Record<string, unknown>)[k], key);
}

/** TeX source of each rendered formula (KaTeX's MathML annotation), document order. */
async function texSources(scope: Locator, selector: string): Promise<string[]> {
  return scope
    .locator(selector)
    .evaluateAll((els) =>
      els.map(
        (el) =>
          el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? '',
      ),
    );
}

/** Resource URLs the renderer has fetched, from request events and resource timing. */
async function loadedUrls(ide: Ide): Promise<string[]> {
  const timing = await ide.win.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => e.name),
  );
  return [...ide.requests, ...timing];
}

/** Computed fill of the first node shape — a proxy for the diagram's palette. */
async function nodeFill(block: Locator): Promise<string> {
  return block
    .locator(`${OUTPUT} svg g.node`)
    .first()
    .locator('rect, polygon, circle, path')
    .first()
    .evaluate((el) => getComputedStyle(el).fill);
}

/** Registers per-test log resets and the zero-pageerror / zero-CSP-violation checks (AC4, AC17). */
function guardConsole(get: () => Ide): void {
  test.beforeEach(async () => {
    const ide = get();
    ide.pageErrors.length = 0;
    ide.cspConsole.length = 0;
    await ide.win.evaluate(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
    });
    await resetOpened(ide.app);
  });
  test.afterEach(async () => {
    const ide = get();
    const domViolations = await ide.win.evaluate(() =>
      (window as unknown as { __csp: string[] }).__csp.slice(),
    );
    expect(ide.pageErrors, 'pageerror events').toEqual([]);
    expect(ide.cspConsole, 'CSP console messages').toEqual([]);
    expect(domViolations, 'securitypolicyviolation events').toEqual([]);
  });
}

/* ═══════════════════════ rendering, security, performance ═══════════════════════ */

test.describe('markdown preview: mermaid and math', () => {
  let ide: Ide;
  test.beforeAll(async () => {
    ide = await launchIde('main');
  });
  test.afterAll(async () => {
    await ide?.cleanup();
  });
  guardConsole(() => ide);

  test('AC1: a mermaid fence renders as an inline SVG in place of the code block', async () => {
    const p = await openFixture(ide.win, 'flowchart.md');
    await settleDiagrams(p, 1);
    const block = p.locator(BLOCK);
    await expect(block).toHaveAttribute(MERMAID_STATE_ATTR, 'rendered');
    await expect(block.locator(`${OUTPUT} svg`)).toHaveCount(1);
    await expect(block.locator(`${OUTPUT} svg`)).toContainText('Flow start');
    await expect(block.locator(`.${MERMAID_SOURCE_CLASS}`)).toBeHidden();
    // Not left as a highlighted code block, and the surrounding text renders.
    await expect(p.locator('pre code.language-mermaid')).toHaveCount(0);
    await expect(p).toContainText('Paragraph before the diagram.');
    await expect(p).toContainText('Paragraph after the diagram.');
  });

  const diagramTypes: Array<{ file: string; role: RegExp; text: string }> = [
    { file: 'flowchart.md', role: /flowchart/i, text: 'Flow start' },
    { file: 'sequence.md', role: /sequence/i, text: 'SEQHELLO' },
    { file: 'class.md', role: /class/i, text: 'ClassAnimal' },
    { file: 'state.md', role: /state/i, text: 'StateIdle' },
    { file: 'gantt.md', role: /gantt/i, text: 'GanttTitle' },
  ];
  for (const { file, role, text } of diagramTypes) {
    test(`AC2: ${file.replace('.md', '')} diagram renders`, async () => {
      const p = await openFixture(ide.win, file);
      await settleDiagrams(p, 1);
      await expect(p.locator(RENDERED)).toHaveCount(1);
      await expect(p.locator(`.${MERMAID_ERROR_CLASS}`)).toHaveCount(0);
      const svg = p.locator(`${OUTPUT} ${MERMAID_SVG}`);
      await expect(svg).toHaveCount(1);
      expect(await svg.getAttribute('aria-roledescription')).toMatch(role);
      await expect(svg).toContainText(text);
    });
  }

  test('AC3: several fences each render independently, in document order', async () => {
    const p = await openFixture(ide.win, 'multi.md');
    await settleDiagrams(p, 3);
    await expect(p.locator(RENDERED)).toHaveCount(3);
    const blocks = p.locator(BLOCK);
    await expect(blocks.nth(0).locator(`${OUTPUT} svg`)).toContainText('First diagram');
    await expect(blocks.nth(1).locator(`${OUTPUT} svg`)).toContainText('Second diagram');
    await expect(blocks.nth(2).locator(`${OUTPUT} svg`)).toContainText('Third diagram');
    for (let i = 0; i < 3; i++) await expect(blocks.nth(i).locator(`${OUTPUT} svg`)).toHaveCount(1);
  });

  test('AC4: a syntax error shows an inline error for that block only, with no stray nodes', async () => {
    const win = ide.win;
    const bodyChildren = () =>
      win.evaluate(() =>
        Array.from(document.body.children).map((e) => `${e.tagName}#${e.id}.${e.className}`),
      );
    const before = await bodyChildren();

    const p = await openFixture(win, 'mermaid-error.md');
    await settleDiagrams(p, 3);
    const blocks = p.locator(BLOCK);
    await expect(blocks.nth(0)).toHaveAttribute(MERMAID_STATE_ATTR, 'rendered');
    await expect(blocks.nth(1)).toHaveAttribute(MERMAID_STATE_ATTR, 'error');
    await expect(blocks.nth(2)).toHaveAttribute(MERMAID_STATE_ATTR, 'rendered');
    await expect(blocks.nth(0).locator(`${OUTPUT} svg`)).toContainText('Before');
    await expect(blocks.nth(2).locator(`${OUTPUT} svg`)).toContainText('After');

    const bad = blocks.nth(1);
    const error = bad.locator(`.${MERMAID_ERROR_CLASS}`);
    await expect(error).toBeVisible();
    await expect(error).toContainText('Mermaid');
    const errorText = (await error.textContent()) ?? '';
    expect(errorText.startsWith(MERMAID_ERROR_PREFIX)).toBe(true);
    // The parser's own message, not just the prefix.
    expect(errorText).toMatch(/Parse error on line \d+/i);
    await expect(bad.locator(`.${MERMAID_SOURCE_CLASS}`)).toBeVisible();
    await expect(bad.locator(`.${MERMAID_SOURCE_CLASS}`)).toContainText('BROKENNODE[unclosed');
    await expect(bad.locator(OUTPUT)).toHaveCount(0);
    await expect(p).toContainText('Text before the diagrams.');
    await expect(p).toContainText('Text after the diagrams.');

    await expect(
      win.getByTestId('toast').filter({ hasText: /mermaid|syntax|parse|diagram/i }),
    ).toHaveCount(0);
    expect(await bodyChildren()).toEqual(before);
    const strays = await win.evaluate(
      ({ testId }) => {
        const root = document.querySelector(`[data-testid="${testId}"]`);
        const outside = (el: Element) => !root?.contains(el);
        const errorSvgs = Array.from(
          document.querySelectorAll('svg[aria-roledescription="error"]'),
        );
        const syntaxText = Array.from(document.querySelectorAll('body *')).filter(
          (el) => el.children.length === 0 && /Syntax error in text/i.test(el.textContent ?? ''),
        );
        return [...errorSvgs, ...syntaxText]
          .filter(outside)
          .map((el) => el.outerHTML.slice(0, 120));
      },
      { testId: MARKDOWN_PREVIEW_TESTID },
    );
    expect(strays).toEqual([]);
    expect(ide.pageErrors).toEqual([]);
  });

  test('AC5: an empty fence shows the inline error, not a blank area', async () => {
    const p = await openFixture(ide.win, 'mermaid-empty.md');
    await settleDiagrams(p, 2);
    const blocks = p.locator(BLOCK);
    await expect(blocks.nth(0)).toHaveAttribute(MERMAID_STATE_ATTR, 'error');
    const error = blocks.nth(0).locator(`.${MERMAID_ERROR_CLASS}`);
    await expect(error).toBeVisible();
    await expect(error).toContainText('Mermaid');
    await expect(error).toContainText(MERMAID_EMPTY_MESSAGE);
    await expect(blocks.nth(1)).toHaveAttribute(MERMAID_STATE_ATTR, 'rendered');
    await expect(blocks.nth(1).locator(`${OUTPUT} svg`)).toContainText('Neighbour');
    await expect(p).toContainText('Text after the empty fence.');
  });

  test('AC7: a diagram wider than the column is scaled to fit without overflow', async () => {
    const p = await openFixture(ide.win, 'wide.md');
    await settleDiagrams(p, 1);
    await expect(p.locator(RENDERED)).toHaveCount(1);
    const m = await p.evaluate((el, sel) => {
      const svg = el.querySelector(`${sel} svg`) as SVGSVGElement;
      const scroller = el.parentElement as HTMLElement;
      return {
        intrinsic: svg.viewBox.baseVal.width,
        svgWidth: svg.getBoundingClientRect().width,
        column: el.clientWidth,
        previewScroll: el.scrollWidth,
        scrollerScroll: scroller.scrollWidth,
        scrollerClient: scroller.clientWidth,
      };
    }, OUTPUT);
    // The diagram really is wider than the column, so fitting is not trivial.
    expect(m.intrinsic).toBeGreaterThan(m.column);
    expect(m.svgWidth).toBeLessThanOrEqual(m.column + 1);
    expect(m.previewScroll).toBeLessThanOrEqual(m.column + 1);
    expect(m.scrollerScroll).toBeLessThanOrEqual(m.scrollerClient + 1);
  });

  test('AC8, AC9: hostile diagrams execute nothing and clicks inside diagrams never navigate', async () => {
    const { win, app } = ide;
    await win.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      delete w.__pwned;
      w.pwn = () => {
        w.__pwned = 'callback';
      };
    });
    const url = win.url();
    const windows = app.windows().length;

    const p = await openFixture(win, 'hostile-diagram.md');
    await settleDiagrams(p, 2);
    // Positive control: both diagrams rendered under strict security, despite the loose init directive.
    await expect(p.locator(RENDERED)).toHaveCount(2);
    await expect(p.locator(BLOCK).nth(0).locator(`${OUTPUT} svg`)).toContainText('HostileCallback');
    await expect(p.locator(BLOCK).nth(1).locator(`${OUTPUT} svg`)).toContainText('StrictHref');

    const dangerous = await p.evaluate((el) => ({
      scripts: el.querySelectorAll('script').length,
      handlers: Array.from(el.querySelectorAll('*')).filter((n) =>
        Array.from(n.attributes).some((a) => a.name.toLowerCase().startsWith('on')),
      ).length,
      jsLinks: Array.from(el.querySelectorAll('a')).filter((a) =>
        /javascript:/i.test(`${a.getAttribute('href')} ${a.getAttribute('xlink:href')}`),
      ).length,
    }));
    expect(dangerous).toEqual({ scripts: 0, handlers: 0, jsLinks: 0 });

    for (const label of [
      'HostileImg',
      'HostileScript',
      'HostileCallback',
      'HostileHref',
      'StrictImg',
      'StrictHref',
    ]) {
      await p.locator(`${OUTPUT} svg g.node`, { hasText: label }).first().click();
    }

    // AC9: anchors Mermaid's strict output would not produce — xlink:href only, and no href at all.
    await p
      .locator(BLOCK)
      .nth(1)
      .evaluate((block, sel) => {
        const svg = block.querySelector(`${sel} svg`) as SVGSVGElement;
        const vb = svg.viewBox.baseVal;
        const add = (label: string, y: number, attr: string | null, value: string) => {
          const a = document.createElementNS('http://www.w3.org/2000/svg', 'a');
          if (attr) a.setAttributeNS('http://www.w3.org/1999/xlink', attr, value);
          const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          t.setAttribute('x', String(vb.x + 4));
          t.setAttribute('y', String(vb.y + y));
          t.setAttribute('font-size', '14');
          t.textContent = label;
          a.appendChild(t);
          svg.appendChild(a);
        };
        add('XLINKHTTPS', 16, 'xlink:href', 'https://example.com/xlink');
        add('XLINKJS', 34, 'xlink:href', "javascript:window.__pwned='xlink'");
        add('NOHREF', 52, null, '');
      }, OUTPUT);
    for (const label of ['XLINKHTTPS', 'XLINKJS', 'NOHREF']) {
      await p.locator(`${OUTPUT} svg a`, { hasText: label }).click();
    }

    expect(await windowGlobal(win, '__pwned')).toBeUndefined();
    expect(win.url()).toBe(url);
    expect(app.windows()).toHaveLength(windows);
    expect(await openedExternally(app)).toEqual([]);
    await expect(preview(win)).toBeVisible();

    // Positive control: the link stub is live — a normal link outside the diagrams opens externally.
    await p.getByRole('link', { name: 'outside link' }).click();
    await expect.poll(() => openedExternally(app)).toEqual(['https://example.com/outside']);
    expect(win.url()).toBe(url);
  });

  test('AC10, AC10a, AC11: all five math forms, fence case variants and backslash delimiters', async () => {
    const p = await openFixture(ide.win, 'math-forms.md');

    const dollarLine = p.locator('p', { hasText: 'Inline dollar' });
    expect(await texSources(dollarLine, '.katex')).toEqual(['a^2+b^2']);
    await expect(dollarLine.locator('.katex-display')).toHaveCount(0);
    await expect(dollarLine).toContainText('end of dollar line.');
    const parenLine = p.locator('p', { hasText: 'Inline paren' });
    expect(await texSources(parenLine, '.katex')).toEqual(['c^2']);
    await expect(parenLine.locator('.katex-display')).toHaveCount(0);

    const display = await texSources(p, '.katex-display');
    for (const tex of [
      '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}',
      '\\int_0^1 x\\,dx',
      'E = mc^2',
      'm_{case}',
      'M_{CASE}',
    ]) {
      expect(display).toContain(tex);
    }
    // AC11: the multi-line $$ block is one display formula holding every line.
    const multi = display.filter((t) => t.includes('a &= b + c'));
    expect(multi).toHaveLength(1);
    expect(multi[0]).toContain('d &= e + f');

    // AC10a: matched backslash pairs in prose render.
    expect(await texSources(p.locator('p', { hasText: 'Matched paren' }), '.katex')).toEqual([
      'p^2',
    ]);
    expect(await texSources(p, '.katex')).toContain('q^2');
    // AC10a: an unmatched opener stays literal, with no math and no error marker.
    for (const [start, literal] of [
      ['the regex', 'the regex ( alone'],
      ['bracket', 'bracket [ alone'],
    ] as const) {
      const para = p.locator('p', { hasText: start }).filter({ hasNotText: 'Matched' });
      await expect(para).toHaveText(literal);
      await expect(para.locator('.katex')).toHaveCount(0);
      await expect(para.locator(`.${MATH_ERROR_CLASS}`)).toHaveCount(0);
    }
    await expect(p.locator(`.${MATH_ERROR_CLASS}`)).toHaveCount(0);

    // AC10: Mermaid / MERMAID fence info strings are recognised too.
    await settleDiagrams(p, 2);
    await expect(p.locator(RENDERED)).toHaveCount(2);
    await expect(p.locator(BLOCK).nth(0).locator(`${OUTPUT} svg`)).toContainText(
      'Mixed case fence',
    );
    await expect(p.locator(BLOCK).nth(1).locator(`${OUTPUT} svg`)).toContainText(
      'Upper case fence',
    );
  });

  test('AC12, AC13: dollar amounts, spaced dollars, escapes and code stay literal', async () => {
    const p = await openFixture(ide.win, 'math-literals.md');
    // Positive control in the same render.
    expect(await texSources(p.locator('p', { hasText: 'Real math' }), '.katex')).toEqual(['z^2']);

    const literals: Array<[string, string]> = [
      ['Prices', 'Prices costs $5 and $10 today.'],
      ['Spaced', 'Spaced $ x $ stays literal.'],
      ['Escaped', 'Escaped $5 stays literal.'],
      ['Shell echo', 'Shell echo $HOME stays literal.'],
    ];
    for (const [start, text] of literals) {
      const para = p.locator('p', { hasText: start });
      await expect(para).toHaveText(text);
      await expect(para.locator('.katex, .' + MATH_ERROR_CLASS)).toHaveCount(0);
    }

    const inline = p.locator('p', { hasText: 'Inline code' }).locator('code');
    await expect(inline).toHaveText(['$x$', '\\(y\\)']);
    await expect(p.locator('pre', { hasText: 'fenced' })).toContainText(
      'fenced $a$ and \\(b\\) and \\[c\\]',
    );
    await expect(p.locator('pre', { hasText: 'indented' })).toContainText(
      'indented $d$ and \\(e\\)',
    );
    await expect(p.locator('code .katex, pre .katex')).toHaveCount(0);
    await expect(p.locator('.katex')).toHaveCount(1);
  });

  test('AC14, AC15: a bad formula errors alone; untrusted commands yield no links or injected markup', async () => {
    const { win, app } = ide;
    const p = await openFixture(win, 'math-errors.md');

    const bad = p.locator('p', { hasText: 'Bad formula' });
    const marker = bad.locator(`.${MATH_ERROR_CLASS}`);
    await expect(marker).toHaveCount(1);
    await expect(marker).toContainText('\\frac{1}{');
    expect(await marker.getAttribute('title')).toMatch(/error|expected/i);
    expect(await texSources(bad, '.katex')).toEqual(['y^2']);
    await expect(bad).toContainText('between good');
    await expect(bad).toContainText('and text.');

    for (const start of ['Href formula', 'Url formula', 'Htmlclass formula', 'Htmldata formula']) {
      const para = p.locator('p', { hasText: start });
      await expect(para.locator(`.katex, .${MATH_ERROR_CLASS}`).first()).toBeVisible();
      await expect(para).toContainText('end.');
    }
    await expect(p.locator('.katex a, .' + MATH_ERROR_CLASS + ' a')).toHaveCount(0);
    await expect(p.locator('.pwnclass, [data-pwn]')).toHaveCount(0);
    // Positive control: the one real Markdown link is the only anchor in the preview.
    await expect(p.locator('a')).toHaveCount(1);
    await expect(p.locator('a')).toHaveAttribute('href', 'https://example.com/real');

    const url = win.url();
    // Click the visible rendering; the MathML annotation holding the source is hidden.
    await p
      .locator('p', { hasText: 'Href formula' })
      .locator(`.katex-html, .${MATH_ERROR_CLASS}`)
      .first()
      .click();
    expect(await windowGlobal(win, '__pwnedMath')).toBeUndefined();
    expect(win.url()).toBe(url);
    expect(await openedExternally(app)).toEqual([]);
  });

  test('AC16: math fonts load from the app bundle and render the glyphs', async () => {
    const p = await openFixture(ide.win, 'math-fonts.md');
    expect(await texSources(p, '.katex-display')).toHaveLength(1);
    const wanted = ['KaTeX_Main', 'KaTeX_Math', 'KaTeX_AMS', 'KaTeX_Size2', 'KaTeX_Size3'];
    await expect
      .poll(
        () =>
          ide.win.evaluate(async () => {
            await document.fonts.ready;
            return Array.from(document.fonts)
              .filter((f) => f.status === 'loaded')
              .map((f) => f.family.replace(/["']/g, ''));
          }),
        { timeout: 10000 },
      )
      .toEqual(expect.arrayContaining(wanted));
    for (const family of wanted) {
      expect(await ide.win.evaluate((f) => document.fonts.check(`16px ${f}`), family)).toBe(true);
    }

    const urls = await loadedUrls(ide);
    const fontUrls = urls.filter((u) => /KaTeX_[\w-]+\.(woff2?|ttf)/.test(u));
    // Positive control: font loads were observed at all, and all came from the app's own files.
    expect(fontUrls.length).toBeGreaterThan(0);
    expect(fontUrls.filter((u) => !u.startsWith('file:'))).toEqual([]);
    expect(urls.filter((u) => !/^(file|data|blob):/.test(u))).toEqual([]);
  });

  test('AC18: raw HTML in the Markdown body renders as escaped text', async () => {
    const p = await openFixture(ide.win, 'raw-html.md');
    await expect(p).toContainText('Raw HTML control paragraph.');
    // The typographer curls the quotes, so match the quote-free parts of the escaped markup.
    await expect(p).toContainText('<script>window.__pwnedMd = ');
    await expect(p).toContainText('</script>');
    await expect(p).toContainText('<img src=x onerror=');
    await expect(p.locator('script, img')).toHaveCount(0);
    expect(await windowGlobal(ide.win, '__pwnedMd')).toBeUndefined();
  });

  test('AC19: other code fences stay highlighted and link routing is unchanged', async () => {
    const { win, app } = ide;
    const p = await openFixture(win, 'links-code.md');
    await expect(p.locator('pre code .hljs-keyword').first()).toBeVisible();
    await expect(p.locator('pre code')).toContainText('const answer: number = 42;');
    await expect(p.locator(BLOCK)).toHaveCount(0);
    const url = win.url();

    await p.getByRole('link', { name: 'relative link' }).click();
    await p.getByRole('link', { name: 'fragment link' }).click();
    expect(win.url()).toBe(url);
    expect(await openedExternally(app)).toEqual([]);

    await p.getByRole('link', { name: 'web link' }).click();
    await p.getByRole('link', { name: 'mail link' }).click();
    await expect
      .poll(() => openedExternally(app))
      .toEqual(['https://example.com/web', 'mailto:someone@example.com']);
    expect(win.url()).toBe(url);
  });

  test('AC20: Edit mode renders nothing; Preview renders the unsaved buffer', async () => {
    const win = ide.win;
    const p = await openFixture(win, 'edit-mode.md');
    await settleDiagrams(p, 1);
    const mermaidAnywhere = win.locator(
      `${BLOCK}, ${OUTPUT}, [${MERMAID_STATE_ATTR}], ${MERMAID_SVG}`,
    );
    // Positive control: rendered output exists before switching to Edit.
    await expect(mermaidAnywhere.first()).toBeAttached();

    await win.getByTestId('file-edit-toggle').click();
    const editor = win.getByTestId('file-editor').locator('textarea');
    await expect(editor).toBeVisible();
    await expect(preview(win)).toHaveCount(0);
    await expect(mermaidAnywhere).toHaveCount(0);

    const original = await editor.inputValue();
    expect(original).toContain('EDITORIG');
    const edited = `${original
      .replace(/EDITORIG/g, 'EDITEDNODE')
      .replace('Original node', 'Edited node')
      .replace('$a^2$', '$b^3$')}
\`\`\`mermaid
flowchart TD
  NEWFENCENODE[Typed in editor] --> NEWFENCE2[ok]
\`\`\`
`;
    await editor.fill(edited);
    await expect(editor).toHaveValue(edited);
    await expect(preview(win)).toHaveCount(0);
    await expect(mermaidAnywhere).toHaveCount(0);

    await win.getByTestId('file-edit-toggle').click();
    const back = preview(win);
    await expect(back).toBeVisible();
    await settleDiagrams(back, 2);
    await expect(back.locator(RENDERED)).toHaveCount(2);
    // Assert on the rendered SVG, not the hidden source: the edit is proven by what is drawn.
    await expect(back.locator(BLOCK).nth(0).locator(`${OUTPUT} svg`)).toContainText('Edited node');
    await expect(back.locator(BLOCK).nth(0).locator(`${OUTPUT} svg`)).not.toContainText(
      'Original node',
    );
    await expect(back.locator(BLOCK).nth(1).locator(`${OUTPUT} svg`)).toContainText(
      'Typed in editor',
    );
    await expect(back).not.toContainText('EDITORIG');
    expect(await texSources(back, '.katex')).toEqual(['b^3']);
    // Unsaved: the file on disk still has the original source.
    await expect(win.getByTestId('file-save')).toBeEnabled();
    expect(readFileSync(join(ide.projDir, 'edit-mode.md'), 'utf8')).toContain('EDITORIG');
  });

  test('AC22: 20 diagrams and 200 formulas render within 15 s and the tree stays clickable', async () => {
    const win = ide.win;
    const started = Date.now();
    await fileEntry(win, 'perf.md').click();
    const p = preview(win);
    await expect(p.locator(BLOCK)).toHaveCount(20, { timeout: 10000 });

    // Responsiveness: while diagrams are still pending, a Files-tree click is handled.
    const pendingAtClick = await p.locator(PENDING).count();
    expect(
      pendingAtClick,
      'precondition: diagrams still rendering when the tree is clicked',
    ).toBeGreaterThan(0);
    const clickAt = Date.now();
    await fileEntry(win, 'sub').click();
    await expect(win.getByRole('button', { name: '← root' })).toBeVisible({ timeout: 3000 });
    const clickLatency = Date.now() - clickAt;

    await win.waitForFunction(
      ({ testId, pending }) => {
        const root = document.querySelector(`[data-testid="${testId}"]`);
        return !!root && root.querySelectorAll(pending).length === 0;
      },
      { testId: MARKDOWN_PREVIEW_TESTID, pending: PENDING },
      { timeout: Math.max(1, 15000 - (Date.now() - started)), polling: 50 },
    );
    const elapsed = Date.now() - started;
    test.info().annotations.push({
      type: 'AC22 render time',
      description: `${elapsed} ms (tree click ${clickLatency} ms)`,
    });
    console.log(
      `AC22: 20 diagrams + 200 formulas rendered in ${elapsed} ms; tree click answered in ${clickLatency} ms`,
    );
    expect(elapsed).toBeLessThanOrEqual(15000);

    await expect(p.locator(RENDERED)).toHaveCount(20);
    await expect(p.locator(ERRORED)).toHaveCount(0);
    await expect(p.locator('.katex')).toHaveCount(200);
    await win.getByRole('button', { name: '← root' }).click();
    await expect(fileEntry(win, 'perf.md')).toBeVisible();
  });

  test('AC23: switching files mid-render never injects the old diagrams into the new preview', async () => {
    const win = ide.win;
    await fileEntry(win, 'race-old.md').click();
    const p = preview(win);
    await expect(p.locator(BLOCK)).toHaveCount(20, { timeout: 10000 });

    // Switch in the same task as the pending check, so the old doc is provably mid-render.
    const pendingAtSwitch = await win.evaluate(
      ({ testId, pending }) => {
        const count =
          document.querySelector(`[data-testid="${testId}"]`)?.querySelectorAll(pending).length ??
          0;
        const target = Array.from(document.querySelectorAll('[data-testid="file-entry"]')).find(
          (b) => b.textContent?.includes('race-new.md'),
        ) as HTMLElement | undefined;
        target?.click();
        return target ? count : -1;
      },
      { testId: MARKDOWN_PREVIEW_TESTID, pending: PENDING },
    );
    expect(
      pendingAtSwitch,
      'precondition: old document still rendering at the switch',
    ).toBeGreaterThan(0);

    await expect(win.getByTestId('file-preview')).toContainText('race-new.md');
    // The new doc's 20 renders queue behind any in-flight old render, so once they
    // settle every old render has finished and had its chance to write.
    await settleDiagrams(p, 20);
    await expect(p.locator(RENDERED)).toHaveCount(20);
    for (let i = 0; i < 20; i++) {
      await expect(p.locator(BLOCK).nth(i).locator(OUTPUT)).toHaveCount(1);
    }
    await expect(p.locator(`${OUTPUT} svg`).first()).toContainText('NEWDOC 1 start');
    const oldAnywhere = await win.evaluate(() =>
      (document.body.textContent ?? '').includes('OLDDOC'),
    );
    expect(oldAnywhere).toBe(false);
  });
});

/* ═════════════════════════════════ lazy loading ═════════════════════════════════ */

test.describe('markdown preview: lazy diagram chunk', () => {
  let ide: Ide;
  test.beforeAll(async () => {
    ide = await launchIde('lazy');
  });
  test.afterAll(async () => {
    await ide?.cleanup();
  });
  guardConsole(() => ide);

  test('AC21: a document without mermaid fences never loads the diagram chunk', async () => {
    const p = await openFixture(ide.win, 'math-only.md');
    // Positive control: the document fully rendered (math and highlighted code).
    expect(await texSources(p, '.katex')).toContain('e^{i\\pi} + 1 = 0');
    await expect(p.locator('pre code .hljs-keyword').first()).toBeVisible();
    await expect(p.locator(BLOCK)).toHaveCount(0);
    expect((await loadedUrls(ide)).filter((u) => MERMAID_CHUNK.test(u))).toEqual([]);

    // Positive control for the detector: opening a diagram doc does load the chunk.
    const q = await openFixture(ide.win, 'flowchart.md');
    await settleDiagrams(q, 1);
    await expect(q.locator(RENDERED)).toHaveCount(1);
    await expect
      .poll(async () => (await loadedUrls(ide)).filter((u) => MERMAID_CHUNK.test(u)).length)
      .toBeGreaterThan(0);
  });
});

/* ═════════════════════════════════════ theme ═════════════════════════════════════ */

test.describe('markdown preview: diagram theme', () => {
  let ide: Ide;
  test.beforeAll(async () => {
    ide = await launchIde('theme');
  });
  test.afterAll(async () => {
    await ide?.cleanup();
  });
  guardConsole(() => ide);

  test('AC7 (mermaid-app-palette; supersedes markdown-mermaid-math AC6): diagrams follow the app theme live from every control; a directive theme is kept', async () => {
    const win = ide.win;
    const p = await openFixture(win, 'theme.md');
    const plain = p.locator(BLOCK).nth(0);
    const forest = p.locator(BLOCK).nth(1);

    /** Waits for both diagrams to re-render in `theme`, then returns their node fills. */
    const expectTheme = async (theme: 'light' | 'dark') => {
      await expect(p.locator(`${OUTPUT}[${MERMAID_THEME_ATTR}="${theme}"]`)).toHaveCount(2, {
        timeout: 15000,
      });
      await settleDiagrams(p, 2);
      await expect(p.locator(RENDERED)).toHaveCount(2);
      return { plain: await nodeFill(plain), forest: await nodeFill(forest) };
    };

    // First run defaults to dark.
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await expectTheme('dark');
    await expect(forest.locator(`${OUTPUT} svg`)).toContainText('Forest diagram');
    // The app palette, not Mermaid's built-in dark node fill (#1f2020).
    expect(dark.plain).not.toBe('rgb(31, 32, 32)');

    // Title-bar toggle.
    await win.getByTestId('theme-toggle').click();
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await expectTheme('light');
    expect(light.plain).not.toBe(dark.plain);
    // The app palette, not Mermaid's built-in default node fill (#ececff).
    expect(light.plain).not.toBe('rgb(236, 236, 255)');
    expect(light.forest).toBe(dark.forest);
    await expect(win.getByTestId('file-preview')).toContainText('theme.md');

    // Command palette.
    await win.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'P',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const palette = win.getByTestId('command-palette');
    await palette.getByPlaceholder('Run a command…').fill('Use dark theme');
    await palette.getByText('Use dark theme', { exact: true }).click();
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
    const darkAgain = await expectTheme('dark');
    expect(darkAgain.plain).toBe(dark.plain);
    expect(darkAgain.forest).toBe(dark.forest);

    // Settings — its own useTheme instance.
    await win.getByTestId('settings-open').click();
    const settings = win.getByTestId('settings-modal');
    await settings.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    expect((await expectTheme('light')).plain).toBe(light.plain);

    // System mode follows the OS preference.
    await win.emulateMedia({ colorScheme: 'dark' });
    await settings.getByRole('button', { name: /^System/ }).click();
    await expect(win.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    expect((await expectTheme('dark')).plain).toBe(dark.plain);
    await win.emulateMedia({ colorScheme: 'light' });
    const systemLight = await expectTheme('light');
    expect(systemLight.plain).toBe(light.plain);
    expect(systemLight.forest).toBe(dark.forest);
    await win.getByTestId('settings-done').click();
  });
});
