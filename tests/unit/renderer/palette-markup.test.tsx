/**
 * Rendered markup of the command palette: combobox / listbox / group / option ARIA (AC3, AC20), the
 * project row's "Current" marker, status dot and ring (AC7), `kbd` hints (AC9), the prefix legend
 * (AC40), the capped marker (AC34), the empty state (AC14, AC41), the ModalFrame structure and
 * material classes (AC4, AC5a, AC21, AC25, design contract 1), the highlighted-row text token
 * (design finding 1) and escaping of project names (§5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentState } from '@shared/agent-state';
import type { Project } from '@shared/types';
import {
  PALETTE_COPY,
  PALETTE_TESTIDS,
  type PaletteCommand,
  type PaletteFilesState,
  type PaletteRequest,
} from '@renderer/command-palette-contract';
import { MODAL_TIER_Z } from '@renderer/modal-glass';

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  alive: new Set<number>(),
  files: { status: 'idle' } as PaletteFilesState,
  agentState: 'busy' as AgentState,
}));

vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn(), on: vi.fn(() => () => undefined) } }));
vi.mock('@renderer/hooks/useProjects', () => ({ useProjects: () => ({ projects: state.projects, refresh: vi.fn() }) }));
vi.mock('@renderer/hooks/useAliveShellIds', () => ({ useAliveShellIds: () => ({ aliveIds: state.alive, refresh: vi.fn() }) }));
vi.mock('@renderer/hooks/useAgentStates', () => ({ useProjectAgentState: () => state.agentState }));
vi.mock('@renderer/hooks/usePaletteFiles', () => ({ usePaletteFiles: () => state.files }));

const { CommandPalette } = await import('@renderer/components/CommandPalette');
const { RING_NEEDED } = await import('@renderer/components/palette/ProjectRow');
const { emptyText } = await import('@renderer/components/palette/PaletteList');

function project(id: number, name: string): Project {
  return {
    id, rootId: 1, path: `/work/${name}`, name, metaprojectProjectId: null, linkedChatChannelId: null,
    lastOpenedAt: null, pinned: false, hidden: false, firstLaunchedAt: null, config: {} as Project['config'],
  };
}

const COMMANDS: PaletteCommand[] = [
  { id: 'view.sidebar', title: 'Toggle sidebar', category: 'View', hint: '⌘B', run: () => undefined },
  { id: 'app.reload', title: 'Reload window', category: 'App', run: () => undefined },
  { id: 'shell.unload', title: 'Unload current session', category: 'Shell', needsProject: true, run: () => undefined },
];

interface RenderOpts {
  readonly seed?: PaletteRequest['seed'];
  readonly current?: Project | null;
  readonly request?: PaletteRequest | null;
}

function render({ seed = '', current = null, request }: RenderOpts = {}): string {
  return renderToStaticMarkup(
    <CommandPalette
      request={request === undefined ? { seq: 1, seed } : request}
      commands={COMMANDS}
      currentProject={current}
      onPickProject={() => undefined}
      onPickCurrent={() => undefined}
      onPickFile={() => undefined}
      onClose={() => undefined}
    />,
  );
}

interface El {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly classes: string[];
  readonly start: number;
}

function elements(html: string): El[] {
  const out: El[] = [];
  const re = /<([a-z]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*\/?>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[a[1] ?? ''] = a[2] ?? '';
    out.push({ tag: m[1] ?? '', attrs, classes: (attrs.class ?? '').split(/\s+/).filter(Boolean), start: m.index });
  }
  return out;
}

function byTestId(html: string, id: string): El[] {
  return elements(html).filter((e) => e.attrs['data-testid'] === id);
}

function one(html: string, id: string): El {
  const found = byTestId(html, id);
  expect(found, id).toHaveLength(1);
  return found[0] as El;
}

/** The markup of the element starting at `el` up to its matching close tag. */
function outer(html: string, el: El): string {
  const open = new RegExp(`<${el.tag}[\\s>]`, 'g');
  const close = `</${el.tag}>`;
  let depth = 0;
  let i = el.start;
  for (;;) {
    open.lastIndex = i + 1;
    const nextOpen = open.exec(html)?.index ?? Infinity;
    const nextClose = html.indexOf(close, i + 1);
    if (nextOpen < nextClose) { depth++; i = nextOpen; continue; }
    if (depth === 0) return html.slice(el.start, nextClose + close.length);
    depth--;
    i = nextClose;
  }
}

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function text(fragment: string): string {
  return decode(fragment.replace(/<[^>]+>/g, ''));
}

