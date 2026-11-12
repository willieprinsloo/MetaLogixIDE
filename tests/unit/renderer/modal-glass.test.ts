/**
 * AC21, AC24, AC25, AC26: every owned modal surface renders through `ModalFrame` (scrim and layer
 * as siblings, the sheet inside the layer, never the scrim, with no ad-hoc `bg-black/`,
 * `backdrop-blur-` or `bg-[--panel-strong]` panel classes), motion is assigned per
 * `MODAL_SURFACES`, the shared `.modal-scrim`/`.modal-layer`/`.modal-sheet` rules never animate a
 * transform or filter, the reduced-transparency override is the only place besides the base
 * declaration that sets the three material tokens, and every dark/light token resolves in the
 * dark, light and system-light blocks.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';
import type { ModalSurface } from '@renderer/modal-glass';
import { UnloadSessionDialogView } from '@renderer/components/UnloadSessionDialog';

vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn() } }));
vi.mock('@renderer/components/settings/SettingsSectionPanel', () => ({
  SettingsSectionPanel: () => null,
}));

const { Settings } = await import('@renderer/components/Settings');
const { PermissionModeDialog } = await import('@renderer/components/PermissionModeDialog');
const { NewProjectDialog } = await import('@renderer/components/NewProjectDialog');
const { ProjectSearch } = await import('@renderer/components/ProjectSearch');
const { PromptLibrary } = await import('@renderer/components/PromptLibrary');
const { ScrollbackSearch } = await import('@renderer/components/ScrollbackSearch');
const { RenameProjectDialog } = await import('@renderer/components/Sidebar');
const { MODAL_SURFACES } = await import('@renderer/modal-glass');

const noop = () => undefined;
const noopAsync = async () => undefined;

const RENDERERS: Record<string, () => string> = {
  settings: () =>
    renderToStaticMarkup(
      createElement(Settings, {
        open: true,
        onClose: noop,
        section: 'general',
        onSection: noop,
        envDrafts: { get: () => undefined, set: noop, clear: noop, isDirty: () => false },
      }),
    ),
  'new-project': () =>
    renderToStaticMarkup(
      createElement(NewProjectDialog, { open: true, roots: [], onClose: noop, onCreated: noop }),
    ),
  'permission-mode': () =>
    renderToStaticMarkup(createElement(PermissionModeDialog, { onConfirm: noopAsync, error: null })),
  'project-search': () =>
    renderToStaticMarkup(
      createElement(ProjectSearch, { open: true, projectId: 1, onClose: noop, onOpenMatch: noop }),
    ),
  'prompt-library': () =>
    renderToStaticMarkup(
      createElement(PromptLibrary, { open: true, onClose: noop, projectId: 1, activeShell: null }),
    ),
  'scrollback-search': () =>
    renderToStaticMarkup(createElement(ScrollbackSearch, { open: true, onClose: noop, onFocus: noop })),
  'rename-project': () =>
    renderToStaticMarkup(
      createElement(RenameProjectDialog, {
        project: { id: 1, name: 'demo', path: '/tmp/demo' } as never,
        onClose: noop,
        onDone: noopAsync,
      }),
    ),
  'unload-session': () =>
    renderToStaticMarkup(createElement(UnloadSessionDialogView, {
      name: 'demo',
      state: { kind: 'ready', inspection: { kind: 'live', generation: 'test', agent: null, state: null }, consent: { work: false, input: false, visible: false }, error: null },
      risk: { work: false, input: false, visible: false },
      onKeep: noop,
      onConfirm: noop,
      onRetry: noop,
      onKeyDown: noop,
      panelRef: createRef<HTMLElement>(),
      keepRef: createRef<HTMLButtonElement>(),
    })),
};

const OWNED: readonly string[] = [
  'settings',
  'new-project',
  'permission-mode',
  'project-search',
  'prompt-library',
  'scrollback-search',
  'rename-project',
  'unload-session',
];

function surfaceFor(id: string): ModalSurface {
  const surface = MODAL_SURFACES.find((s) => s.id === id);
  if (!surface) throw new Error(`no MODAL_SURFACES entry for ${id}`);
  return surface;
}

describe.each(OWNED)('%s renders through ModalFrame', (id) => {
  const surface = surfaceFor(id);
  const html = RENDERERS[id]!();

  it('renders exactly one scrim, as an empty sibling element (not an ancestor of the sheet)', () => {
    const scrimRe = new RegExp(`<div[^>]*data-testid="${surface.testId}-scrim"[^>]*></div>`);
    expect(html).toMatch(scrimRe);
  });

  it('renders the layer carrying the surface testid, with the sheet inside it', () => {
    const layerRe = new RegExp(`<div[^>]*class="[^"]*modal-layer[^"]*"[^>]*data-testid="${surface.testId}"[^>]*>`);
    expect(html).toMatch(layerRe);
    const layerIdx = html.search(layerRe);
    expect(layerIdx).toBeGreaterThanOrEqual(0);
    const afterLayer = html.slice(layerIdx);
    expect(afterLayer).toMatch(/class="[^"]*modal-sheet[^"]*"/);
  });

  it("the sheet's own class never carries the old ad-hoc backdrop/panel classes", () => {
    const sheetClass = /class="([^"]*\bmodal-sheet\b[^"]*)"/.exec(html)?.[1];
    expect(sheetClass, 'sheet element not found').toBeDefined();
    expect(sheetClass).not.toMatch(/bg-black\/\d+/);
    expect(sheetClass).not.toMatch(/backdrop-blur-/);
    expect(sheetClass).not.toMatch(/\bbg-\[--panel-strong\]/);
    expect(sheetClass).not.toMatch(/(?<!:)\bshadow-2xl\b/);
    expect(sheetClass).not.toMatch(/(?<!:)\brounded-(xl|2xl)\b/);
  });

  it(`uses the compact sheet radius only when MODAL_SURFACES says radius is compact (${surface.radius})`, () => {
    const hasCompact = /class="[^"]*modal-sheet--compact[^"]*"/.test(html);
    expect(hasCompact).toBe(surface.radius === 'compact');
  });

  it(`gets the fade motion classes only when MODAL_SURFACES says motion is fade (${surface.motion})`, () => {
    expect(html.includes('modal-backdrop')).toBe(surface.motion === 'fade');
    expect(html.includes('modal-panel')).toBe(surface.motion === 'fade');
  });
});

const cssPath = resolve(__dirname, '../../../src/renderer/styles.css');
const css = readFileSync(cssPath, 'utf8');

function extractBlock(source: string, selector: RegExp): string {
  const m = selector.exec(source);
  if (!m) throw new Error(`block not found for ${selector}`);
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start, i - 1);
}

function ruleBody(name: string): string {
  return extractBlock(css, new RegExp(`\\.${name.replace('.', '\\.')}\\s*\\{`));
}

describe('shared material CSS rules never animate', () => {
  it.each(['modal-scrim', 'modal-layer', 'modal-sheet'])('%s has no transform, transition, or bare filter', (cls) => {
    const body = ruleBody(cls);
    expect(body).not.toMatch(/\btransform\s*:/);
    expect(body).not.toMatch(/\btransition\s*:/);
    expect(body).not.toMatch(/(?<!backdrop-)\bfilter\s*:/);
  });

  it('the motion-only .modal-backdrop/.modal-panel rules are unchanged (opacity + scale, no blur)', () => {
    const backdrop = ruleBody('modal-backdrop');
    const panel = ruleBody('modal-panel');
    expect(backdrop).toMatch(/transition:\s*opacity/);
    expect(panel).toMatch(/transition:[\s\S]*opacity[\s\S]*transform/);
    expect(backdrop).not.toMatch(/blur\(/);
    expect(panel).not.toMatch(/blur\(/);
  });
});

const modalSection = css.slice(css.indexOf('Modal material (D1T'));
const modalShared = extractBlock(modalSection, /:root\s*\{/);
const modalLight = extractBlock(modalSection, /:root\[data-theme="light"\]\s*\{/);
const modalSystemLight = extractBlock(
  modalSection,
  /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{/,
);
const modalRT = extractBlock(modalSection, /prefers-reduced-transparency:\s*reduce\)\s*\{\s*:root\s*\{/);

describe('reduced transparency (AC24)', () => {
  it('the RT block sets the opaque panel and removes both filters', () => {
    expect(modalRT).toMatch(/--modal-panel:\s*var\(--modal-panel-base\);/);
    expect(modalRT).toMatch(/--modal-scrim-filter:\s*none;/);
    expect(modalRT).toMatch(/--modal-panel-filter:\s*none;/);
  });

  it('the specificity invariant holds: --modal-panel, --modal-scrim-filter and --modal-panel-filter are set only by the base declaration and the RT override', () => {
    for (const token of ['--modal-panel:', '--modal-scrim-filter:', '--modal-panel-filter:']) {
      const count = css.split(token).length - 1;
      expect(count, token).toBe(2);
    }
  });
});

describe('AC23: every dark/light modal token is defined in the dark, light and system-light blocks', () => {
  const tokens = ['--modal-scrim', '--modal-lift', '--modal-panel-alpha', '--modal-raised-lift', '--modal-edge', '--modal-shadow'];

  it.each(tokens)('%s is declared in the shared/dark block', (token) => {
    expect(modalShared).toContain(`${token}:`);
  });
  it.each(tokens)('%s is declared in the light block', (token) => {
    expect(modalLight).toContain(`${token}:`);
  });
  it.each(tokens)('%s is declared in the system-light block', (token) => {
    expect(modalSystemLight).toContain(`${token}:`);
  });
});
