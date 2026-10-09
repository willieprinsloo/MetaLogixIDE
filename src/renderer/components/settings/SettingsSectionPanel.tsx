/**
 * The Settings dialog's scrolling content area, showing the panel for the
 * active section.
 */
import type { FontDiscoveryState } from '@renderer/components/FontControl';
import { EnvironmentPanel } from '@renderer/components/settings/EnvironmentPanel';
import { GeneralPanel } from '@renderer/components/settings/GeneralPanel';
import { LaunchPanel } from '@renderer/components/settings/LaunchPanel';
import { MetaprojectPanel } from '@renderer/components/settings/MetaprojectPanel';
import { RootsPanel } from '@renderer/components/settings/RootsPanel';
import type { SettingsSection } from '@renderer/components/settings/nav-icons';
import type { EnvDrafts } from '@renderer/hooks/useEnvDrafts';

interface Props {
  readonly section: SettingsSection;
  readonly envDrafts: EnvDrafts;
  readonly fontDiscovery: FontDiscoveryState;
  readonly onLoadInstalledFonts: () => Promise<void>;
}

/** Renders the panel for `section`; General gets the session's font discovery, Environment the app-owned `envDrafts`. */
export function SettingsSectionPanel({
  section,
  envDrafts,
  fontDiscovery,
  onLoadInstalledFonts,
}: Props): React.JSX.Element {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-7 pt-1 sm:pl-3 sm:pr-7">
      {section === 'general' && (
        <GeneralPanel fontDiscovery={fontDiscovery} onLoadInstalledFonts={onLoadInstalledFonts} />
      )}
      {section === 'roots' && <RootsPanel />}
      {section === 'launch' && <LaunchPanel />}
      {section === 'env' && <EnvironmentPanel drafts={envDrafts} />}
      {section === 'metaproject' && <MetaprojectPanel />}
    </div>
  );
}