const options = (html: string): El[] => elements(html).filter((e) => e.attrs.role === 'option');

beforeEach(() => {
  state.projects = [project(1, 'alpha'), project(2, 'beta')];
  state.alive = new Set([1]);
  state.files = { status: 'idle' };
  state.agentState = 'busy';
});

describe('CommandPalette — closed', () => {
  it('renders nothing when there is no request', () => {
    expect(render({ request: null })).toBe('');
  });
});

describe('CommandPalette — frame and material (AC4, AC5a, AC21, AC25)', () => {
  it('renders the scrim and the layer as siblings, the sheet inside the layer', () => {
    const html = render();
    const scrim = one(html, PALETTE_TESTIDS.scrim);
    const layer = one(html, PALETTE_TESTIDS.root);
    expect(outer(html, scrim)).not.toContain('modal-sheet');
    expect(outer(html, scrim)).not.toContain(PALETTE_TESTIDS.panel);
    const panel = one(outer(html, layer), PALETTE_TESTIDS.panel);
    expect(panel.classes).toEqual(expect.arrayContaining(['modal-sheet', 'modal-sheet--compact']));
    expect(panel.classes).not.toContain('modal-scrim');
    expect(scrim.start).toBeLessThan(layer.start);
    expect(outer(html, scrim).length + outer(html, layer).length).toBe(html.length);
  });

  it('uses the palette z tier, above other modals', () => {
    const html = render();
    expect(one(html, PALETTE_TESTIDS.scrim).attrs.style).toContain(`z-index:${MODAL_TIER_Z.palette[0]}`);
    expect(one(html, PALETTE_TESTIDS.root).attrs.style).toContain(`z-index:${MODAL_TIER_Z.palette[1]}`);
  });

  it('opts out of motion and of the old ad-hoc overlay classes', () => {
    const all = elements(render()).flatMap((e) => e.classes);
    expect(all).not.toContain('modal-backdrop');
    expect(all).not.toContain('modal-panel');
    expect(all.filter((c) => c.startsWith('bg-black/') || c.startsWith('backdrop-blur-'))).toEqual([]);
  });
});

