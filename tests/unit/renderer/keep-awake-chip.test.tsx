import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRef } from 'react';
import { KEEP_AWAKE_COPY, KEEP_AWAKE_TESTIDS } from '@shared/keep-awake-contract';

vi.mock('@renderer/api', () => ({ api: {} }));
const { KeepAwakeChip, KeepAwakeChipView } = await import('@renderer/components/KeepAwakeChip');

const NOW = new Date(2026, 9, 19, 10, 0, 0).getTime();
const ENDS = NOW + (102 * 60_000);
const noop = () => undefined;

const view = (open: boolean) =>
  renderToStaticMarkup(
    <KeepAwakeChipView endsAt={ENDS} now={NOW} open={open} onToggle={noop} onStop={noop} onDarkenNow={noop} anchorRef={createRef()} chipRef={createRef()} />,
  );
const tag = (html: string, testId: string): string => new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? '';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('KeepAwakeChip', () => {
  it('renders nothing while inactive (AC10)', () => {
    expect(renderToStaticMarkup(<KeepAwakeChip state={{ active: false }} onStop={noop} onDarkenNow={noop} />)).toBe('');
  });

  it('renders the remaining time while active', () => {
    const html = renderToStaticMarkup(<KeepAwakeChip state={{ active: true, endsAt: ENDS }} onStop={noop} onDarkenNow={noop} />);
    expect(html).toContain('data-testid="keep-awake-chip"');
    expect(html).toContain('>1h 42m<');
  });

  it('starts with the popover closed', () => {
    const html = renderToStaticMarkup(<KeepAwakeChip state={{ active: true, endsAt: ENDS }} onStop={noop} onDarkenNow={noop} />);
    expect(html).not.toContain(KEEP_AWAKE_TESTIDS.popover);
  });
});

describe('KeepAwakeChipView', () => {
  it('names the button with the remaining time and puts the exact end time in the tooltip', () => {
    const chip = tag(view(false), KEEP_AWAKE_TESTIDS.chip);
    expect(chip).toContain(`aria-label="${KEEP_AWAKE_COPY.chip.aria('1h 42m')}"`);
    expect(chip).toContain(`title="${KEEP_AWAKE_COPY.chip.tooltip('11:42 today')}"`);
  });

  it('does not announce the countdown through any live region', () => {
    expect(view(true)).not.toMatch(/aria-live|role="(status|alert|timer)"/);
  });

  it('reflects the popover state on the chip', () => {
    expect(tag(view(false), KEEP_AWAKE_TESTIDS.chip)).toContain('aria-expanded="false"');
    expect(tag(view(true), KEEP_AWAKE_TESTIDS.chip)).toContain('aria-expanded="true"');
  });

  it('shows no popover while closed', () => {
    expect(view(false)).not.toContain(KEEP_AWAKE_TESTIDS.popover);
  });

  it('lists Stop, Turn screen off now and the lid hint when open', () => {
    const html = view(true);
    expect(html).toContain(KEEP_AWAKE_TESTIDS.popover);
    expect(html).toMatch(new RegExp(`<button[^>]*data-testid="${KEEP_AWAKE_TESTIDS.stop}"[^>]*>${KEEP_AWAKE_COPY.popover.stop}</button>`));
    expect(html).toMatch(new RegExp(`<button[^>]*data-testid="${KEEP_AWAKE_TESTIDS.darkenNow}"[^>]*>${KEEP_AWAKE_COPY.popover.darkenNow}</button>`));
    expect(html).toContain(KEEP_AWAKE_COPY.popover.lidHint);
  });

  it('uses plain buttons so keyboard users can reach every action', () => {
    expect(tag(view(true), KEEP_AWAKE_TESTIDS.stop)).toContain('type="button"');
    expect(tag(view(true), KEEP_AWAKE_TESTIDS.chip)).toContain('type="button"');
  });
});
