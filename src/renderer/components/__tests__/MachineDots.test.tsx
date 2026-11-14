// @vitest-environment jsdom
/**
 * MachineDots (docs/specs/machine-switcher-dots.md AC2, AC4, AC8, AC11, AC12, AC21, AC25–AC28):
 * the tablist contract, roving focus with manual activation, dot states and the overflow hooks.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MachineDots } from '../MachineDots';
import { LOCAL_MACHINE_ID, type MachineDot } from '@renderer/machine-switcher-contract';
import { MACHINE_TESTIDS } from '@renderer/sidebar-copy';
import { SWITCHER_PANEL_ID, machineTabId } from '@renderer/machine-dots';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 14, 12);

const LOCAL: MachineDot = { deviceId: LOCAL_MACHINE_ID, name: 'Laptop', online: true, lastSeenAt: null, self: true };
const ATLAS: MachineDot = { deviceId: 'atlas', name: 'Atlas', online: false, lastSeenAt: NOW - 3 * HOUR, self: false };
const TOWER: MachineDot = { deviceId: 'tower', name: 'Tower', online: true, lastSeenAt: NOW, self: false };
const ALL = [LOCAL, ATLAS, TOWER];

const scrollIntoView = vi.fn();
let onSelect: ReturnType<typeof vi.fn<(id: string) => void>>;

function renderDots(activeId: string = LOCAL_MACHINE_ID, machines: MachineDot[] = ALL) {
  return render(<MachineDots machines={machines} activeId={activeId} onSelect={onSelect} />);
}

const tab = (id: string) => screen.getByTestId(MACHINE_TESTIDS.dot(id));
const mark = (id: string) => tab(id).querySelector('[data-dot]')!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  onSelect = vi.fn();
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MachineDots tablist', () => {
  test('renders one labelled tablist with a tab per machine, named per AC26', () => {
    renderDots();
    const list = screen.getByRole('tablist', { name: 'Machines' });
    expect(list).toBe(screen.getByTestId(MACHINE_TESTIDS.row));
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual([
      'Laptop, this machine', 'Atlas, offline, last seen 3h ago', 'Tower, online',
    ]);
    expect(screen.getByRole('tab', { name: 'Tower, online' })).toBe(tab('tower'));
  });

  test('marks exactly the active dot selected and gives it the only tab stop', () => {
    renderDots('atlas');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  test('each tab carries its id and controls the sidebar list panel', () => {
    renderDots();
    for (const m of ALL) {
      expect(tab(m.deviceId).id).toBe(machineTabId(m.deviceId));
      expect(tab(m.deviceId).getAttribute('aria-controls')).toBe(SWITCHER_PANEL_ID);
    }
  });

  test('clicking an inactive dot selects it; clicking the active dot does nothing', () => {
    renderDots('atlas');
    fireEvent.click(tab('atlas'));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(tab('tower'));
    expect(onSelect.mock.calls).toEqual([['tower']]);
  });

  test('an offline dot stays enabled and selectable', () => {
    renderDots();
    expect((tab('atlas') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(tab('atlas'));
    expect(onSelect).toHaveBeenCalledWith('atlas');
  });
});

describe('MachineDots keyboard (manual activation)', () => {
  test('Right/Left move focus with wrap and never select', () => {
    renderDots();
    tab(LOCAL_MACHINE_ID).focus();
    fireEvent.keyDown(tab(LOCAL_MACHINE_ID), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('atlas'));
    fireEvent.keyDown(tab('atlas'), { key: 'ArrowRight' });
    fireEvent.keyDown(tab('tower'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab(LOCAL_MACHINE_ID));
    fireEvent.keyDown(tab(LOCAL_MACHINE_ID), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab('tower'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(tab(LOCAL_MACHINE_ID).getAttribute('aria-selected')).toBe('true');
  });

  test('Home and End jump to the first and last dot without selecting', () => {
    renderDots('atlas');
    tab('atlas').focus();
    fireEvent.keyDown(tab('atlas'), { key: 'End' });
    expect(document.activeElement).toBe(tab('tower'));
    fireEvent.keyDown(tab('tower'), { key: 'Home' });
    expect(document.activeElement).toBe(tab(LOCAL_MACHINE_ID));
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('a handled navigation key is consumed; other keys are left alone', () => {
    renderDots();
    expect(fireEvent.keyDown(tab(LOCAL_MACHINE_ID), { key: 'ArrowRight' })).toBe(false);
    expect(fireEvent.keyDown(tab(LOCAL_MACHINE_ID), { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(tab(LOCAL_MACHINE_ID), { key: 'ArrowDown' })).toBe(true);
  });

  test.each(['Enter', ' '])('%j selects the focused dot', (key) => {
    renderDots();
    tab('tower').focus();
    fireEvent.keyDown(tab('tower'), { key });
    expect(onSelect.mock.calls).toEqual([['tower']]);
  });

  test.each(['Enter', ' '])('%j on the active dot does nothing', (key) => {
    renderDots('tower');
    fireEvent.keyDown(tab('tower'), { key });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('MachineDots states (AC21, AC28)', () => {
  const has = (id: string, ...cls: string[]) => cls.forEach((c) => expect(mark(id).classList).toContain(c));
  const lacks = (id: string, ...cls: string[]) => cls.forEach((c) => expect(mark(id).classList).not.toContain(c));

  test('inactive online is a 6px filled muted dot', () => {
    renderDots('atlas');
    has('tower', 'w-1.5', 'h-1.5', 'bg-[--text-muted]');
    lacks('tower', 'opacity-50', 'bg-transparent');
  });

  test('inactive offline is a 6px hollow muted dimmed ring', () => {
    renderDots();
    has('atlas', 'w-1.5', 'h-1.5', 'border', 'border-[--text-muted]', 'bg-transparent', 'opacity-50');
  });

  test('active online is an 8px filled accent dot', () => {
    renderDots('tower');
    has('tower', 'w-2', 'h-2', 'bg-[--accent]');
    lacks('tower', 'w-1.5', 'opacity-50', 'bg-transparent');
  });

  test('active offline is an 8px hollow accent ring at full opacity', () => {
    renderDots('atlas');
    has('atlas', 'w-2', 'h-2', 'border-[--accent]', 'bg-transparent');
    lacks('atlas', 'opacity-50', 'border-[--text-muted]', 'w-1.5');
  });

  test('this machine reads as online: filled accent when active, filled muted when not', () => {
    renderDots();
    has(LOCAL_MACHINE_ID, 'w-2', 'bg-[--accent]');
    cleanup();
    renderDots('tower');
    has(LOCAL_MACHINE_ID, 'w-1.5', 'bg-[--text-muted]');
  });

  test('size changes animate by CSS only and stop under reduced motion', () => {
    renderDots();
    for (const m of ALL) has(m.deviceId, 'duration-150', 'motion-reduce:transition-none');
  });

  test('every dot button is at least 20x20', () => {
    renderDots();
    for (const m of ALL) {
      expect(tab(m.deviceId).classList).toContain('min-w-5');
      expect(tab(m.deviceId).classList).toContain('min-h-5');
    }
  });
});

describe('MachineDots overflow and drag (AC4, AC8)', () => {
  test('the row is a no-drag horizontal scroller with its scrollbar hidden', () => {
    renderDots();
    const row = screen.getByTestId(MACHINE_TESTIDS.row);
    for (const c of ['no-drag', 'overflow-x-auto', 'scrollbar-none']) expect(row.classList).toContain(c);
  });

  test('scrolls the active dot into view on mount and whenever the active dot changes', () => {
    const { rerender } = renderDots();
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(tab(LOCAL_MACHINE_ID));
    scrollIntoView.mockClear();
    rerender(<MachineDots machines={ALL} activeId="tower" onSelect={onSelect} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(tab('tower'));
    expect(scrollIntoView).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
    scrollIntoView.mockClear();
    rerender(<MachineDots machines={ALL} activeId="tower" onSelect={onSelect} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  test('scrolls a dot into view when it receives focus', () => {
    renderDots();
    scrollIntoView.mockClear();
    fireEvent.focus(tab('tower'));
    expect(scrollIntoView.mock.contexts).toEqual([tab('tower')]);
    expect(scrollIntoView).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
  });
});

describe('MachineDots tooltip (AC25)', () => {
  test('hover shows the full AC25 text after the default delay', async () => {
    renderDots();
    fireEvent.mouseEnter(tab('atlas').parentElement!);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(screen.getByRole('tooltip').textContent).toBe('Atlas · offline · last seen 3h ago');
    fireEvent.mouseLeave(tab('atlas').parentElement!);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  test('keyboard focus shows the tooltip too, on top of the dot', async () => {
    renderDots();
    act(() => tab(LOCAL_MACHINE_ID).focus());
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Laptop · this machine');
    expect(tip.getAttribute('data-side')).toBe('top');
  });
});
