import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FontDiscoveryState } from '@renderer/components/FontControl';
import { discoverLocalFonts } from '@renderer/fonts/local-font-access';
import { SettingsSectionPanel } from '@renderer/components/settings/SettingsSectionPanel';
import { SectionButton, type SettingsSection } from '@renderer/components/settings/nav-icons';
import { versionLabel } from '@renderer/components/settings/version-label';
import { useAppVersion } from '@renderer/hooks/useAppVersion';
import { useDialogFocus } from '@renderer/hooks/useDialogFocus';
import { APP_ENV_DRAFT_KEY, type EnvDrafts } from '@renderer/hooks/useEnvDrafts';
import { APP_ENV_COPY } from '@renderer/project-env-copy';

interface FontDiscoverySession {
  readonly fontDiscovery: FontDiscoveryState;
  readonly onLoadInstalledFonts: () => Promise<void>;
}

interface SettingsDialogProps extends FontDiscoverySession {
  readonly section: SettingsSection;
  readonly onSection: (section: SettingsSection) => void;
  readonly envDrafts: EnvDrafts;
  readonly version: string | null;
  readonly onClose: () => void;
}

interface SettingsProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly section: SettingsSection;
  readonly onSection: (section: SettingsSection) => void;
  readonly envDrafts: EnvDrafts;
}

/** Renders application settings and owns installed-font discovery for one open session. The caller owns the active `section` (so it can open a given one) and `envDrafts` (so the app-wide env draft outlives the dialog). */
export function Settings({
  open,
  onClose,
  section,
  onSection,
  envDrafts,
}: SettingsProps): React.JSX.Element | null {
  const version = useAppVersion();
  const fonts = useFontDiscoverySession(open);
  if (!open) return null;
  return (
    <SettingsDialog
      section={section}
      onSection={onSection}
      envDrafts={envDrafts}
      version={version}
      onClose={onClose}
      {...fonts}
    />
  );
}

/** Installed-font discovery state for one open session, reset (and in-flight results dropped) on close. */
function useFontDiscoverySession(open: boolean): FontDiscoverySession {
  const [fontDiscovery, setFontDiscovery] = useState<FontDiscoveryState>({ status: 'idle' });
  const fontDiscoveryAttempted = useRef(false);
  const fontDiscoveryGeneration = useRef(0);

  useEffect(() => {
    if (open) return;
    fontDiscoveryGeneration.current += 1;
    fontDiscoveryAttempted.current = false;
    setFontDiscovery({ status: 'idle' });
  }, [open]);

  const onLoadInstalledFonts = useCallback(async (): Promise<void> => {
    if (fontDiscoveryAttempted.current) return;
    fontDiscoveryAttempted.current = true;
    const generation = fontDiscoveryGeneration.current;
    setFontDiscovery({ status: 'loading' });
    const result = await discoverLocalFonts(window);
    if (fontDiscoveryGeneration.current === generation) {
      fontDiscoveryAttempted.current = false;
      setFontDiscovery(result);
    }
  }, []);

  return { fontDiscovery, onLoadInstalledFonts };
}

// The global :focus-visible rule would square the corners and ring the whole panel when it takes initial focus.
const PANEL_CLASS =
  'modal-panel relative flex h-[640px] max-h-[92vh] w-[820px] max-w-[92vw] flex-col overflow-hidden rounded-2xl bg-[--panel-strong] shadow-2xl focus-visible:rounded-2xl focus-visible:outline-none';

/** The open dialog: backdrop, focus-managed panel, header, nav, the active section and the footer. */
function SettingsDialog({
  section,
  onSection,
  envDrafts,
  version,
  onClose,
  fontDiscovery,
  onLoadInstalledFonts,
}: SettingsDialogProps): React.JSX.Element {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useDialogFocus(panelRef);
  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      data-testid="settings-modal"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={PANEL_CLASS}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <SettingsHeader titleId={titleId} onClose={onClose} />
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <SettingsNav
            section={section}
            onSection={onSection}
            envUnsaved={envDrafts.isDirty(APP_ENV_DRAFT_KEY)}
            version={version}
          />
          <SettingsSectionPanel
            section={section}
            envDrafts={envDrafts}
            fontDiscovery={fontDiscovery}
            onLoadInstalledFonts={onLoadInstalledFonts}
          />
        </div>
        <SettingsFooter onClose={onClose} />
      </div>
    </div>
  );
}

function SettingsFooter({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  return (
    <div className="flex h-[60px] shrink-0 items-center justify-end gap-2 bg-[color-mix(in_oklab,var(--surface-chrome)_25%,var(--panel-strong))] px-5">
      <button
        type="button"
        onClick={onClose}
        className="pressable h-9 rounded-[10px] bg-[--accent-soft] px-5 text-sm font-medium text-[--accent-soft-text] hover:brightness-125 focus-visible:rounded-[10px]"
        data-testid="settings-done"
      >
        Done
      </button>
    </div>
  );
}

function SettingsHeader({
  titleId,
  onClose,
}: {
  readonly titleId: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="drag flex h-[52px] shrink-0 items-center justify-between pl-[22px] pr-2.5">
      <h1 id={titleId} className="text-[15px] font-semibold">
        Settings
      </h1>
      <button
        type="button"
        onClick={onClose}
        className="no-drag flex h-9 w-9 items-center justify-center rounded-[10px] text-[--text-muted] hover:bg-[--surface-hover] hover:text-[--text] focus-visible:rounded-[10px]"
        title="Close (Esc)"
        data-testid="settings-close"
        aria-label="Close settings"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

interface SettingsNavProps {
  readonly section: SettingsSection;
  readonly onSection: (section: SettingsSection) => void;
  readonly envUnsaved: boolean;
  readonly version: string | null;
}

const NAV_ITEMS: readonly { readonly section: SettingsSection; readonly label: string }[] = [
  { section: 'general', label: 'General' },
  { section: 'roots', label: 'Root directories' },
  { section: 'launch', label: 'Launch commands' },
  { section: 'env', label: APP_ENV_COPY.navLabel },
  { section: 'metaproject', label: 'Metaproject' },
];

function SettingsNav({
  section,
  onSection,
  envUnsaved,
  version,
}: SettingsNavProps): React.JSX.Element {
  return (
    <nav
      aria-label="Settings sections"
      className="flex w-full shrink-0 gap-2 overflow-x-auto px-3 pb-3 sm:w-[196px] sm:flex-col sm:gap-0.5 sm:overflow-visible sm:pb-4 sm:pt-1"
    >
      {NAV_ITEMS.map((item) => (
        <SectionButton
          key={item.section}
          section={item.section}
          active={section === item.section}
          onClick={() => onSection(item.section)}
          unsavedLabel={
            item.section === 'env' && envUnsaved ? APP_ENV_COPY.navUnsavedLabel : undefined
          }
        >
          {item.label}
        </SectionButton>
      ))}
      <div className="mt-auto hidden px-3 pt-3 text-[11.5px] text-[--text-muted] sm:block">
        {versionLabel(version)}
      </div>
    </nav>
  );
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
