/** Contract tests for the terminal weight Settings rows: the font weight and bold weight native selects — labels, hints, accessible names, test ids, offered choices, current value, disabled state, and selection saving through the shared store (AC1, AC2, AC12). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isValidElement, type JSX, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FONT_COPY, FONT_TEST_IDS } from '@renderer/fonts/font-contract';
import { TerminalBoldWeightControl, TerminalFontWeightControl } from '@renderer/components/settings/TerminalFontWeightControl';
import type { TerminalFontWeight } from '@shared/terminal-font-weight';

vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useId: () => 'weight-id' }));

interface HookState {
  weight: TerminalFontWeight;
  boldWeight: TerminalFontWeight;
  ready: boolean;
  setWeight: (w: TerminalFontWeight) => void;
  setBoldWeight: (w: TerminalFontWeight) => void;
}

const hookState: HookState = {
  weight: 400,
  boldWeight: 700,
  ready: true,
  setWeight: vi.fn(),
  setBoldWeight: vi.fn(),
};

function resetHook(): void {
  hookState.weight = 400;
  hookState.boldWeight = 700;
  hookState.ready = true;
  hookState.setWeight = vi.fn();
  hookState.setBoldWeight = vi.fn();
}

type Control = () => JSX.Element;

vi.mock('@renderer/fonts/terminal-font-weight-context', () => ({
  useTerminalFontWeight: () => hookState,
}));

const EXPECTED_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['100', 'Thin (100)'],
  ['200', 'Extra Light (200)'],
  ['300', 'Light (300)'],
  ['400', 'Regular (400)'],
  ['500', 'Medium (500)'],
  ['600', 'Semibold (600)'],
  ['700', 'Bold (700)'],
  ['800', 'Extra Bold (800)'],
  ['900', 'Black (900)'],
];

function render(Component: Control = TerminalFontWeightControl): string {
  return renderToStaticMarkup(<Component />);
}

function selectTag(html: string): string {
  return /<select\b[^>]*>/.exec(html)?.[0] ?? '';
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

function options(html: string): Array<[string, string, boolean]> {
  return [...html.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((m) => [
    attr(m[1] ?? '', 'value') ?? '',
    m[2] ?? '',
    /\sselected=""/.test(m[1] ?? ''),
  ]);
}

interface SelectProps {
  readonly onChange?: (e: { target: { value: string } }) => void;
  readonly children?: ReactNode;
}

function findSelectOnChange(node: ReactNode): ((e: { target: { value: string } }) => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSelectOnChange(child as ReactNode);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<SelectProps>(node)) return undefined;
  if (node.type === 'select') return node.props.onChange;
  if (typeof node.type === 'function') return findSelectOnChange((node.type as (props: SelectProps) => ReactNode)(node.props));
  return findSelectOnChange(node.props.children);
}

function choose(value: string, Component: Control = TerminalFontWeightControl): void {
  const onChange = findSelectOnChange(Component());
  expect(onChange).toBeTypeOf('function');
  onChange?.({ target: { value } });
}

describe('TerminalFontWeightControl markup', () => {
  beforeEach(resetHook);

  it('shows the terminal-weight label and the exact hint (AC1)', () => {
    const html = render();
    expect(html).toContain(`>${FONT_COPY.terminalWeightLabel}<`);
    expect(html).toContain(`>${FONT_COPY.terminalWeightHint}<`);
    expect(FONT_COPY.terminalWeightHint).toBe(
      'Changing this also sets bold to 200 heavier, up to 900. Fonts without this weight use the nearest one.',
    );
  });

  it('renders a native select named exactly "Terminal font weight" through its label (AC12)', () => {
    const html = render();
    const id = attr(selectTag(html), 'id');
    expect(id).toBeTruthy();
    expect(new RegExp(`<label[^>]*for="${id}"[^>]*>Terminal font weight<`).test(html)).toBe(true);
  });

  it('carries the E2E test id on the select', () => {
    expect(attr(selectTag(render()), 'data-testid')).toBe(FONT_TEST_IDS.terminalWeightSelect);
  });

  it('offers exactly the nine weights in order, each labelled with its CSS name and number (AC1)', () => {
    expect(options(render()).map(([value, label]) => [value, label])).toEqual(EXPECTED_OPTIONS);
  });

  it.each([[400], [100], [900]] as const)('shows the current weight %i as the only selected option (AC3)', (weight) => {
    hookState.weight = weight;
    const selected = options(render()).filter(([, , isSelected]) => isSelected).map(([value]) => value);
    expect(selected).toEqual([String(weight)]);
  });
});

describe('TerminalFontWeightControl selection', () => {
  beforeEach(resetHook);

  it.each([['100', 100], ['700', 700], ['900', 900]] as const)('saves %s immediately as the number %i (AC2)', (raw, weight) => {
    choose(raw);
    expect(hookState.setWeight).toHaveBeenCalledTimes(1);
    expect(hookState.setWeight).toHaveBeenCalledWith(weight);
  });

  it.each([['450'], ['abc'], [''], ['1000']])('ignores an unparseable or out-of-set value %j', (raw) => {
    choose(raw);
    expect(hookState.setWeight).not.toHaveBeenCalled();
  });

  it('never touches the bold weight', () => {
    choose('700');
    expect(hookState.setBoldWeight).not.toHaveBeenCalled();
  });
});

const BOLD_LABELS: Readonly<Record<number, string>> = {
  500: 'Medium (500)',
  600: 'Semibold (600)',
  700: 'Bold (700)',
  800: 'Extra Bold (800)',
  900: 'Black (900)',
};

describe('TerminalBoldWeightControl markup', () => {
  beforeEach(resetHook);

  it('shows the bold label and the exact bold hint (AC1)', () => {
    const html = render(TerminalBoldWeightControl);
    expect(html).toContain(`>${FONT_COPY.terminalBoldLabel}<`);
    expect(html).toContain(`>${FONT_COPY.terminalBoldHint}<`);
    expect(FONT_COPY.terminalBoldHint).toBe('Bold text is drawn at this weight. It must be heavier than the font weight.');
  });

  it('renders a native select named exactly "Terminal bold weight" through its label (AC12)', () => {
    const html = render(TerminalBoldWeightControl);
    const id = attr(selectTag(html), 'id');
    expect(id).toBeTruthy();
    expect(new RegExp(`<label[^>]*for="${id}"[^>]*>Terminal bold weight<`).test(html)).toBe(true);
  });

  it('carries the bold E2E test id on the select', () => {
    expect(attr(selectTag(render(TerminalBoldWeightControl)), 'data-testid')).toBe(FONT_TEST_IDS.terminalBoldSelect);
  });

  it.each([
    [400, 700, [500, 600, 700, 800, 900]],
    [600, 800, [700, 800, 900]],
    [800, 900, [900]],
  ] as const)('at font weight %i offers only heavier weights, in order, with the shared labels (AC1)', (weight, bold, choices) => {
    hookState.weight = weight;
    hookState.boldWeight = bold;
    expect(options(render(TerminalBoldWeightControl)).map(([value, label]) => [value, label])).toEqual(
      choices.map((w) => [String(w), BOLD_LABELS[w]]),
    );
  });

  it.each([[400, 700], [400, 900], [600, 800]] as const)('at font weight %i shows bold %i as the only selected option', (weight, bold) => {
    hookState.weight = weight;
    hookState.boldWeight = bold;
    const selected = options(render(TerminalBoldWeightControl)).filter(([, , isSelected]) => isSelected).map(([value]) => value);
    expect(selected).toEqual([String(bold)]);
  });

  it('is disabled at font weight 900, showing only Black (900) selected (AC1)', () => {
    hookState.weight = 900;
    hookState.boldWeight = 900;
    const html = render(TerminalBoldWeightControl);
    expect(selectTag(html)).toMatch(/\sdisabled=""/);
    expect(options(html)).toEqual([['900', 'Black (900)', true]]);
  });

  it.each([[800, 900], [400, 700]] as const)('is enabled at font weight %i', (weight, bold) => {
    hookState.weight = weight;
    hookState.boldWeight = bold;
    expect(selectTag(render(TerminalBoldWeightControl))).not.toMatch(/\sdisabled=""/);
  });
});

describe('TerminalBoldWeightControl selection', () => {
  beforeEach(resetHook);

  it.each([['500', 500], ['900', 900]] as const)('saves %s immediately as the bold number %i, never the font weight (AC2)', (raw, bold) => {
    choose(raw, TerminalBoldWeightControl);
    expect(hookState.setBoldWeight).toHaveBeenCalledTimes(1);
    expect(hookState.setBoldWeight).toHaveBeenCalledWith(bold);
    expect(hookState.setWeight).not.toHaveBeenCalled();
  });

  it.each([['450'], ['abc'], [''], ['1000']])('ignores an unparseable or out-of-set value %j', (raw) => {
    choose(raw, TerminalBoldWeightControl);
    expect(hookState.setBoldWeight).not.toHaveBeenCalled();
  });
});
