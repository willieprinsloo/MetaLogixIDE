import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { SegmentedRadioGroup } from '@renderer/components/settings/SegmentedRadioGroup';

type Options = readonly ['a', 'b', 'c'];
const OPTIONS: Options = ['a', 'b', 'c'];
const LABELS = { a: 'Alpha', b: 'Beta', c: 'Gamma' };

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const children = (node.props as { children?: ReactNode }).children;
  return [node, ...elements(children)];
}

describe('SegmentedRadioGroup markup', () => {
  it('exposes role="radiogroup" named by label, with one radio per option', () => {
    const html = renderToStaticMarkup(
      <SegmentedRadioGroup label="Chrome frost" options={OPTIONS} labels={LABELS} value="b" onChange={() => undefined} />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Chrome frost"');
    expect((html.match(/role="radio"/g) ?? []).length).toBe(3);
    expect(html).toContain('>Alpha<');
    expect(html).toContain('>Beta<');
    expect(html).toContain('>Gamma<');
  });

  it('marks only the selected option aria-checked and tabbable', () => {
    const html = renderToStaticMarkup(
      <SegmentedRadioGroup label="Chrome frost" options={OPTIONS} labels={LABELS} value="b" onChange={() => undefined} />,
    );
    const radios = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    expect(radios[1]).toContain('aria-checked="true"');
    expect(radios[1]).toContain('tabindex="0"');
    expect(radios[0]).toContain('aria-checked="false"');
    expect(radios[0]).toContain('tabindex="-1"');
    expect(radios[2]).toContain('aria-checked="false"');
    expect(radios[2]).toContain('tabindex="-1"');
  });

  it('clicking an option calls onChange with its value', () => {
    const onChange = vi.fn();
    const radios = elements(
      SegmentedRadioGroup({ label: 'Chrome frost', options: OPTIONS, labels: LABELS, value: 'a', onChange }),
    ).filter((e) => e.props && (e.props as { role?: string }).role === 'radio');
    (radios[2]!.props as { onClick: () => void }).onClick();
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('ArrowRight on the checked radio moves selection to the next option with wrap-around', () => {
    const onChange = vi.fn();
    const radios = elements(
      SegmentedRadioGroup({ label: 'Chrome frost', options: OPTIONS, labels: LABELS, value: 'c', onChange }),
    ).filter((e) => e.props && (e.props as { role?: string }).role === 'radio');
    const preventDefault = vi.fn();
    (radios[2]!.props as { onKeyDown: (e: unknown) => void }).onKeyDown({
      key: 'ArrowRight',
      preventDefault,
      currentTarget: { focus: vi.fn() },
    });
    expect(onChange).toHaveBeenCalledWith('a');
    expect(preventDefault).toHaveBeenCalled();
  });

  it('a non-arrow key does not call onChange', () => {
    const onChange = vi.fn();
    const radios = elements(
      SegmentedRadioGroup({ label: 'Chrome frost', options: OPTIONS, labels: LABELS, value: 'a', onChange }),
    ).filter((e) => e.props && (e.props as { role?: string }).role === 'radio');
    (radios[0]!.props as { onKeyDown: (e: unknown) => void }).onKeyDown({ key: 'Enter', preventDefault: vi.fn() });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disabled renders every radio aria-disabled and not focusable, and ignores clicks', () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      <SegmentedRadioGroup
        label="Chrome frost"
        options={OPTIONS}
        labels={LABELS}
        value="b"
        disabled
        onChange={onChange}
      />,
    );
    expect((html.match(/aria-disabled="true"/g) ?? []).length).toBe(3);
    expect((html.match(/tabindex="-1"/g) ?? []).length).toBe(3);

    const radios = elements(
      SegmentedRadioGroup({ label: 'Chrome frost', options: OPTIONS, labels: LABELS, value: 'b', disabled: true, onChange }),
    ).filter((e) => e.props && (e.props as { role?: string }).role === 'radio');
    (radios[0]!.props as { onClick: () => void }).onClick();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('applies the testId to the radiogroup container', () => {
    const html = renderToStaticMarkup(
      <SegmentedRadioGroup
        label="Chrome frost"
        options={OPTIONS}
        labels={LABELS}
        value="a"
        testId="chrome-frost-group"
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="chrome-frost-group"');
  });

  it('points the radiogroup aria-describedby at describedBy, so a reason is announced with it', () => {
    const html = renderToStaticMarkup(
      <SegmentedRadioGroup label="Chrome frost" options={OPTIONS} labels={LABELS} value="a" describedBy="why" onChange={() => undefined} />,
    );
    expect(/<div[^>]*role="radiogroup"[^>]*>/.exec(html)?.[0]).toContain('aria-describedby="why"');
  });

  it('carries no aria-describedby without describedBy', () => {
    const html = renderToStaticMarkup(
      <SegmentedRadioGroup label="Chrome frost" options={OPTIONS} labels={LABELS} value="a" onChange={() => undefined} />,
    );
    expect(html).not.toContain('aria-describedby');
  });

  it('disabled ignores arrow keys', () => {
    const onChange = vi.fn();
    const radios = elements(
      SegmentedRadioGroup({ label: 'Chrome frost', options: OPTIONS, labels: LABELS, value: 'a', disabled: true, onChange }),
    ).filter((e) => e.props && (e.props as { role?: string }).role === 'radio');
    (radios[0]!.props as { onKeyDown: (e: unknown) => void }).onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn() });
    expect(onChange).not.toHaveBeenCalled();
  });
});
