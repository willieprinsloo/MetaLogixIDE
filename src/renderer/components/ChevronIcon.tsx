import { ICON_SIZE, ICON_STROKE } from './icon-size';

/** Collapse chevron for sidebar section and root-folder toggles: points down when open, right when `collapsed`. */
export function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden
      width={ICON_SIZE.sm}
      height={ICON_SIZE.sm}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE.outline}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-[--text-muted] transition-transform duration-150"
      style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
