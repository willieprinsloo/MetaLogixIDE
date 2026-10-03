import { describe, expect, it, vi } from 'vitest';
import { MERMAID_EMPTY_MESSAGE, type EffectiveTheme } from '@renderer/markdown/contract';
import {
  createMermaidRenderer,
  type MermaidApi,
  type MermaidDeps,
} from '@renderer/markdown/mermaid/mermaidRenderer';
import { mermaidThemeVariables } from '@renderer/markdown/mermaid/mermaidPalette';
import type { ThemeTokens } from '@renderer/markdown/mermaid/paletteContract';
import { stylesheetTokens } from './support/styleTokens';

interface FakeElement {
  name: string;
  parent: FakeElement | null;
  children: FakeElement[];
  style: Record<string, string>;
  ownerDocument: { createElement(tag: string): FakeElement };
  append(child: FakeElement): void;
  remove(): void;
  innerHTML: string;
}

function fakeElement(name: string): FakeElement {
  const el: FakeElement = {
    name,
    parent: null,
    children: [],
    style: {},
    ownerDocument: { createElement: (tag) => fakeElement(tag) },
    append(child) {
      child.parent = el;
      el.children.push(child);
    },
    remove() {
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
    set innerHTML(_: string) {
      for (const child of el.children) child.parent = null;
      el.children = [];
    },
    get innerHTML() {
      return '';
    },
  };
  return el;
}

const asElement = (el: FakeElement): Element => el as unknown as Element;
const container = asElement(fakeElement('container'));

function fakeMermaid(overrides: Partial<MermaidApi> = {}) {
  const api = {
    initialize: vi.fn<MermaidApi['initialize']>(),
    parse: vi.fn<MermaidApi['parse']>(async () => ({ config: {} })),
    render: vi.fn<MermaidApi['render']>(async (id: string) => ({ svg: `<svg id="${id}"></svg>` })),
    ...overrides,
  };
  return api;
}

const DARK_TOKENS = stylesheetTokens('dark');
const LIGHT_TOKENS = stylesheetTokens('light');

function fakePalette(tokens: ThemeTokens, theme: EffectiveTheme): Record<string, unknown> {
  return { darkMode: theme === 'dark', textColor: tokens.text, primaryColor: tokens.panelStrong };
}

function setup(api: MermaidApi = fakeMermaid(), deps: Partial<MermaidDeps> = {}) {
  const load = vi.fn(async () => api);
  const removeNode = vi.fn<(id: string) => void>();
  const tokens = { current: DARK_TOKENS };
  const readTokens = vi.fn(() => tokens.current);
  const derive = vi.fn(fakePalette);
  const renderer = createMermaidRenderer({ load, removeNode, readTokens, derive, ...deps });
  return { api, load, removeNode, readTokens, derive, tokens, renderer };
}

const lastInitialize = (api: MermaidApi) => vi.mocked(api.initialize).mock.calls.at(-1)?.[0];
const FOREST = '%%{init: {"theme":"forest"}}%%\ngraph TD; A-->B\n';

function directiveAwareMermaid() {
  return fakeMermaid({
    parse: vi.fn(async (text: string) => ({
      config: text.includes('"forest"') ? { theme: 'forest' } : {},
    })),
  });
}

describe('createMermaidRenderer', () => {
  it('initializes mermaid strictly, with error rendering suppressed and no secure override', async () => {
    const { api, renderer } = setup(directiveAwareMermaid());
    await renderer.render('graph TD; A-->B', 'dark', container);
    await renderer.render(FOREST, 'dark', container);
    expect(api.initialize).toHaveBeenCalledTimes(2);
    for (const [config] of vi.mocked(api.initialize).mock.calls) {
      expect(config).toMatchObject({
        securityLevel: 'strict',
        suppressErrorRendering: true,
        startOnLoad: false,
      });
      expect(config).not.toHaveProperty('secure');
    }
  });

  it.each([
    ['dark', true],
    ['light', false],
  ] as const)(
    'renders a plain diagram in app theme %s with the base theme and the app palette',
    async (appTheme, darkMode) => {
      const { api, derive, renderer } = setup();
      await renderer.render('graph TD; A-->B', appTheme, container);
      expect(derive).toHaveBeenLastCalledWith(DARK_TOKENS, appTheme);
      expect(lastInitialize(api)).toMatchObject({
        theme: 'base',
        themeVariables: { darkMode, textColor: DARK_TOKENS.text },
      });
    },
  );

  it.each([
    ['dark', DARK_TOKENS],
    ['light', LIGHT_TOKENS],
  ] as const)('hands mermaid the real palette for %s by default', async (theme, tokens) => {
    const api = fakeMermaid();
    const renderer = createMermaidRenderer({
      load: async () => api,
      removeNode: vi.fn(),
      readTokens: () => tokens,
    });
    await renderer.render('graph TD; A-->B', theme, container);
    expect(lastInitialize(api)).toMatchObject({
      theme: 'base',
      themeVariables: mermaidThemeVariables(tokens, theme),
    });
  });

  it.each(['dark', 'light'] as const)(
    'initializes a directive-themed diagram in %s with no theme and no app palette (AC8)',
    async (appTheme) => {
      const { api, renderer } = setup(directiveAwareMermaid());
      await renderer.render('graph TD; A-->B', appTheme, container);
      await renderer.render(FOREST, appTheme, container);
      const config = lastInitialize(api);
      expect(config).not.toHaveProperty('theme');
      expect(config).not.toHaveProperty('themeVariables');
    },
  );

  it.each([
    ['a non-string theme', { theme: 42 }],
    ['an empty theme', { theme: '' }],
    ['no config keys', {}],
    ['themeVariables without a theme', { themeVariables: { primaryColor: '#ff00ff' } }],
    ['an inherited theme', Object.create({ theme: 'forest' }) as Record<string, unknown>],
    ['a miscased theme name', { theme: 'Dark' }],
    ['an unknown theme name', { theme: 'fancy' }],
  ])('keeps the app palette when the directive config has %s', async (_, config) => {
    const api = fakeMermaid({ parse: vi.fn(async () => ({ config })) });
    const { renderer } = setup(api);
    expect((await renderer.render('graph TD; A-->B', 'dark', container)).ok).toBe(true);
    expect(lastInitialize(api)).toMatchObject({
      theme: 'base',
      themeVariables: { darkMode: true },
    });
  });

  it.each([
    'default',
    'base',
    'dark',
    'forest',
    'neutral',
    'neo',
    'neo-dark',
    'redux',
    'redux-dark',
    'redux-color',
    'redux-dark-color',
    'null',
  ])('treats a directive theme %j as the diagram’s own theme (D2)', async (theme) => {
    const api = fakeMermaid({ parse: vi.fn(async () => ({ config: { theme } })) });
    const { renderer } = setup(api);
    await renderer.render('graph TD; A-->B', 'dark', container);
    expect(lastInitialize(api)).not.toHaveProperty('theme');
    expect(lastInitialize(api)).not.toHaveProperty('themeVariables');
  });

  it('keeps the palette for an author colour Mermaid cannot parse, so the diagram still renders (C1)', async () => {
    const api = fakeMermaid({
      parse: vi.fn(async () => ({ config: { themeVariables: { lineColor: 'none' } } })),
    });
    const { renderer } = setup(api, { derive: mermaidThemeVariables });
    expect((await renderer.render('graph TD; A-->B', 'dark', container)).ok).toBe(true);
    const palette = mermaidThemeVariables(DARK_TOKENS, 'dark');
    const config = lastInitialize(api) as { themeVariables: Record<string, unknown> };
    expect(config.themeVariables.lineColor).toBe(palette.lineColor);
    expect(config.themeVariables.defaultLinkColor).toBe(palette.defaultLinkColor);
  });

  it('lets directive themeVariables without a theme re-derive the palette colours they feed (AC9)', async () => {
    const api = fakeMermaid({
      parse: vi.fn(async () => ({ config: { themeVariables: { primaryColor: '#ff00ff' } } })),
    });
    const { renderer } = setup(api, { derive: mermaidThemeVariables });
    await renderer.render('graph TD; A-->B', 'dark', container);
    const config = lastInitialize(api) as {
      theme: string;
      themeVariables: Record<string, unknown>;
    };
    expect(config.theme).toBe('base');
    expect(config.themeVariables.primaryColor).toBe('#ff00ff');
    expect(config.themeVariables).not.toHaveProperty('mainBkg');
    expect(config.themeVariables.textColor).toBe(DARK_TOKENS.text);
  });

  it.each([
    ['no config', {}],
    ['a false parse result', false],
  ] as const)('keeps the app palette when parse returns %s', async (_, result) => {
    const api = fakeMermaid({ parse: vi.fn(async () => result) });
    const { renderer } = setup(api);
    expect((await renderer.render('graph TD; A-->B', 'dark', container)).ok).toBe(true);
    expect(lastInitialize(api)).toMatchObject({ theme: 'base' });
  });

  it('parses before initializing, so the directive decides the config', async () => {
    const { api, renderer } = setup(directiveAwareMermaid());
    await renderer.render(FOREST, 'dark', container);
    const [parseOrder] = vi.mocked(api.parse).mock.invocationCallOrder;
    const [initOrder] = vi.mocked(api.initialize).mock.invocationCallOrder;
    const [renderOrder] = vi.mocked(api.render).mock.invocationCallOrder;
    expect(parseOrder).toBeLessThan(initOrder ?? 0);
    expect(initOrder).toBeLessThan(renderOrder ?? 0);
  });

  it('derives the palette once for repeated renders with unchanged tokens, and again when they change', async () => {
    const { derive, tokens, renderer } = setup();
    for (let i = 0; i < 5; i++) await renderer.render(`graph TD; N${i}`, 'dark', container);
    expect(derive).toHaveBeenCalledTimes(1);
    tokens.current = { ...DARK_TOKENS, text: '#ffffff' };
    await renderer.render('graph TD; N9', 'dark', container);
    expect(derive).toHaveBeenCalledTimes(2);
    expect(derive).toHaveBeenLastCalledWith(tokens.current, 'dark');
  });

  it('keeps a palette per theme, so toggling back and forth does not re-derive', async () => {
    const { derive, renderer } = setup();
    for (const theme of ['dark', 'light', 'dark', 'light'] as const)
      await renderer.render(`graph TD; ${theme}`, theme, container);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a plain', 'graph TD; A-->B'],
    ['a directive-themed', FOREST],
  ])(
    'shows %s diagram as an error naming the token when a token is unparseable, without caching it (AC13)',
    async (_, source) => {
      const api = directiveAwareMermaid();
      let tokens: ThemeTokens = { ...DARK_TOKENS, accent: 'garbage' };
      const renderer = createMermaidRenderer({
        load: async () => api,
        removeNode: vi.fn(),
        readTokens: () => tokens,
      });
      const failed = await renderer.render(source, 'dark', container);
      expect(failed.ok).toBe(false);
      expect(failed.ok === false && failed.message).toContain('--accent');
      expect(api.initialize).not.toHaveBeenCalled();
      expect(api.render).not.toHaveBeenCalled();
      tokens = DARK_TOKENS;
      expect((await renderer.render(source, 'dark', container)).ok).toBe(true);
    },
  );

  it('returns the svg, rendering with a unique mmd id', async () => {
    const { api, renderer } = setup();
    const a = await renderer.render('graph TD; A-->B', 'dark', container);
    const b = await renderer.render('graph TD; C-->D', 'dark', container);
    const c = await renderer.render('graph TD; E-->F', 'light', container);
    const calls = vi.mocked(api.render).mock.calls;
    const ids = calls.map(([id]) => id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^mmd[A-Za-z0-9_-]*$/);
    for (const call of calls) expect(call[2]).not.toBe(container);
    expect(a).toEqual({ ok: true, svg: `<svg id="${ids[0]}"></svg>` });
    expect(b).toEqual({ ok: true, svg: `<svg id="${ids[1]}"></svg>` });
    expect(c).toEqual({ ok: true, svg: `<svg id="${ids[2]}"></svg>` });
  });

  it('never hands mermaid the block itself, so the block keeps its source and earlier output', async () => {
    const block = fakeElement('block');
    const source = fakeElement('pre.mermaid-source');
    const output = fakeElement('div.mermaid-output');
    block.append(source);
    block.append(output);
    const api = fakeMermaid({
      render: vi.fn(async (id: string, _text: string, target?: Element) => {
        if (target) target.innerHTML = '';
        return { svg: `<svg id="${id}"></svg>` };
      }),
    });
    const { renderer } = setup(api);
    await renderer.render('graph TD; A-->B', 'dark', asElement(block));
    await renderer.render('graph TD; A-->B', 'light', asElement(block));
    for (const [, , target] of vi.mocked(api.render).mock.calls) {
      expect(target).toBeDefined();
      expect(target).not.toBe(asElement(block));
      expect((target as unknown as FakeElement).parent).toBeNull();
    }
    expect(block.children).toEqual([source, output]);
  });

  it('renders inside a scratch child of the block and removes it even on failure', async () => {
    const block = fakeElement('block');
    const parents: Array<FakeElement | null> = [];
    const api = fakeMermaid({
      render: vi.fn(async (_id: string, _text: string, target?: Element) => {
        parents.push((target as unknown as FakeElement).parent);
        throw new Error('layout failed');
      }),
    });
    const { renderer } = setup(api);
    expect((await renderer.render('graph TD; A-->B', 'dark', asElement(block))).ok).toBe(false);
    expect(parents).toEqual([block]);
    expect(block.children).toEqual([]);
  });

  it('keeps the scratch child out of layout but measurable while mermaid lays out', async () => {
    const block = fakeElement('block');
    const styles: Array<Record<string, string>> = [];
    const api = fakeMermaid({
      render: vi.fn(async (id: string, _text: string, target?: Element) => {
        styles.push({ ...(target as unknown as FakeElement).style });
        return { svg: `<svg id="${id}"></svg>` };
      }),
    });
    const { renderer } = setup(api);
    await renderer.render('graph TD; A-->B', 'dark', asElement(block));
    expect(styles).toHaveLength(1);
    expect(styles[0]).toMatchObject({ position: 'absolute', visibility: 'hidden' });
    expect(styles[0]?.display ?? '').not.toBe('none');
  });

  it('maps a parse failure to an error value carrying the parser message and removes stray nodes', async () => {
    const api = fakeMermaid({
      parse: vi.fn(async () => {
        throw new Error('Parse error on line 2: unexpected token');
      }),
    });
    const { removeNode, renderer } = setup(api);
    const result = await renderer.render('graph TD; A--', 'dark', container);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      'Parse error on line 2: unexpected token',
    );
    expect(api.render).not.toHaveBeenCalled();
    const removed = removeNode.mock.calls.map(([id]) => id);
    const id = removed.find((r) => r.startsWith('mmd'));
    expect(id).toBeDefined();
    expect(removed).toEqual(expect.arrayContaining([id, `d${id}`]));
  });

  it('maps a render failure (including non-Error throws) to an error value and removes its nodes', async () => {
    const api = fakeMermaid({
      render: vi.fn(async () => {
        throw 'boom in layout';
      }),
    });
    const { removeNode, renderer } = setup(api);
    const result = await renderer.render('graph TD; A-->B', 'light', container);
    expect(result).toEqual({ ok: false, message: expect.stringContaining('boom in layout') });
    const id = vi.mocked(api.render).mock.calls[0]?.[0];
    expect(removeNode.mock.calls.map(([r]) => r)).toEqual(expect.arrayContaining([id, `d${id}`]));
  });

  it('reads the message off a thrown non-Error object', async () => {
    const api = fakeMermaid({
      parse: vi.fn(async () => {
        throw { message: 'Lexical error on line 1', hash: {} };
      }),
    });
    const { renderer } = setup(api);
    await expect(renderer.render('graph TD; A-', 'dark', container)).resolves.toEqual({
      ok: false,
      message: 'Lexical error on line 1',
    });
  });

  it('maps a failed library load to an error value instead of throwing', async () => {
    const load = vi.fn(async (): Promise<MermaidApi> => {
      throw new Error('chunk failed');
    });
    const renderer = createMermaidRenderer({
      load,
      removeNode: vi.fn(),
      readTokens: () => DARK_TOKENS,
    });
    await expect(renderer.render('graph TD; A-->B', 'dark', container)).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('chunk failed'),
    });
  });

  it('retries the library load on the next render after a failed load', async () => {
    const api = fakeMermaid();
    const load = vi
      .fn<() => Promise<MermaidApi>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue(api);
    const renderer = createMermaidRenderer({
      load,
      removeNode: vi.fn(),
      readTokens: () => DARK_TOKENS,
    });
    expect((await renderer.render('graph TD; A-->B', 'dark', container)).ok).toBe(false);
    expect((await renderer.render('graph TD; A-->B', 'dark', container)).ok).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('bounds the cache, evicting the oldest entry', async () => {
    const { api, renderer } = setup();
    for (let i = 0; i <= 50; i++) await renderer.render(`graph TD; N${i}`, 'dark', container);
    expect(api.render).toHaveBeenCalledTimes(51);
    await renderer.render('graph TD; N50', 'dark', container);
    expect(api.render).toHaveBeenCalledTimes(51);
    await renderer.render('graph TD; N1', 'dark', container);
    expect(api.render).toHaveBeenCalledTimes(51);
    await renderer.render('graph TD; N0', 'dark', container);
    expect(api.render).toHaveBeenCalledTimes(52);
  });

  it.each(['', '   ', '\n\t  \n'])(
    'rejects empty source %j without loading mermaid',
    async (source) => {
      const { load, renderer } = setup();
      await expect(renderer.render(source, 'dark', container)).resolves.toEqual({
        ok: false,
        message: MERMAID_EMPTY_MESSAGE,
      });
      expect(load).not.toHaveBeenCalled();
    },
  );

  it('does not load mermaid until the first render, then loads it once', async () => {
    const { load, renderer } = setup();
    expect(load).not.toHaveBeenCalled();
    await Promise.all([
      renderer.render('graph TD; A-->B', 'dark', container),
      renderer.render('graph TD; B-->C', 'dark', container),
    ]);
    await renderer.render('graph TD; C-->D', 'light', container);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('runs concurrent renders one at a time, in call order', async () => {
    const events: string[] = [];
    const gates: Array<() => void> = [];
    const api = fakeMermaid({
      render: vi.fn(async (id: string, text: string) => {
        events.push(`start ${text}`);
        await new Promise<void>((resolve) => gates.push(resolve));
        events.push(`end ${text}`);
        return { svg: `<svg id="${id}"></svg>` };
      }),
    });
    const { renderer } = setup(api);
    const all = Promise.all(
      ['one', 'two', 'three'].map((s) => renderer.render(s, 'dark', container)),
    );
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(gates.length).toBe(i + 1));
      await new Promise((r) => setTimeout(r, 5));
      expect(gates.length).toBe(i + 1);
      gates[i]?.();
    }
    await all;
    expect(events).toEqual([
      'start one',
      'end one',
      'start two',
      'end two',
      'start three',
      'end three',
    ]);
  });

  it('keeps serving the queue after a failed render', async () => {
    let fail = true;
    const api = fakeMermaid({
      parse: vi.fn(async () => {
        if (fail) {
          fail = false;
          throw new Error('bad');
        }
        return { config: {} };
      }),
    });
    const { renderer } = setup(api);
    const [first, second] = await Promise.all([
      renderer.render('bad', 'dark', container),
      renderer.render('good', 'dark', container),
    ]);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
  });

  it('serves a repeat (source, theme, tokens) from cache and misses on a theme or token change', async () => {
    const { api, tokens, renderer } = setup();
    const first = await renderer.render('graph TD; A-->B', 'dark', container);
    const again = await renderer.render('graph TD; A-->B', 'dark', container);
    expect(again).toEqual(first);
    expect(api.render).toHaveBeenCalledTimes(1);
    await renderer.render('graph TD; A-->B', 'light', container);
    expect(api.render).toHaveBeenCalledTimes(2);
    expect(lastInitialize(api)).toMatchObject({
      theme: 'base',
      themeVariables: { darkMode: false },
    });
    tokens.current = { ...DARK_TOKENS, accent: '#ff00ff' };
    await renderer.render('graph TD; A-->B', 'light', container);
    expect(api.render).toHaveBeenCalledTimes(3);
    tokens.current = DARK_TOKENS;
    await renderer.render('graph TD; A-->B', 'dark', container);
    expect(api.render).toHaveBeenCalledTimes(3);
  });

  it('does not cache failures', async () => {
    let fail = true;
    const api = fakeMermaid({
      parse: vi.fn(async () => {
        if (fail) {
          fail = false;
          throw new Error('transient');
        }
        return { config: {} };
      }),
    });
    const { renderer } = setup(api);
    expect((await renderer.render('graph TD; A-->B', 'dark', container)).ok).toBe(false);
    expect((await renderer.render('graph TD; A-->B', 'dark', container)).ok).toBe(true);
  });

  it('passes init directives through byte-for-byte and never locks theme via secure', async () => {
    const { api, renderer } = setup(directiveAwareMermaid());
    const source = FOREST;
    await renderer.render(source, 'dark', container);
    await renderer.render(source, 'light', container);
    for (const [text] of vi.mocked(api.parse).mock.calls) expect(text).toBe(source);
    for (const [, text] of vi.mocked(api.render).mock.calls) expect(text).toBe(source);
    for (const [config] of vi.mocked(api.initialize).mock.calls)
      expect(config).not.toHaveProperty('secure');
  });
});
