import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InheritedEnvList } from '@renderer/components/env/InheritedEnvList';
import { EnvValueField } from '@renderer/components/env/EnvValueField';
import type { InheritedEnvRow } from '@renderer/app-env-inherited';
import { ENV_COPY, ENV_TESTIDS } from '@renderer/project-env-copy';

type Props = Record<string, unknown> & { children?: ReactNode };
type ListProps = Parameters<typeof InheritedEnvList>[0];
type FieldProps = Parameters<typeof EnvValueField>[0];

const ROWS: InheritedEnvRow[] = [
  { name: 'API_URL', value: 'https://prod.example', overridden: true },
  { name: 'GITHUB_TOKEN', value: 'ghp_SECRETVALUE', overridden: false },
];

function props(over: Partial<ListProps> = {}): ListProps {
  return {
    rows: ROWS,
    load: 'ready',
    reveal: { isRevealed: () => false, toggle: vi.fn(), hide: vi.fn(), clearAll: vi.fn() },
    onCopy: vi.fn(),
    onOpenAppEnv: vi.fn(),
    ...over,
  };
}

function render(over: Partial<ListProps> = {}): string {
  return renderToStaticMarkup(<InheritedEnvList {...props(over)} />);
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  const { type } = node;
  if (typeof type === 'function' && type !== EnvValueField) {
    return elements((type as (p: Props) => ReactNode)(node.props));
  }
  return [node, ...elements(node.props.children)];
}

function fields(p: ListProps): FieldProps[] {
  return elements(InheritedEnvList(p))
    .filter((el) => el.type === EnvValueField)
    .map((el) => el.props as unknown as FieldProps);
}

function rowsOf(html: string): string[] {
  return html.split(`data-testid="${ENV_TESTIDS.inheritedRow}"`).slice(1);
}

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

describe('InheritedEnvList section (AC17)', () => {
  it('is a section titled "From app settings"', () => {
    const html = render();
    expect(html).toMatch(new RegExp(`^<section[^>]*data-testid="${ENV_TESTIDS.inherited}"`));
    const labelledBy = /^<section[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${labelledBy}"[^>]*>${ENV_COPY.inheritedTitle}<`));
  });

  it('shows the empty line when ready with no rows', () => {
    const html = render({ rows: [] });
    expect(html).toMatch(
      new RegExp(`data-testid="${ENV_TESTIDS.inheritedEmpty}"[^>]*>${ENV_COPY.inheritedEmpty}<`),
    );
    expect(rowsOf(html)).toHaveLength(0);
  });

  it('shows no empty line while loading or after a failed load', () => {
    expect(render({ rows: [], load: 'loading' })).not.toContain(ENV_TESTIDS.inheritedEmpty);
    expect(render({ rows: [], load: 'failed' })).not.toContain(ENV_TESTIDS.inheritedEmpty);
  });

  it('shows no empty line when there are rows', () => {
    expect(render()).not.toContain(ENV_TESTIDS.inheritedEmpty);
  });

  it('offers a button that opens Settings → Environment', () => {
    const p = props();
    const html = render();
    expect(html).toMatch(
      new RegExp(
        `<button[^>]*type="button"[^>]*data-testid="${ENV_TESTIDS.openAppEnv}"[^>]*>${ENV_COPY.openAppEnv}<`,
      ),
    );
    const button = elements(InheritedEnvList(p)).find(
      (el) => el.props['data-testid'] === ENV_TESTIDS.openAppEnv,
    );
    (button?.props.onClick as () => void)();
    expect(p.onOpenAppEnv).toHaveBeenCalledTimes(1);
  });

  it('keeps the open-settings button when empty', () => {
    expect(render({ rows: [] })).toContain(ENV_TESTIDS.openAppEnv);
  });

  it('puts the open-settings button after the rows', () => {
    const html = render();
    expect(html.lastIndexOf(ENV_TESTIDS.inheritedRow)).toBeLessThan(
      html.indexOf(ENV_TESTIDS.openAppEnv),
    );
  });
});

describe('InheritedEnvList rows (AC17-AC19)', () => {
  it('lists every row in order with its name in plain text', () => {
    const rows = rowsOf(render());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(new RegExp(`data-testid="${ENV_TESTIDS.inheritedName}"[^>]*>API_URL<`));
    expect(rows[1]).toMatch(
      new RegExp(`data-testid="${ENV_TESTIDS.inheritedName}"[^>]*>GITHUB_TOKEN<`),
    );
  });

  it('masks every value in a read-only input', () => {
    const inputs = render().match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input).toContain('type="password"');
      expect(input).toContain('readonly=""');
      expect(input).toContain(`data-testid="${ENV_TESTIDS.inheritedValue}"`);
    }
  });

  it('never shows a value outside its input', () => {
    const html = render();
    for (const { value } of ROWS) {
      expect(html).toContain(`value="${value}"`);
      expect(html.replace(`value="${value}"`, '')).not.toContain(value);
    }
  });

  it('marks an overridden row with the exact text, and only that row', () => {
    const [first, second] = rowsOf(render());
    expect(first).toMatch(
      new RegExp(
        `data-testid="${ENV_TESTIDS.inheritedOverridden}"[^>]*>${ENV_COPY.inheritedOverridden}<`,
      ),
    );
    expect(textOf(second ?? '')).not.toContain(ENV_COPY.inheritedOverridden);
  });

  it('uses the app-wide labels, never the editable-row labels', () => {
    const html = render();
    for (const n of [1, 2]) {
      expect(html).toContain(`aria-label="${ENV_COPY.inheritedValueLabel(n)}"`);
      expect(html).toContain(`aria-label="${ENV_COPY.inheritedRevealLabel(n)}"`);
      expect(html).toContain(`aria-label="${ENV_COPY.inheritedCopyLabel(n)}"`);
      expect(html).not.toContain(`aria-label="${ENV_COPY.revealLabel(n)}"`);
      expect(html).not.toContain(`aria-label="${ENV_COPY.copyLabel(n)}"`);
      expect(html).not.toContain(`aria-label="${ENV_COPY.valueLabel(n)}"`);
    }
  });

  it('reveals only the rows the reveal state names, by app:<name>', () => {
    const html = render({
      reveal: {
        isRevealed: (key) => key === 'app:GITHUB_TOKEN',
        toggle: vi.fn(),
        hide: vi.fn(),
        clearAll: vi.fn(),
      },
    });
    const [first, second] = rowsOf(html);
    expect(first).toContain('type="password"');
    expect(second).toContain('type="text"');
    expect(second).toContain(`aria-label="${ENV_COPY.inheritedHideLabel(2)}"`);
  });

  it('toggles app:<name> and copies the raw value', () => {
    const p = props();
    const [, second] = fields(p);
    second?.onToggle();
    expect(p.reveal.toggle).toHaveBeenCalledWith('app:GITHUB_TOKEN');
    second?.onCopy();
    expect(p.onCopy).toHaveBeenCalledWith('ghp_SECRETVALUE');
  });

  it('gives no row an onChange', () => {
    const all = fields(props());
    expect(all).toHaveLength(2);
    expect(all.every((f) => f.onChange === undefined)).toBe(true);
  });
});