describe('CommandPalette — combobox and listbox (AC3, AC20)', () => {
  it('labels the input as a combobox controlling the listbox, with the fixed placeholder', () => {
    for (const seed of ['', '>', '@'] as const) {
      const html = render({ seed });
      const input = one(html, PALETTE_TESTIDS.input);
      const listbox = one(html, PALETTE_TESTIDS.listbox);
      expect(input.tag).toBe('input');
      expect(input.attrs.role).toBe('combobox');
      expect(input.attrs['aria-label']).toBe(PALETTE_COPY.inputLabel);
      expect(input.attrs.placeholder, seed).toBe(PALETTE_COPY.placeholder);
      expect(listbox.attrs.role).toBe('listbox');
      expect(listbox.attrs.id).toBeTruthy();
      expect(input.attrs['aria-controls']).toBe(listbox.attrs.id);
    }
  });

  it('seeds the input with the request seed', () => {
    expect(decode(one(render({ seed: '>' }), PALETTE_TESTIDS.input).attrs.value ?? '')).toBe('>');
    expect(one(render({ seed: '@' }), PALETTE_TESTIDS.input).attrs.value).toBe('@');
  });

  it('points aria-activedescendant at the one selected option, the first row', () => {
    const html = render();
    const opts = options(html);
    const selected = opts.filter((o) => o.attrs['aria-selected'] === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(opts[0]);
    expect(opts.slice(1).every((o) => o.attrs['aria-selected'] === 'false')).toBe(true);
    expect(new Set(opts.map((o) => o.attrs.id)).size).toBe(opts.length);
    const input = one(html, PALETTE_TESTIDS.input);
    expect(input.attrs['aria-activedescendant']).toBe(selected[0]?.attrs.id);
    expect(input.attrs['aria-expanded']).toBe('true');
  });

  it('wraps rows in groups labelled by their visible headings, in group order (AC6)', () => {
    const html = render();
    const groups = elements(html).filter((e) => e.attrs.role === 'group');
    expect(groups.every((g) => g.attrs['data-testid'] === PALETTE_TESTIDS.group)).toBe(true);
    const titles = groups.map((g) => {
      const heading = elements(html).find((e) => e.attrs.id === g.attrs['aria-labelledby']);
      expect(heading, g.attrs['aria-labelledby']).toBeDefined();
      return text(outer(html, heading as El));
    });
    expect(titles).toEqual(['Running', 'Projects', 'View', 'Shell', 'App']);
    for (const g of groups) expect(options(outer(html, g)).length).toBeGreaterThan(0);
  });

  it('renders the commands it is given unfiltered; App drops project-dependent ones (AC12, buildPaletteCommands)', () => {
    expect(render()).toContain('Unload current session');
  });

  it('shows the empty state outside the listbox and leaves Enter nothing to pick (AC14, AC36)', () => {
    state.files = { status: 'no-project' };
    const html = render({ seed: '@' });
    expect(text(outer(html, one(html, PALETTE_TESTIDS.empty)))).toBe(PALETTE_COPY.empty.filesNoProject);
    expect(outer(html, one(html, PALETTE_TESTIDS.listbox))).not.toContain(PALETTE_TESTIDS.empty);
    expect(options(html)).toEqual([]);
    const input = one(html, PALETTE_TESTIDS.input);
    expect(input.attrs['aria-expanded']).toBe('false');
    expect(input.attrs['aria-activedescendant']).toBeUndefined();
  });

  it('renders the file-mode states (AC36)', () => {
    state.files = { status: 'loading' };
    expect(text(outer(render({ seed: '@' }), one(render({ seed: '@' }), PALETTE_TESTIDS.empty)))).toBe(PALETTE_COPY.empty.filesLoading);
    state.files = { status: 'error' };
    const html = render({ seed: '@' });
    expect(text(outer(html, one(html, PALETTE_TESTIDS.empty)))).toBe(PALETTE_COPY.empty.filesError);
  });
});

describe('CommandPalette — project rows (AC7)', () => {
  it('shows the name and the root folder, with the full path in the root label\'s tooltip', () => {
    const html = render();
    const row = outer(html, options(html)[0] as El);
    expect(text(row)).toContain('alpha');
    const label = one(row, PALETTE_TESTIDS.projectRoot);
    expect(text(outer(row, label))).toBe('/work');
    expect(label.attrs.title).toBe('/work/alpha');
  });

  it('marks the current project with muted "Current" text and "current" in its name, when not highlighted', () => {
    const html = render({ current: project(2, 'beta') });
    const row = outer(html, options(html)[1] as El);
    const marker = one(row, PALETTE_TESTIDS.current);
    expect(text(outer(row, marker))).toBe(PALETTE_COPY.current);
    expect(marker.classes).toContain('text-[--modal-text-muted]');
    expect(text(row).toLowerCase()).toContain(PALETTE_COPY.currentLabel);
    expect(row).not.toContain('<kbd');
  });

  it('replaces "Current" with the ↩ hint on the highlighted current row, keeping "current" in its name', () => {
    const html = render({ current: project(1, 'alpha') });
    const row = outer(html, options(html)[0] as El);
    expect(byTestId(row, PALETTE_TESTIDS.current)).toEqual([]);
    expect(row).toContain('<kbd>↩</kbd>');
    expect(text(row).toLowerCase()).toContain(PALETTE_COPY.currentLabel);
  });

  it('does not mark other projects as current', () => {
    const html = render({ current: project(2, 'beta') });
    expect(text(outer(html, options(html)[0] as El)).toLowerCase()).not.toContain(PALETTE_COPY.currentLabel);
  });

  it('shows the status dot for a live project, ringed on the highlighted row iff RING_NEEDED', () => {
    const html = render();
    const live = outer(html, options(html)[0] as El);
    const dot = elements(live).find((e) => e.attrs['data-claude-state'] === 'busy');
    expect(dot).toBeDefined();
    expect(dot?.classes.includes('status-dot-ring')).toBe(RING_NEEDED);
  });

  it('never rings the dot on a row that is not highlighted', () => {
    state.projects = [project(2, 'beta'), project(1, 'alpha')];
    state.alive = new Set([1, 2]);
    const html = render();
    const live = outer(html, options(html)[1] as El);
    const dot = elements(live).find((e) => e.attrs['data-claude-state'] === 'busy');
    expect(dot).toBeDefined();
    expect(dot?.classes).not.toContain('status-dot-ring');
  });

  it('shows a hollow ring, no status dot and no state text for a project without a live shell', () => {
    const html = render();
    const idle = outer(html, options(html)[1] as El);
    expect(elements(idle).some((e) => 'data-claude-state' in e.attrs)).toBe(false);
    expect(elements(idle).some((e) => e.attrs['data-lead'] === 'hollow')).toBe(true);
    expect(byTestId(idle, PALETTE_TESTIDS.projectStatus)).toEqual([]);
  });

  it('shows generic running-project severity text and the Open ↩ hint on the highlighted row', () => {
    const html = render();
    const row = outer(html, options(html)[0] as El);
    expect(text(outer(row, one(row, PALETTE_TESTIDS.projectStatus)))).toBe(PALETTE_COPY.projectStatus.busy);
    expect(text(row)).toContain(PALETTE_COPY.openHint);
    expect(text(outer(html, options(html)[1] as El))).not.toContain(PALETTE_COPY.openHint);
  });
  it('names live project severity without attributing it to Claude or OMP', () => {
    const html = render();
    const live = outer(html, options(html)[0] as El);
    const dot = elements(live).find((e) => e.attrs['data-testid'] === 'claude-dot');
    expect(dot?.attrs['aria-label']).toBe('Working');
    expect(dot?.attrs.title).toBe('Working');
    expect(live).not.toMatch(/Claude is working|OMP is working/);
  });

  it('keeps a live idle project generic even when an agent shell is recognized', () => {
    state.agentState = 'idle';
    const html = render();
    const live = outer(html, options(html)[0] as El);
    const dot = elements(live).find((e) => e.attrs['data-testid'] === 'claude-dot');
    expect(dot?.attrs['aria-label']).toBe('Idle');
    expect(dot?.attrs.title).toBe('Idle');
    expect(dot?.attrs['data-claude-state']).toBe('idle');
    expect(text(outer(live, one(live, PALETTE_TESTIDS.projectStatus)))).toBe(PALETTE_COPY.projectStatus.idle);
    expect(live).not.toMatch(/Claude is idle|OMP is idle/);
  });


  it('puts running projects under a Running heading with its count', () => {
    state.alive = new Set([1, 2]);
    const html = render();
    expect(text(html)).toContain(`${PALETTE_COPY.groupTitles.running}2`);
  });

  it('escapes a project name instead of rendering it as markup (§5)', () => {
    state.projects = [project(9, '<img src=x onerror=alert(1)>')];
    const html = render();
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('CommandPalette — highlighted row (design finding 1)', () => {
  it('uses the modal row tokens on the highlighted row only, never --accent-soft-text', () => {
    const html = render();
    const [active, rest] = [options(html)[0] as El, options(html).slice(1)];
    expect(active.classes).toEqual(expect.arrayContaining(['bg-[--modal-row-active]', 'text-[--modal-row-active-text]']));
    expect(rest.every((o) => !o.classes.includes('bg-[--modal-row-active]'))).toBe(true);
    expect(html).not.toContain('--accent-soft-text');
  });
});

describe('CommandPalette — command rows, footer and capped marker', () => {
  it('shows a command shortcut as a kbd hint (AC9)', () => {
    const html = render({ seed: '>' });
    const row = outer(html, options(html).find((o) => text(outer(html, o)).includes('Toggle sidebar')) as El);
    expect(row).toContain('<kbd>⌘B</kbd>');
  });

  it('gives every command row a decorative category icon', () => {
    const html = render({ seed: '>' });
    for (const o of options(html)) {
      const svg = elements(outer(html, o)).find((e) => e.tag === 'svg');
      expect(svg?.attrs['aria-hidden']).toBe('true');
    }
  });

  it('shows the prefix legend with exactly three kbd entries in every mode (AC40)', () => {
    for (const seed of ['', '>', '@'] as const) {
      const html = render({ seed });
      const legend = outer(html, one(html, PALETTE_TESTIDS.legend));
      const kbds = [...legend.matchAll(/<kbd[^>]*>([^<]*)<\/kbd>/g)].map((m) => decode(m[1] ?? ''));
      expect(kbds).toEqual(['@', '#', '>']);
      expect(text(legend).replace(/\s+/g, '')).toBe('@Files#Projects>Commands');
    }
  });

  it('keeps the navigate / open / close key hints', () => {
    const html = render();
    for (const word of Object.values(PALETTE_COPY.keyHints)) expect(text(html)).toContain(word);
    expect(html).toContain('<kbd>↑↓</kbd>');
    expect(html).toContain('<kbd>esc</kbd>');
  });

  it('shows the capped marker only for a capped file index (AC34)', () => {
    state.files = { status: 'ready', files: [{ relPath: 'a.ts', name: 'a.ts' }], truncated: true };
    const html = render({ seed: '@' });
    expect(text(outer(html, one(html, PALETTE_TESTIDS.capped)))).toBe(PALETTE_COPY.cappedTitle);
    state.files = { status: 'ready', files: [{ relPath: 'a.ts', name: 'a.ts' }], truncated: false };
    expect(byTestId(render({ seed: '@' }), PALETTE_TESTIDS.capped)).toEqual([]);
  });

  it('shows file name and relative path in a file row', () => {
    state.files = { status: 'ready', files: [{ relPath: 'src/a.ts', name: 'a.ts' }], truncated: false };
    const html = render({ seed: '@' });
    const row = text(outer(html, options(html)[0] as El));
    expect(row).toContain('a.ts');
    expect(row).toContain('src/a.ts');
  });
});

describe('emptyText (AC14, AC36, AC38, AC41, AC42)', () => {
  it('maps every empty state to its copy', () => {
    const e = PALETTE_COPY.empty;
    expect(emptyText({ kind: 'no-results', query: 'q' })).toBe(e.noResults('q'));
    expect(emptyText({ kind: 'no-projects-match', query: 'q' })).toBe(e.noProjectsMatch('q'));
    expect(emptyText({ kind: 'no-projects' })).toBe(e.noProjects);
    expect(emptyText({ kind: 'no-commands-match', query: 'q' })).toBe(e.noCommandsMatch('q'));
    expect(emptyText({ kind: 'no-files-match', query: 'q' })).toBe(e.noFilesMatch('q'));
    expect(emptyText({ kind: 'files-no-project' })).toBe(e.filesNoProject);
    expect(emptyText({ kind: 'files-loading' })).toBe(e.filesLoading);
    expect(emptyText({ kind: 'files-error' })).toBe(e.filesError);
  });
});
