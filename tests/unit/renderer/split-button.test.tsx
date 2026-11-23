/**
 * SplitButton contract: icon-only "Split" toggle, aria-pressed, constant accessible name,
 * state-dependent tooltip, stable test id on the button itself. Tooltip is mocked to expose its label.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SplitButton } from '@renderer/components/SplitButton';
import { SPLIT_COPY, SPLIT_TESTIDS } from '@renderer/split-copy';

vi.mock('@renderer/components/Tooltip', () => ({
  Tooltip: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <span data-tooltip={label}>{children}</span>
  ),
}));

const render = (on: boolean) => renderToStaticMarkup(<SplitButton on={on} onToggle={() => {}} />);
const button = (html: string) => /<button\b[^>]*>([\s\S]*?)<\/button>/.exec(html);
const text = (inner: string) => inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();

describe('SplitButton', () => {
  it.each([false, true])('is an icon-only "Split" button with the toggle test id (on=%s)', (on) => {
    const m = button(render(on));
    expect(m).not.toBeNull();
    expect(m![0]).toContain(`data-testid="${SPLIT_TESTIDS.toggle}"`);
    expect(m?.[0]).toContain(`aria-label="${SPLIT_COPY.buttonLabel}"`);
    expect(m?.[1]).toContain('<svg');
    expect(text(m?.[1] ?? '')).toBe('');
  });

  it.each([false, true])('reflects state in aria-pressed (on=%s)', (on) => {
    expect(button(render(on))![0]).toContain(`aria-pressed="${on}"`);
  });

  it('tooltip tells what a click does', () => {
    expect(render(false)).toContain(`data-tooltip="${SPLIT_COPY.tooltipOff}"`);
    expect(render(true)).toContain(`data-tooltip="${SPLIT_COPY.tooltipOn}"`);
  });

  it('is a non-submit button with an accent fill only when on', () => {
    expect(button(render(false))![0]).toContain('type="button"');
    expect(button(render(true))![0]).toMatch(/class="[^"]*bg-\[--accent-soft\]/);
    expect(button(render(false))![0]).not.toMatch(/class="[^"]*bg-\[--accent-soft\]/);
  });
});

describe('SplitButton icon', () => {
  it('matches the toolbar icon size', () => {
    const svg = /<svg\b[^>]*>/.exec(render(false))![0];
    expect(svg).toContain('width="14"');
    expect(svg).toContain('height="14"');
  });

  it('uses --accent-soft-text for pressed text, never bare --accent (AC3)', () => {
    const on = button(render(true))![0];
    expect(on).toContain('text-[--accent-soft-text]');
    expect(on).not.toContain('var(--accent)');
  });
});
