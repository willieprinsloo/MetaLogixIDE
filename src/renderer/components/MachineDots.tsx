import { useEffect, useRef } from 'react';
import { Tooltip } from './Tooltip';
import type { MachineDot } from '@renderer/machine-switcher-contract';
import { MACHINE_COPY, MACHINE_TESTIDS } from '@renderer/sidebar-copy';
import { SWITCHER_PANEL_ID, dotAccessibleName, dotTooltip, machineTabId, stepFocus } from '@renderer/machine-dots';

interface Props {
  machines: readonly MachineDot[];
  activeId: string;
  onSelect: (deviceId: string) => void;
}

const SCROLL: ScrollIntoViewOptions = { inline: 'nearest', block: 'nearest' };
const DOT_BASE = 'block rounded-full transition-[width,height,background-color,border-color,opacity] duration-150 motion-reduce:transition-none';

function dotClass(m: MachineDot, active: boolean): string {
  if (active) return m.online ? 'w-2 h-2 bg-[--accent]' : 'w-2 h-2 border-[1.5px] border-[--accent] bg-transparent';
  return m.online
    ? 'w-1.5 h-1.5 bg-[--text-muted] group-hover:bg-[--text]'
    : 'w-1.5 h-1.5 border border-[--text-muted] bg-transparent opacity-50 group-hover:opacity-80';
}

/**
 * The sidebar's machine switcher row (docs/specs/machine-switcher-dots.md AC2, AC4, AC8, AC21,
 * AC25–AC28): a WAI-ARIA tablist with a roving tab stop on the active dot and manual activation —
 * arrows and Home/End move focus, Enter, Space or a click calls `onSelect` with the dot's device id
 * (never for the dot already active). Each dot has a tooltip on hover and keyboard focus, and the
 * row scrolls sideways with a hidden scrollbar, keeping the active or focused dot in view.
 */
export function MachineDots({ machines, activeId, onSelect }: Props) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => { buttons.current.get(activeId)?.scrollIntoView(SCROLL); }, [activeId]);

  const now = Date.now();
  const activate = (deviceId: string) => { if (deviceId !== activeId) onSelect(deviceId); };

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number, deviceId: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(deviceId);
      return;
    }
    const next = stepFocus(index, machines.length, e.key);
    if (next === null) return;
    e.preventDefault();
    buttons.current.get(machines[next]!.deviceId)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={MACHINE_COPY.tablistLabel}
      data-testid={MACHINE_TESTIDS.row}
      className="no-drag flex items-center gap-1 min-w-0 max-w-full overflow-x-auto scrollbar-none p-1"
    >
      {machines.map((m, i) => {
        const active = m.deviceId === activeId;
        return (
          <Tooltip key={m.deviceId} label={dotTooltip(m, now)} side="top" focusable>
            <button
              ref={(el) => { if (el) buttons.current.set(m.deviceId, el); else buttons.current.delete(m.deviceId); }}
              type="button"
              role="tab"
              id={machineTabId(m.deviceId)}
              aria-selected={active}
              aria-controls={SWITCHER_PANEL_ID}
              aria-label={dotAccessibleName(m, now)}
              tabIndex={active ? 0 : -1}
              data-testid={MACHINE_TESTIDS.dot(m.deviceId)}
              onClick={() => activate(m.deviceId)}
              onKeyDown={(e) => onKeyDown(e, i, m.deviceId)}
              onFocus={(e) => e.currentTarget.scrollIntoView(SCROLL)}
              className="group shrink-0 min-w-5 min-h-5 flex items-center justify-center"
            >
              <span aria-hidden data-dot className={`${DOT_BASE} ${dotClass(m, active)}`} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
