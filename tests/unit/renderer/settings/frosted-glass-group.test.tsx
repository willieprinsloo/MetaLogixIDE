import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FrostedGlassGroup } from '@renderer/components/settings/FrostedGlassGroup';
import { FROSTED_GLASS_COPY, FROSTED_GLASS_TESTIDS } from '@renderer/frosted-chrome-contract';
import { CHROME_FROST_LEVELS, TERMINAL_FROST_LEVELS, VIBRANCY_MATERIALS } from '@shared/frosted-glass';
import type { FrostedGlassSettingsApi } from '@renderer/hooks/useFrostedGlassSettings';

const setFrostChrome = vi.fn().mockResolvedValue(undefined);
const setChromeFrostLevel = vi.fn().mockResolvedValue(undefined);
const setTerminalFrostLevel = vi.fn().mockResolvedValue(undefined);
const setVibrancyMaterial = vi.fn().mockResolvedValue(undefined);
let reduceTransparency = false;

function fakeApi(overrides: Partial<FrostedGlassSettingsApi['values']> = {}): FrostedGlassSettingsApi {
  return {
    values: {
      frostChrome: true,
      chromeFrostLevel: 'subtle',
      terminalFrostLevel: 'off',
      vibrancyMaterial: 'sidebar',
      ...overrides,
    },
    setFrostChrome,
    setChromeFrostLevel,
    setTerminalFrostLevel,
    setVibrancyMaterial,
  };
}

let hookValues: FrostedGlassSettingsApi = fakeApi();

vi.mock('@renderer/hooks/useFrostedGlassSettings', () => ({
  useFrostedGlassSettings: () => hookValues,
}));
vi.mock('@renderer/hooks/usePrefersReducedTransparency', () => ({
  usePrefersReducedTransparency: () => reduceTransparency,
}));

type Props = Record<string, unknown> & { children?: ReactNode };

/** Every element in the tree, rendering hook-free function components (the row components) in place. */
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  const inner = typeof node.type === 'function' ? (node.type as (p: Props) => ReactNode)(node.props) : node.props.children;
  return [node, ...elements(inner)];
}

function attr(html: string, tag: string, name: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? '';
  return new RegExp(`\\s${name}="([^"]*)"`).exec(open)?.[1];
}

beforeEach(() => {
  setFrostChrome.mockClear();
  setChromeFrostLevel.mockClear();
  setTerminalFrostLevel.mockClear();
  setVibrancyMaterial.mockClear();
  reduceTransparency = false;
  hookValues = fakeApi();
});

