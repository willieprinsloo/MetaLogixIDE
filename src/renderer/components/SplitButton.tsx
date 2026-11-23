import { Tooltip } from './Tooltip';
import { SplitIcon } from './shell-icons';
import { ICON_SIZE } from './icon-size';
import { SPLIT_COPY, SPLIT_TESTIDS } from '../split-copy';

const BASE = 'shrink-0 h-7 w-7 inline-flex items-center justify-center rounded';
const ON = 'bg-[--accent-soft] text-[--accent-soft-text]';
const OFF = 'text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover]';

interface Props {
  on: boolean;
  onToggle: () => void;
}

/** Icon-only toolbar toggle with a stable accessible name and a state-specific tooltip. */
export function SplitButton({ on, onToggle }: Props) {
  return (
    <Tooltip label={on ? SPLIT_COPY.tooltipOn : SPLIT_COPY.tooltipOff} focusable>
      <button
        type="button"
        aria-label={SPLIT_COPY.buttonLabel}
        aria-pressed={on}
        onClick={onToggle}
        className={`${BASE} ${on ? ON : OFF}`}
        data-testid={SPLIT_TESTIDS.toggle}
      >
        <span aria-hidden="true" className="pointer-events-none"><SplitIcon size={ICON_SIZE.md} /></span>
      </button>
    </Tooltip>
  );
}
