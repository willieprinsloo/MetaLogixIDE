import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MaterialRow } from '@renderer/components/settings/MaterialRow';
import { FROSTED_GLASS_COPY, FROSTED_GLASS_TESTIDS } from '@renderer/frosted-chrome-contract';
import { VIBRANCY_MATERIALS } from '@shared/frosted-glass';

type Props = Record<string, unknown> & { children?: ReactNode };

function select(onChange: (m: string) => void): ReactElement<Props> | undefined {
  const walk = (node: ReactNode): ReactElement<Props>[] =>
    Array.isArray(node) ? node.flatMap(walk) : isValidElement<Props>(node) ? [node, ...walk(node.props.children)] : [];
  return walk(MaterialRow({ value: 'sidebar', onChange })).find((e) => e.type === 'select');
}

describe('MaterialRow (gate M2, L6)', () => {
  it('renders a labelled select with every approved material, the current one selected', () => {
    const html = renderToStaticMarkup(<MaterialRow value="hud" onChange={() => undefined} />);
    const id = /<select[^>]*\sid="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>${FROSTED_GLASS_COPY.material}<`));
    expect(html).toContain(`data-testid="${FROSTED_GLASS_TESTIDS.material}"`);
    expect(html).toContain(FROSTED_GLASS_COPY.materialHint);
    for (const m of VIBRANCY_MATERIALS) expect(html).toContain(`>${FROSTED_GLASS_COPY.materials[m]}<`);
    expect(html).toMatch(/<option value="hud" selected="">/);
  });

  it.each(VIBRANCY_MATERIALS)('forwards the approved material %s', (material) => {
    const onChange = vi.fn();
    (select(onChange)?.props.onChange as (e: unknown) => void)({ target: { value: material } });
    expect(onChange).toHaveBeenCalledWith(material);
  });

  it.each(['window', '', 'Sidebar'])('drops a value outside the allow-list (%j) instead of casting it', (value) => {
    const onChange = vi.fn();
    (select(onChange)?.props.onChange as (e: unknown) => void)({ target: { value } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
