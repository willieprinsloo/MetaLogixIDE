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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

describe('MachineDots states (AC21, AC28, AC32, AC34)', () => {
  const has = (id: string, ...cls: string[]) => cls.forEach((c) => expect(mark(id).classList).toContain(c));
  const lacks = (id: string, ...cls: string[]) => cls.forEach((c) => expect(mark(id).classList).not.toContain(c));
  const BUSY_TOWER: MachineDot = { ...TOWER, agentState: 'busy' };
  const BLOCKED_LOCAL: MachineDot = { ...LOCAL, agentState: 'blocked' };

  test('every dot is a glass circle: 8px inactive, 10px active', () => {
    renderDots('atlas');
    for (const m of ALL) has(m.deviceId, 'machine-dot', 'rounded-full');
    has('tower', 'w-2', 'h-2');
    has(LOCAL_MACHINE_ID, 'w-2', 'h-2');
    has('atlas', 'w-2.5', 'h-2.5');
    lacks('atlas', 'w-2');
    lacks('tower', 'w-2.5');
  });

  test('only the active dot carries data-active; offline dots carry data-online="0"', () => {
    renderDots('atlas');
    expect(ALL.map((m) => mark(m.deviceId).hasAttribute('data-active'))).toEqual([false, true, false]);
    expect(ALL.map((m) => mark(m.deviceId).getAttribute('data-online'))).toEqual(['1', '0', '1']);
  });

  test('data-agent-state carries an online dot\'s status and is absent with no agent or offline', () => {
    renderDots(LOCAL_MACHINE_ID, [BLOCKED_LOCAL, { ...ATLAS, agentState: 'busy' }, BUSY_TOWER]);
    expect(mark(LOCAL_MACHINE_ID).getAttribute('data-agent-state')).toBe('blocked');
    expect(mark('tower').getAttribute('data-agent-state')).toBe('busy');
    expect(mark('atlas').hasAttribute('data-agent-state')).toBe(false);
    cleanup();
    renderDots();
    for (const m of ALL) expect(mark(m.deviceId).hasAttribute('data-agent-state')).toBe(false);
  });

  test('only a busy online dot pulses', () => {
    renderDots(LOCAL_MACHINE_ID, [BLOCKED_LOCAL, { ...ATLAS, agentState: 'busy' }, BUSY_TOWER]);
    has('tower', 'live-dot');
    lacks(LOCAL_MACHINE_ID, 'live-dot');
    lacks('atlas', 'live-dot');
  });

  test('the accessible name adds the status words (AC35)', () => {
    renderDots(LOCAL_MACHINE_ID, [BLOCKED_LOCAL, ATLAS, BUSY_TOWER]);
    expect(tab('tower').getAttribute('aria-label')).toBe('Tower, online, agent Working');
    expect(tab(LOCAL_MACHINE_ID).getAttribute('aria-label')).toBe('Laptop, this machine, agent Needs input');
  });

  test('the dot and the row carry no colour, border or shadow utilities', () => {
    renderDots('atlas', [BLOCKED_LOCAL, ATLAS, BUSY_TOWER]);
    const row = screen.getByTestId(MACHINE_TESTIDS.row);
    const painted = (el: Element) => [...el.classList].filter((c) => /^(bg|border|shadow|opacity)-|^border$/.test(c));
    expect(painted(row)).toEqual([]);
    for (const m of ALL) expect(painted(mark(m.deviceId))).toEqual([]);
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

  test('a busy dot\'s full pulse ring fits inside the row\'s clip box, active or not (AC34)', () => {
    const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8');
    const pulse = /\.machine-dot\.live-dot::after\s*\{[^}]*animation:\s*([\w-]+)/.exec(css)![1]!;
    const scale = Number(new RegExp(`@keyframes ${pulse}\\s*\\{[^}]*\\}\\s*to\\s*\\{[^}]*scale\\(([\\d.]+)\\)`).exec(css)![1]);
    const border = Number(/\.machine-dot \{[^}]*border: (\d+)px/.exec(css)![1]);
    const px = (el: Element, prefix: string) => {
      const token = [...el.classList].find((c) => new RegExp(`^${prefix}-[\\d.]+$`).test(c));
      return token ? Number(token.slice(prefix.length + 1)) * 4 : 0;
    };
    renderDots('tower', [LOCAL, { ...TOWER, agentState: 'busy' }, { ...LOCAL, deviceId: 'b2', self: false, agentState: 'busy' }]);
    const pad = px(screen.getByTestId(MACHINE_TESTIDS.row), 'p');
    for (const id of ['tower', 'b2']) {
      expect(mark(id).classList).toContain('live-dot');
      const size = px(mark(id), 'w');
      const ring = ((size - 2 * border) / 2) * scale;
      const clearance = pad + Math.max(px(tab(id), 'min-h'), size) / 2;
      expect(ring).toBeLessThanOrEqual(clearance);
      expect(ring).toBeGreaterThan(size / 2);
    }
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
