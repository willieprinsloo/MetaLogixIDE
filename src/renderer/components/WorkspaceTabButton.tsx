import type { ReactNode } from 'react';
import type { MainTab } from '../main-tab';
import { ICON_SIZE, ICON_STROKE } from './icon-size';
import { Tooltip } from './Tooltip';

const SHAPES: Record<MainTab, ReactNode> = {
  shell: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  files: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  diff: <path d="M3 8h8M7 4v8m6 4h8" />,
  settings: <><path d="M3 7h4m4 0h10M3 17h10m4 0h4" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></>,
  activity: <path d="M2 12h5l3-7 4 14 3-7h5" />,
};

interface Props {
  readonly tab: MainTab;
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly testId?: string;
  readonly ariaLabel?: string;
  readonly children?: ReactNode;
}

/** An icon-only workspace destination; optional children are status indicators. */
export function WorkspaceTabButton({ tab, label, active, onClick, testId, ariaLabel, children }: Props) {
  return (
    <Tooltip label={label} focusable>
      <button type="button" onClick={onClick} data-testid={testId} aria-label={ariaLabel ?? label}
        aria-current={active ? 'page' : undefined}
        className="main-tab-button inline-flex h-7 min-w-8 items-center justify-center rounded-lg px-2 font-medium focus-visible:outline focus-visible:outline-1 focus-visible:outline-[--accent]">
        <span aria-hidden="true" className="main-tab-selection" />
        <span aria-hidden="true" className="pointer-events-none relative inline-flex items-center">
          <svg width={ICON_SIZE.md} height={ICON_SIZE.md} viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth={ICON_STROKE.outline} strokeLinecap="round" strokeLinejoin="round">
            {SHAPES[tab]}
          </svg>
          {children}
        </span>
      </button>
    </Tooltip>
  );
}
