/**
 * Adapter over the mermaid library behind the `DiagramRenderer` seam. Mermaid
 * is reached only through the lazy `import('mermaid')` below so it lands in
 * its own chunk, loaded on the first diagram. Renders are serialised because
 * `initialize` is global, results are cached by (theme, tokens, source), and
 * every failure comes back as a value. Diagrams get Mermaid's `base` theme
 * with the app palette derived from the live theme tokens, unless their own
 * directive or frontmatter picks a theme, in which case they get no palette.
 */
import {
  MERMAID_EMPTY_MESSAGE,
  type DiagramRenderer,
  type DiagramResult,
  type EffectiveTheme,
} from '../contract';
import type { MermaidConfig } from 'mermaid';
import { mermaidThemeVariables, withAuthorVariables } from './mermaidPalette';
import { THEME_TOKEN_NAMES, type ThemeTokens } from './paletteContract';
import { readThemeTokens } from './themeTokens';

/** What `mermaid.parse` reports: the source's own frontmatter and directive config. */
export type MermaidParseResult = { config?: { theme?: unknown; themeVariables?: unknown } } | false;

/** The narrow slice of the mermaid API this adapter uses. */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  parse(text: string): Promise<MermaidParseResult>;
  render(id: string, text: string, container?: Element): Promise<{ svg: string }>;
}

export interface MermaidDeps {
  load(): Promise<MermaidApi>;
  removeNode(id: string): void;
  readTokens(): ThemeTokens;
  derive(tokens: ThemeTokens, theme: EffectiveTheme): Record<string, unknown>;
}

const CACHE_LIMIT = 50;
const PALETTE_LIMIT = 4;

const SCRATCH_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  top: '0',
  left: '0',
  width: '100%',
  height: '0',
  overflow: 'hidden',
  visibility: 'hidden',
};

const defaultDeps: MermaidDeps = {
  load: async () => (await import('mermaid')).default,
  removeNode: (id) => document.getElementById(id)?.remove(),
  readTokens: () => readThemeTokens(),
  derive: mermaidThemeVariables,
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String(err.message);
  return String(err);
}

/**
 * Every theme name Mermaid accepts, pinned to its own config type: a Mermaid
 * upgrade that adds or drops a theme fails the build here.
 */
const MERMAID_THEMES = {
  default: true,
  base: true,
  dark: true,
  forest: true,
  neutral: true,
  neo: true,
  'neo-dark': true,
  redux: true,
  'redux-dark': true,
  'redux-color': true,
  'redux-dark-color': true,
  null: true,
} as const satisfies Record<NonNullable<MermaidConfig['theme']>, true>;

/** Whether the source's own directive or frontmatter picks one of Mermaid's themes. */
function hasOwnTheme(parsed: MermaidParseResult): boolean {
  const config = parsed ? parsed.config : undefined;
  const theme = config && Object.hasOwn(config, 'theme') ? config.theme : undefined;
  return typeof theme === 'string' && Object.hasOwn(MERMAID_THEMES, theme);
}

/** The `initialize` config: the app palette on `base`, or no theme at all when `palette` is null. */
function mermaidConfig(palette: Record<string, unknown> | null): Record<string, unknown> {
  const base = { startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true };
  return palette ? { ...base, theme: 'base', themeVariables: palette } : base;
}

/**
 * The `initialize` config for a parsed source: none of ours when it picks a
 * Mermaid theme, otherwise the palette with its own `themeVariables` folded in.
 */
function configFor(
  parsed: MermaidParseResult,
  palette: Record<string, unknown>,
): Record<string, unknown> {
  if (hasOwnTheme(parsed)) return mermaidConfig(null);
  const author = parsed ? parsed.config?.themeVariables : undefined;
  return mermaidConfig(withAuthorVariables(palette, author));
}

function tokenKey(tokens: ThemeTokens): string {
  return Object.keys(THEME_TOKEN_NAMES)
    .map((field) => tokens[field as keyof ThemeTokens])
    .join('\n');
}

