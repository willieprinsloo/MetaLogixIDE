import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AppearanceSection,
  GeneralPanel,
  loadBoard,
  useBoardSettings,
  type AppearanceSectionProps,
} from '@renderer/components/settings/GeneralPanel';
import { FROSTED_GLASS_TESTIDS } from '@renderer/frosted-chrome-contract';
import { ShortcutPlatformContext } from '@renderer/shortcut-platform';
import type { ShortcutPlatform } from '@renderer/shortcut-contract';

const rt = vi.hoisted(() => {
  const slots: unknown[] = [];
  let cursor = 0;
  let active = false;
  return {
    get active() { return active; },
    reset() { slots.length = 0; },
    render<T>(fn: () => T): T {
      cursor = 0;
      active = true;
      try { return fn(); } finally { active = false; }
    },
    useState<S>(init: S) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = init;
      const set = (v: S | ((p: S) => S)) => { slots[i] = typeof v === 'function' ? (v as (p: S) => S)(slots[i] as S) : v; };
      return [slots[i] as S, set] as const;
    },
  };
});

vi.mock('react', async (orig) => {
  const real = await orig<typeof import('react')>();
  return {
    ...real,
    useState: ((init: unknown) => (rt.active ? rt.useState(init) : real.useState(init))) as typeof real.useState,
    useEffect: ((run: () => void, deps?: unknown[]) => (rt.active ? undefined : real.useEffect(run, deps))) as typeof real.useEffect,
  };
});
vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn() } }));
vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ mode: 'dark', palette: 'default', effective: 'dark', setMode: () => undefined, setPalette: () => undefined, cycle: () => undefined }),
}));
vi.mock('@renderer/fonts/font-settings-context', () => ({
  useFontSettings: () => ({ uiFontFamily: null, terminalFontFamily: null }),
}));
vi.mock('@renderer/components/FontControl', () => ({ FontControl: () => null }));
vi.mock('@renderer/components/settings/TerminalFontSizeControl', () => ({ TerminalFontSizeControl: () => null }));
vi.mock('@renderer/components/settings/TerminalFontWeightControl', () => ({
  TerminalFontWeightControl: () => null,
  TerminalBoldWeightControl: () => null,
}));
vi.mock('@renderer/components/settings/FrostedGlassGroup', () => ({
  FrostedGlassGroup: () => <div data-testid={FROSTED_GLASS_TESTIDS.group} />,
}));

const SECTION_PROPS: AppearanceSectionProps = {
  theme: { mode: 'dark', palette: 'default', effective: 'dark' },
  opacity: 100,
  onMode: () => undefined,
  onPalette: () => undefined,
  onOpacity: () => undefined,
};

describe('AppearanceSection — 6-prop contract and children slot (D21, AC26)', () => {
  it('accepts exactly the 6 documented props plus children', () => {
    const html = renderToStaticMarkup(<AppearanceSection {...SECTION_PROPS} />);
    expect(html).toContain('data-testid="window-opacity-slider"');
  });

  it('renders children directly after the Window opacity row', () => {
    const html = renderToStaticMarkup(
      <AppearanceSection {...SECTION_PROPS}>
        <div data-testid="frosted-glass-group" />
      </AppearanceSection>,
    );
    const opacityIdx = html.indexOf('data-testid="window-opacity-slider"');
    const childIdx = html.indexOf('data-testid="frosted-glass-group"');
    expect(opacityIdx).toBeGreaterThan(-1);
    expect(childIdx).toBeGreaterThan(opacityIdx);
  });

  it('renders nothing extra when no children are given', () => {
    const html = renderToStaticMarkup(<AppearanceSection {...SECTION_PROPS} />);
    expect(html).not.toContain('frost');
  });

  it('is still exactly one SettingsSection (no fifth section introduced)', () => {
    const html = renderToStaticMarkup(
      <AppearanceSection {...SECTION_PROPS}>
        <div data-testid="frosted-glass-group" />
      </AppearanceSection>,
    );
    expect(html.match(/<section/g)).toHaveLength(1);
  });
});

