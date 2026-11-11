/**
 * AC6/AC7 sweep: every shortcut label surface rendered or produced on Linux carries no Mac glyph
 * and shows the `Ctrl+…` form; on mac the same surfaces read exactly today's strings.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShortcutPlatformContext } from '@renderer/shortcut-platform';
import type { ShortcutPlatform } from '@renderer/shortcut-contract';
import { SHORTCUT_COPY } from '@renderer/shortcut-copy';
import { buildAddMenuItems } from '@renderer/sidebar-add-menu';
import { buildPaletteCommands, type PaletteCommandDeps } from '@renderer/palette-commands';

vi.mock('@renderer/api', () => ({
  api: { invoke: vi.fn(async () => ({})), on: vi.fn(() => () => undefined) },
}));
vi.mock('@renderer/fonts/terminal-font-size-context', () => ({
  useTerminalFontSize: () => ({ size: 14, ready: true, setSize: () => undefined }),
}));
vi.mock('@renderer/components/Tooltip', () => ({
  Tooltip: ({
    label,
    shortcut,
    children,
  }: {
    label: string;
    shortcut?: string;
    children: ReactNode;
  }) => (
    <span data-tooltip={label} data-shortcut={shortcut}>
      {children}
    </span>
  ),
}));

const { ShortcutsHelp } = await import('@renderer/components/ShortcutsHelp');
const { PaletteHint } = await import('@renderer/components/StatusBar');
const { ActivityBar } = await import('@renderer/components/ActivityBar');
const { ShellTabsBar, NewShellMenu } = await import('@renderer/components/ShellTabsBar');
const { TerminalFontSizeControl } =
  await import('@renderer/components/settings/TerminalFontSizeControl');

const GLYPHS = /[⌘⇧⌥⌃↩⏎]/;
const noop = (): void => undefined;

function inPlatform(platform: ShortcutPlatform, node: ReactNode): string {
  return renderToStaticMarkup(
    <ShortcutPlatformContext.Provider value={platform}>{node}</ShortcutPlatformContext.Provider>,
  );
}

const paletteDeps: PaletteCommandDeps = {
  hasProject: true,
  hasPrimary: true,
  sidebarOpen: true,
  openPalette: noop,
  openProjectSearch: noop,
  openScrollbackSearch: noop,
  openPrompts: noop,
  showTasks: noop,
  toggleSidebar: noop,
  statusBarVisible: true,
  toggleStatusBar: noop,
  showTab: noop,
  openHelp: noop,
  openNewProject: noop,
  unloadSession: async () => {},
  popOutShell: async () => {},
  findInTerminal: noop,
  openNewTerminal: noop,
  setThemeMode: noop,
  setThemePalette: noop,
  openSettings: noop,
};

/** Each rendered surface, as the markup (or text) it produces for a platform. */
const SURFACES: ReadonlyArray<readonly [string, (p: ShortcutPlatform) => string]> = [
  ['cheat sheet', (p) => inPlatform(p, <ShortcutsHelp open onClose={noop} />)],
  ['status-bar hint', (p) => inPlatform(p, <PaletteHint onOpen={noop} platform={p} />)],
  [
    'ActivityBar',
    (p) =>
      inPlatform(
        p,
        <ActivityBar active="projects" onSelect={noop} onToggleSidebar={noop} sidebarOpen />,
      ),
  ],
  [
    'ShellTabsBar add button tooltip',
    (p) =>
      inPlatform(
        p,
        <ShellTabsBar
          projectId={1}
          shells={[]}
          active={0}
          onSelect={noop}
          onClose={noop}
          defaultCliName={null}
          onDefaultCliChanged={noop}
          onLaunchProfile={noop}
          onLaunchPlainTab={noop}
          onLaunchCustom={noop}
          splitOn={false}
          onToggleSplit={noop}
        />,
      ),
  ],
  [
    'ShellTabsBar new-shell menu',
    (p) =>
      inPlatform(
        p,
        <NewShellMenu
          projectId={1}
          defaultCliName={null}
          onLaunchProfile={noop}
          onLaunchPlainTab={noop}
          onLaunchCustom={noop}
          onDefaultChanged={noop}
          onClose={noop}
        />,
      ),
  ],
  ['terminal font-size hint', (p) => inPlatform(p, <TerminalFontSizeControl />)],
  [
    'sidebar New project hint',
    (p) =>
      buildAddMenuItems({
        rescanning: false,
        onNewProject: noop,
        onAddRoot: noop,
        onRescan: noop,
        platform: p,
      })
        .map((i) => i.hint ?? '')
        .join(' '),
  ],
  [
    'palette command hints',
    (p) =>
      buildPaletteCommands({ ...paletteDeps, platform: p })
        .map((c) => c.hint ?? '')
        .join(' '),
  ],
];

type CopyFn = (p: ShortcutPlatform) => string;
const PLATFORM_COPY = Object.entries(SHORTCUT_COPY).filter(
  (e): e is [string, CopyFn] =>
    typeof e[1] === 'function' && !['chatPlaceholder', 'clipboardErrorTitle'].includes(e[0]),
);

describe('shortcut labels on Linux (AC6)', () => {
  it.each(SURFACES)('%s shows no Mac glyph and a Ctrl+ form', (_name, render) => {
    const out = render('other');
    expect(out).not.toMatch(GLYPHS);
    expect(out).toContain('Ctrl+');
  });

  it.each(PLATFORM_COPY)(
    'copy %s shows no Mac glyph and differs from the mac text',
    (_name, fn) => {
      expect(fn('other')).not.toMatch(GLYPHS);
      expect(fn('other')).not.toBe(fn('mac'));
    },
  );

  it('ChatTab hints carry no Mac glyph either (AC9)', () => {
    expect(SHORTCUT_COPY.chatPlaceholder('x')).not.toMatch(GLYPHS);
    expect(SHORTCUT_COPY.chatEditHint).not.toMatch(GLYPHS);
  });

  it('names the ActivityBar sidebar toggle and the add-shell shortcut in the Ctrl form', () => {
    expect(SURFACES[2]?.[1]('other')).toContain('aria-label="Toggle sidebar (Ctrl+B)"');
    expect(SURFACES[3]?.[1]('other')).toContain('data-shortcut="Ctrl+T"');
    expect(SURFACES[4]?.[1]('other')).toContain('>Ctrl+T<');
  });
});

describe('shortcut labels on mac (AC7)', () => {
  it('keeps every glyph label exactly as today', () => {
    expect(SURFACES[1]?.[1]('mac')).toContain('<kbd>⌘K</kbd>');
    expect(SURFACES[1]?.[1]('mac')).toContain('aria-label="Open command palette (⌘K)"');
    expect(SURFACES[2]?.[1]('mac')).toContain('aria-label="Toggle sidebar (⌘B)"');
    expect(SURFACES[3]?.[1]('mac')).toContain('data-shortcut="⌘T"');
    expect(SURFACES[4]?.[1]('mac')).toContain('>⌘T<');
    expect(SURFACES[5]?.[1]('mac')).toContain(
      'Every terminal uses this size. ⌘= / ⌘- / ⌘0 also change it.',
    );
    expect(SURFACES[6]?.[1]('mac')).toContain('⌘⇧N');
    expect(SURFACES[7]?.[1]('mac')).not.toContain('Ctrl');
  });

  it('renders no Ctrl+ text anywhere on mac', () => {
    for (const [name, render] of SURFACES) expect(render('mac'), name).not.toContain('Ctrl+');
  });
});