/** Stores a result, evicting the oldest entry once the cache exceeds its bound. */
function remember<T>(cache: Map<string, T>, key: string, value: T, limit = CACHE_LIMIT): void {
  cache.set(key, value);
  const oldest = cache.keys().next();
  if (cache.size > limit && !oldest.done) cache.delete(oldest.value);
}

interface AppPalette {
  key: string;
  variables: Record<string, unknown>;
}

/**
 * Reads the live tokens and returns the palette for `theme`, with a key naming
 * the theme and token values. Derivations are memoised per key, keeping the
 * most recent `PALETTE_LIMIT`. Throws whatever `derive` throws.
 */
function createPaletteSource(
  readTokens: MermaidDeps['readTokens'],
  derive: MermaidDeps['derive'],
): (theme: EffectiveTheme) => AppPalette {
  const palettes = new Map<string, Record<string, unknown>>();
  return (theme) => {
    const tokens = readTokens();
    const key = `${theme}\n${tokenKey(tokens)}`;
    let variables = palettes.get(key);
    if (!variables) {
      variables = derive(tokens, theme);
      remember(palettes, key, variables, PALETTE_LIMIT);
    }
    return { key, variables };
  };
}

/** Loads mermaid once and shares the promise; a failed load is forgotten so the next call retries. */
function createLoader(load: MermaidDeps['load']): () => Promise<MermaidApi> {
  let loaded: Promise<MermaidApi> | null = null;
  return () => {
    loaded ??= load().catch((err: unknown) => {
      loaded = null;
      throw err;
    });
    return loaded;
  };
}

/**
 * Runs `mermaid.render` inside a throwaway child of `container`, removed
 * afterwards. Mermaid clears the element it is given (`innerHTML = ""`), so it
 * must never receive the block holding the diagram source or earlier output.
 * The scratch is hidden and out of flow but not `display:none`, since mermaid
 * measures text with `getBBox` while laying out.
 */
async function renderInScratch(
  mermaid: MermaidApi,
  id: string,
  source: string,
  container: Element,
): Promise<{ svg: string }> {
  const scratch = container.ownerDocument.createElement('div');
  Object.assign(scratch.style, SCRATCH_STYLE);
  container.append(scratch);
  try {
    return await mermaid.render(id, source, scratch);
  } finally {
    scratch.remove();
  }
}

/**
 * Builds a diagram renderer over mermaid. `deps.load` supplies the library
 * (called once, on the first non-empty render), `deps.removeNode` drops the
 * temporary nodes mermaid leaves behind on failure, `deps.readTokens` reads
 * the live theme tokens on every render and `deps.derive` turns them into the
 * palette (memoised per theme and token set); all are injectable for tests.
 * An unusable token fails every diagram, directive-themed ones included.
 */
export function createMermaidRenderer(deps: Partial<MermaidDeps> = {}): DiagramRenderer {
  const { load, removeNode, readTokens, derive }: MermaidDeps = { ...defaultDeps, ...deps };
  const cache = new Map<string, DiagramResult>();
  const palette = createPaletteSource(readTokens, derive);
  const library = createLoader(load);
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 0;

  async function renderNow(
    source: string,
    theme: EffectiveTheme,
    container: Element,
  ): Promise<DiagramResult> {
    let app: AppPalette;
    try {
      app = palette(theme);
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
    const key = `${app.key}\n${source}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const id = `mmd${nextId++}`;
    try {
      const mermaid = await library();
      mermaid.initialize(configFor(await mermaid.parse(source), app.variables));
      const { svg } = await renderInScratch(mermaid, id, source, container);
      const result: DiagramResult = { ok: true, svg };
      remember(cache, key, result);
      return result;
    } catch (err) {
      removeNode(`d${id}`);
      removeNode(id);
      return { ok: false, message: errorMessage(err) };
    }
  }

  return {
    render(source, theme, container) {
      if (source.trim() === '')
        return Promise.resolve({ ok: false, message: MERMAID_EMPTY_MESSAGE });
      const result = queue.then(() => renderNow(source, theme, container));
      queue = result;
      return result;
    },
  };
}

/** The app-wide mermaid renderer; one queue and cache for every preview. */
export const mermaidRenderer: DiagramRenderer = createMermaidRenderer();
