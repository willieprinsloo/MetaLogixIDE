/**
 * Settings nav: the section ids, one inline 15px stroke icon per section (General in the item's
 * text colour, the others in their semantic hue), and the `SectionButton` nav item that pairs an
 * icon with its text-only label, marks the active section with `aria-current="page"` and can show
 * an unsaved-changes marker.
 */
import { APP_ENV_TESTIDS, ENV_COPY } from '@renderer/project-env-copy';

export type SettingsSection = 'general' | 'roots' | 'launch' | 'env' | 'metaproject';

const ICON_HUES: Record<SettingsSection, string> = {
  general: '',
  roots: 'text-[--hue-yellow]',
  launch: 'text-[--hue-purple]',
  env: 'text-[--hue-orange]',
  metaproject: 'text-[--hue-cyan]',
};

const ICON_SHAPES: Record<SettingsSection, React.JSX.Element> = {
  general: (
    <>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </>
  ),
  roots: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  launch: <path d="M4 17l6-5-6-5M12 19h8" />,
  env: (
    <path d="M8 4H7a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1" />
  ),
  metaproject: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </>
  ),
};

/** Decorative 15x15 icon for `section`, wrapped in a span carrying its hue; hidden from assistive tech. */
export function NavIcon({ section }: { readonly section: SettingsSection }): React.JSX.Element {
  return (
    <span className={`flex shrink-0 ${ICON_HUES[section]}`}>
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {ICON_SHAPES[section]}
      </svg>
    </span>
  );
}

interface SectionButtonProps {
  readonly section: SettingsSection;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly unsavedLabel?: string;
  readonly children: React.ReactNode;
}

/** Settings nav item: icon then label; `active` sets the selected look and `aria-current="page"`; `unsavedLabel` becomes the accessible name and adds a visible, aria-hidden unsaved marker. */
export function SectionButton({
  section,
  active,
  onClick,
  unsavedLabel,
  children,
}: SectionButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={unsavedLabel}
      className={`flex h-[38px] shrink-0 items-center gap-2.5 rounded-[10px] whitespace-nowrap px-3 text-left text-[13px] focus-visible:rounded-[10px] sm:w-full ${
        active
          ? 'bg-[--accent-soft] text-[--accent-soft-text] font-medium'
          : 'hover:bg-[--surface-hover] text-[--text-muted] hover:text-[--text]'
      }`}
    >
      <NavIcon section={section} />
      <span className="min-w-0 truncate">{children}</span>
      {unsavedLabel && (
        <span
          aria-hidden="true"
          className="-ml-1.5 text-[--accent]"
          data-testid={APP_ENV_TESTIDS.unsaved}
        >
          {ENV_COPY.tabUnsavedMarker}
        </span>
      )}
    </button>
  );
}
