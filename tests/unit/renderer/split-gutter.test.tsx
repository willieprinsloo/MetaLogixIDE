import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SplitGutter, gutterKeyStep } from '@renderer/components/SplitGutter';

const noop = () => undefined;

function render(ratio = 0.5, dragging = false): string {
  return renderToStaticMarkup(
    <SplitGutter ratio={ratio} dragging={dragging} onDragStart={noop} onRatioChange={noop} />,
  );
}

const tags = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const separator = (html: string) => tags(html, 'div').find((t) => attr(t, 'role') === 'separator') ?? '';
const pill = (html: string) => tags(html, 'span')[0] ?? '';

describe('SplitGutter', () => {
  it('is a vertical separator named "Resize panes" with a 15–85 range', () => {
    const sep = separator(render());
    expect(attr(sep, 'aria-orientation')).toBe('vertical');
    expect(attr(sep, 'aria-label')).toBe('Resize panes');
    expect(attr(sep, 'aria-valuemin')).toBe('15');
    expect(attr(sep, 'aria-valuemax')).toBe('85');
  });

  it('reports the ratio as a rounded percentage', () => {
    expect(attr(separator(render(0.5)), 'aria-valuenow')).toBe('50');
    expect(attr(separator(render(0.33)), 'aria-valuenow')).toBe('33');
    expect(attr(separator(render(0.505)), 'aria-valuenow')).toBe('51');
  });

  it('is in the Tab order', () => {
    expect(attr(separator(render()), 'tabindex')).toBe('0');
  });

  it('carries no data-testid, so split-right stays the first one inside the fold', () => {
    expect(render()).not.toContain('data-testid');
    expect(render(0.5, true)).not.toContain('data-testid');
  });

  it('is a 10px col-resize hit area around a 3x36 grab pill in --split-grip', () => {
    const sep = attr(separator(render()), 'class') ?? '';
    expect(sep.split(' ')).toEqual(expect.arrayContaining(['w-[10px]', 'cursor-col-resize']));
    const p = attr(pill(render()), 'class') ?? '';
    expect(p.split(' ')).toEqual(expect.arrayContaining(['w-[3px]', 'h-9', 'rounded-[2px]', 'bg-[--split-grip]']));
    expect(attr(pill(render()), 'aria-hidden')).toBe('true');
  });

  it('paints the pill in the accent glyph colour while dragging and on hover: --accent-mark, which is --accent wherever it is unset', () => {
    const fill = (classes: string[], variant: string) =>
      classes.map((c) => new RegExp(`^${variant}bg-\\[color:(.+)\\]$`).exec(c)?.[1]).find(Boolean);
    const unset = (expr: string | undefined) => /^var\(--accent-mark,(var\(--[\w-]+\))\)$/.exec(expr ?? '')?.[1];
    const dragging = (attr(pill(render(0.5, true)), 'class') ?? '').split(' ');
    expect(unset(fill(dragging, ''))).toBe('var(--accent)');
    expect(dragging).not.toContain('bg-[--split-grip]');
    const idle = (attr(pill(render()), 'class') ?? '').split(' ');
    expect(unset(fill(idle, 'group-hover:'))).toBe('var(--accent)');
  });
});

describe('gutterKeyStep', () => {
  it('maps ArrowLeft to -1 and ArrowRight to 1', () => {
    expect(gutterKeyStep('ArrowLeft')).toBe(-1);
    expect(gutterKeyStep('ArrowRight')).toBe(1);
  });

  it.each(['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Home', 'a'])('ignores %p', (key) => {
    expect(gutterKeyStep(key)).toBeNull();
  });
});