describe('FrostedGlassGroup — placement and semantics (AC26)', () => {
  it('is a role="group" named by a "Frosted glass" heading, with the testid', () => {
    const html = renderToStaticMarkup(<FrostedGlassGroup />);
    expect(attr(html, 'div', 'role')).toBe('group');
    expect(attr(html, 'div', 'data-testid')).toBe(FROSTED_GLASS_TESTIDS.group);
    const labelledby = attr(html, 'div', 'aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(new RegExp(`id="${labelledby}"[^>]*>${FROSTED_GLASS_COPY.group}<`).test(html)).toBe(true);
  });

  it('renders the controls in order: Frosted chrome switch, Chrome frost, Terminal frost, Material', () => {
    const html = renderToStaticMarkup(<FrostedGlassGroup />);
    const chromeIdx = html.indexOf(`data-testid="${FROSTED_GLASS_TESTIDS.frostChrome}"`);
    const chromeFrostIdx = html.indexOf(`data-testid="${FROSTED_GLASS_TESTIDS.chromeFrost}"`);
    const terminalFrostIdx = html.indexOf(`data-testid="${FROSTED_GLASS_TESTIDS.terminalFrost}"`);
    const materialIdx = html.indexOf(`data-testid="${FROSTED_GLASS_TESTIDS.material}"`);
    expect(chromeIdx).toBeGreaterThan(-1);
    expect(chromeFrostIdx).toBeGreaterThan(chromeIdx);
    expect(terminalFrostIdx).toBeGreaterThan(chromeFrostIdx);
    expect(materialIdx).toBeGreaterThan(terminalFrostIdx);
  });

  it('renders the material select with every VIBRANCY_MATERIALS option, labelled', () => {
    const html = renderToStaticMarkup(<FrostedGlassGroup />);
    for (const material of VIBRANCY_MATERIALS) {
      expect(html).toContain(`value="${material}"`);
      expect(html).toContain(`>${FROSTED_GLASS_COPY.materials[material]}<`);
    }
  });

  it('renders the chrome and terminal frost radiogroups with their option sets', () => {
    const html = renderToStaticMarkup(<FrostedGlassGroup />);
    expect((html.match(/role="radiogroup"/g) ?? []).length).toBe(2);
    const radioCount = (html.match(/role="radio"/g) ?? []).length;
    expect(radioCount).toBe(CHROME_FROST_LEVELS.length + TERMINAL_FROST_LEVELS.length);
  });
});

describe('FrostedGlassGroup — disabled levels (AC9)', () => {
  it('disables both level radiogroups and shows the reason when Frosted chrome is OFF', () => {
    hookValues = fakeApi({ frostChrome: false, chromeFrostLevel: 'medium', terminalFrostLevel: 'strong' });
    const html = renderToStaticMarkup(<FrostedGlassGroup />);
    expect((html.match(/aria-disabled="true"/g) ?? []).length).toBe(CHROME_FROST_LEVELS.length + TERMINAL_FROST_LEVELS.length);
    expect((html.match(new RegExp(FROSTED_GLASS_COPY.disabledReason, 'g')) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('>medium<'.replace('medium', FROSTED_GLASS_COPY.levels.medium));
    expect(html).toContain(FROSTED_GLASS_COPY.levels.strong);
  });

  it('links each "Needs Frosted chrome" reason to its own radiogroup with aria-describedby (gate L8)', () => {
    hookValues = fakeApi({ frostChrome: false });
    const html = renderToStaticMarkup(<FrostedGlassGroup />);
    const ids = [...html.matchAll(/<div[^>]*role="radiogroup"[^>]*>/g)].map((m) => /aria-describedby="([^"]+)"/.exec(m[0])?.[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toMatch(new RegExp(`id="${id}"[^>]*>${FROSTED_GLASS_COPY.disabledReason}<`));
  });

  it('keeps both level radiogroups enabled when Frosted chrome is ON', () => {
    hookValues = fakeApi({ frostChrome: true });
    const html = renderToStaticMarkup(<FrostedGlassGroup />);
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).not.toContain(FROSTED_GLASS_COPY.disabledReason);
  });
});

describe('FrostedGlassGroup — reduce transparency (AC24)', () => {
  it('shows the reduce-transparency line when the media query is on', () => {
    reduceTransparency = true;
    const html = renderToStaticMarkup(<FrostedGlassGroup />);
    expect(html).toContain(`data-testid="${FROSTED_GLASS_TESTIDS.reduceTransparency}"`);
    expect(html).toContain(FROSTED_GLASS_COPY.reduceTransparency);
  });

  it('omits the line when the media query is off', () => {
    reduceTransparency = false;
    const html = renderToStaticMarkup(<FrostedGlassGroup />);
    expect(html).not.toContain(FROSTED_GLASS_TESTIDS.reduceTransparency);
  });
});

describe('FrostedGlassGroup — keyboard reach (AC27)', () => {
  it('the switch and the material select are not removed from the tab order', () => {
    const html = renderToStaticMarkup(<FrostedGlassGroup />);
    expect(attr(html, 'input', 'tabindex')).toBeUndefined();
    expect(attr(html, 'select', 'tabindex')).toBeUndefined();
  });
});

describe('FrostedGlassGroup — wiring to useFrostedGlassSettings', () => {
  it('forwards the switch change to setFrostChrome', () => {
    const switchEl = elements(FrostedGlassGroup()).find((e) => e.props.testId === FROSTED_GLASS_TESTIDS.frostChrome);
    (switchEl?.props.onChange as (next: boolean) => void)(false);
    expect(setFrostChrome).toHaveBeenCalledWith(false);
  });

  it('forwards the chrome frost radiogroup change to setChromeFrostLevel', () => {
    const group = elements(FrostedGlassGroup()).find((e) => e.props.testId === FROSTED_GLASS_TESTIDS.chromeFrost);
    (group?.props.onChange as (next: string) => void)('strong');
    expect(setChromeFrostLevel).toHaveBeenCalledWith('strong');
  });

  it('forwards the terminal frost radiogroup change to setTerminalFrostLevel', () => {
    const group = elements(FrostedGlassGroup()).find((e) => e.props.testId === FROSTED_GLASS_TESTIDS.terminalFrost);
    (group?.props.onChange as (next: string) => void)('medium');
    expect(setTerminalFrostLevel).toHaveBeenCalledWith('medium');
  });

  it('forwards the material select change to setVibrancyMaterial', () => {
    const select = elements(FrostedGlassGroup()).find((e) => e.props['data-testid'] === FROSTED_GLASS_TESTIDS.material);
    (select?.props.onChange as (e: unknown) => void)({ target: { value: 'popover' } });
    expect(setVibrancyMaterial).toHaveBeenCalledWith('popover');
  });
});