describe('GeneralPanel — FrostedGlassGroup rendered inside Appearance, mac only (D21, AC25, AC26)', () => {
  function panel(platform: ShortcutPlatform): string {
    return renderToStaticMarkup(
      <ShortcutPlatformContext.Provider value={platform}>
        <GeneralPanel fontDiscovery={{ status: 'idle' }} onLoadInstalledFonts={async () => undefined} />
      </ShortcutPlatformContext.Provider>,
    );
  }

  it('renders the group under the mac platform, inside the same section as Window opacity', () => {
    const html = panel('mac');
    expect(html).toContain(`data-testid="${FROSTED_GLASS_TESTIDS.group}"`);
    expect(html.match(/<section/g)).toHaveLength(4);
  });

  it('places the group inside the Appearance <section>, directly after the Window opacity row (AC26)', () => {
    const html = panel('mac');
    const sections = html.match(/<section\b.*?<\/section>/g) ?? [];
    const appearance = sections.find((s) => />Appearance<\/h2>/.test(s)) ?? '';
    const groupTag = `<div data-testid="${FROSTED_GLASS_TESTIDS.group}"`;
    expect(appearance).toContain('data-testid="window-opacity-slider"');
    expect(appearance).toContain(groupTag);
    const afterSlider = appearance.slice(appearance.indexOf('data-testid="window-opacity-slider"'));
    const betweenRowAndGroup = afterSlider.slice(afterSlider.indexOf('%</span>') + '%</span>'.length, afterSlider.indexOf(groupTag));
    expect(betweenRowAndGroup).toMatch(/^(<\/div>)+$/);
  });

  it('omits the group entirely under any other platform', () => {
    const html = panel('other');
    expect(html).toContain('data-testid="window-opacity-slider"');
    expect(html).not.toContain(FROSTED_GLASS_TESTIDS.group);
  });
});

describe('loadBoard — six keys, no frost_terminal (AC34 renderer half)', () => {
  it('reads exactly the six General board keys', async () => {
    const { api } = await import('@renderer/api');
    const seen: string[] = [];
    vi.mocked(api.invoke).mockImplementation(async (_channel: string, req: unknown) => {
      seen.push((req as { key?: string }).key ?? '');
      return { value: null };
    });
    await loadBoard();
    expect(seen).toEqual([
      'keep_alive_cap',
      'scan_depth',
      'max_watched_paths',
      'window_opacity',
      'notify_claude_needs_input',
      'notify_claude_finished',
    ]);
    expect(seen).not.toContain('frost_terminal');
  });
});

describe('useBoardSettings — no frost fields (AC34 renderer half)', () => {
  beforeEach(() => { rt.reset(); });

  it('exposes no frostTerminal field or onFrostTerminal setter', async () => {
    const { api } = await import('@renderer/api');
    vi.mocked(api.invoke).mockResolvedValue({ value: null });
    const board = rt.render(() => useBoardSettings());
    expect('frostTerminal' in board).toBe(false);
    expect('onFrostTerminal' in board).toBe(false);
  });
});

describe('renderer source scan — nothing reads frost_terminal or sets the legacy attribute (AC34 renderer half)', () => {
  const OWNED_FILES = [
    'components/settings/GeneralPanel.tsx',
    'components/settings/FrostedGlassGroup.tsx',
    'root-flags.ts',
    'main.tsx',
    'App.tsx',
    'hooks/useFrostedGlassAttributes.ts',
    'hooks/useFrostedGlassSettings.ts',
  ];
  const LEGACY_TOKENS = [
    'frost_terminal',
    'data-frost-terminal',
    'FROST_COPY',
    'FROST_TESTIDS',
    'FROST_TERMINAL_SETTING_KEY',
    'FROST_TERMINAL_QUERY_KEY',
    'parseFrostTerminalQuery',
    'useFrostTerminalAttribute',
    'setFrostTerminal',
    'FrostTerminalRow',
  ];

  it.each(OWNED_FILES)('%s never mentions a legacy frost-terminal identifier', async (relPath) => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL(`../../../../src/renderer/${relPath}`, import.meta.url), 'utf8');
    for (const token of LEGACY_TOKENS) expect(src).not.toContain(token);
  });
});
