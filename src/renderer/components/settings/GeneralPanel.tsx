import { useEffect, useId, useState } from 'react';
import type { SettingsMap } from '@shared/types';
import {
  TERMINAL_FONT_FALLBACK,
  UI_FONT_FALLBACK,
  type FontFamilyPreference,
} from '@shared/font-settings';
import { api } from '@renderer/api';
import { useTheme, type ThemeMode, type ThemePalette } from '@renderer/hooks/useTheme';
import {
  FontControl,
  type FontDiscoveryState,
} from '@renderer/components/FontControl';
import { FONT_COPY } from '@renderer/fonts/font-contract';
import { useFontSettings } from '@renderer/fonts/font-settings-context';
import { TerminalFontSizeControl } from '@renderer/components/settings/TerminalFontSizeControl';
import { TerminalBoldWeightControl, TerminalFontWeightControl } from '@renderer/components/settings/TerminalFontWeightControl';
import {
  SettingRow,
  SettingStack,
  SettingsSection,
  Switch,
  WorkspaceNumber,
} from '@renderer/components/settings/primitives';
import { PaletteCards } from '@renderer/components/settings/PaletteCards';
import { ModeControl } from '@renderer/components/settings/ModeControl';

/** General settings board: Appearance, Fonts, Workspace and Notifications sections. The only General component reading the theme and settings; the sections below it are presentational. */
export function GeneralPanel({
  fontDiscovery,
  onLoadInstalledFonts,
}: {
  readonly fontDiscovery: FontDiscoveryState;
  readonly onLoadInstalledFonts: () => Promise<void>;
}) {
  const { mode, palette, effective, setMode, setPalette } = useTheme();
  const board = useBoardSettings();

  return (
    <div className="flex flex-col gap-[30px]">
      <AppearanceSection
        theme={{ mode, palette, effective }}
        opacity={board.opacity}
        onMode={setMode}
        onPalette={setPalette}
        onOpacity={(v) => void board.applyOpacity(v)}
      />
      <FontSettingsControls discovery={fontDiscovery} onLoadInstalledFonts={onLoadInstalledFonts} />
      <WorkspaceSection
        cap={board.cap}
        scanDepth={board.scanDepth}
        maxWatched={board.maxWatched}
        onCap={(v) => board.update('keep_alive_cap', v)}
        onScanDepth={(v) => board.update('scan_depth', v)}
        onMaxWatched={(v) => board.update('max_watched_paths', v)}
      />
      <NotificationsSection
        needsInput={board.notifyNeedsInput}
        finished={board.notifyFinished}
        onNeedsInput={(v) => board.update('notify_claude_needs_input', v)}
        onFinished={(v) => board.update('notify_claude_finished', v)}
      />
    </div>
  );
}

type BoardKey =
  | 'keep_alive_cap'
  | 'scan_depth'
  | 'max_watched_paths'
  | 'notify_claude_needs_input'
  | 'notify_claude_finished';

interface BoardValues {
  readonly cap: number | null;
  readonly scanDepth: number | null;
  readonly maxWatched: number | null;
  readonly opacity: number;
  readonly notifyNeedsInput: boolean;
  readonly notifyFinished: boolean;
}

const INITIAL: BoardValues = {
  cap: null,
  scanDepth: null,
  maxWatched: null,
  opacity: 100,
  notifyNeedsInput: true,
  notifyFinished: true,
};

const FIELD: Readonly<Record<BoardKey, keyof BoardValues>> = {
  keep_alive_cap: 'cap',
  scan_depth: 'scanDepth',
  max_watched_paths: 'maxWatched',
  notify_claude_needs_input: 'notifyNeedsInput',
  notify_claude_finished: 'notifyFinished',
};

async function loadBoard(): Promise<BoardValues> {
  const [c, d, w, o, ni, nf] = await Promise.all([
    api.invoke('settings:get', { key: 'keep_alive_cap' }),
    api.invoke('settings:get', { key: 'scan_depth' }),
    api.invoke('settings:get', { key: 'max_watched_paths' }),
    api.invoke('settings:get', { key: 'window_opacity' }),
    api.invoke('settings:get', { key: 'notify_claude_needs_input' }),
    api.invoke('settings:get', { key: 'notify_claude_finished' }),
  ]);
  return {
    cap: c.value as number,
    scanDepth: d.value as number,
    maxWatched: w.value as number,
    opacity: (o.value as number) ?? 100,
    notifyNeedsInput: (ni.value as boolean) ?? true,
    notifyFinished: (nf.value as boolean) ?? true,
  };
}

/** Board settings state: loads the six keys once, `update` sets a value locally and saves it, `applyOpacity` clamps to 30..100 and applies window opacity. */
function useBoardSettings() {
  const [values, setValues] = useState<BoardValues>(INITIAL);

  useEffect(() => { void loadBoard().then(setValues); }, []);

  function update<K extends BoardKey>(key: K, value: SettingsMap[K]): void {
    setValues((prev) => ({ ...prev, [FIELD[key]]: value }));
    void api.invoke('settings:set', { key, value });
  }

  async function applyOpacity(v: number): Promise<void> {
    const clamped = Math.max(30, Math.min(100, Math.round(v)));
    setValues((prev) => ({ ...prev, opacity: clamped }));
    await api.invoke('app:set-window-opacity', { percent: clamped });
  }

  return { ...values, update, applyOpacity };
}

function AppearanceSection({
  theme,
  opacity,
  onMode,
  onPalette,
  onOpacity,
}: {
  readonly theme: { readonly mode: ThemeMode; readonly palette: ThemePalette; readonly effective: 'light' | 'dark' };
  readonly opacity: number;
  readonly onMode: (mode: ThemeMode) => void;
  readonly onPalette: (palette: ThemePalette) => void;
  readonly onOpacity: (percent: number) => void;
}) {
  return (
    <SettingsSection title="Appearance">
      <SettingStack label="Theme">
        <PaletteCards palette={theme.palette} effective={theme.effective} onSelect={onPalette} />
      </SettingStack>
      <SettingRow label="Mode" hint="System follows your OS appearance.">
        <ModeControl mode={theme.mode} effective={theme.effective} onChange={onMode} />
      </SettingRow>
      <SettingRow label="Window opacity" hint="Below 100% your desktop shows through.">
        <div className="flex w-[260px] max-w-full items-center gap-3">
          <input
            type="range"
            min={30}
            max={100}
            step={1}
            value={opacity}
            aria-label="Window opacity"
            onChange={(e) => onOpacity(Number(e.target.value))}
            className="min-w-0 flex-1 accent-[--accent]"
            data-testid="window-opacity-slider"
          />
          <span className="w-10 text-right text-[13px] tabular-nums text-[--text]">{opacity}%</span>
        </div>
      </SettingRow>
    </SettingsSection>
  );
}

function WorkspaceSection({
  cap,
  scanDepth,
  maxWatched,
  onCap,
  onScanDepth,
  onMaxWatched,
}: {
  readonly cap: number | null;
  readonly scanDepth: number | null;
  readonly maxWatched: number | null;
  readonly onCap: (v: number) => void;
  readonly onScanDepth: (v: number) => void;
  readonly onMaxWatched: (v: number) => void;
}) {
  const id = useId();
  return (
    <SettingsSection title="Workspace">
      <SettingRow label="Keep-alive cap" hint="Shells kept running at once; the oldest is closed first." htmlFor={`${id}-cap`}>
        <WorkspaceNumber id={`${id}-cap`} value={cap} min={1} max={20} onChange={onCap} />
      </SettingRow>
      <SettingRow label="Root scan depth" hint="Folder levels below a root that count as projects." htmlFor={`${id}-depth`}>
        <WorkspaceNumber id={`${id}-depth`} value={scanDepth} min={1} max={4} onChange={onScanDepth} />
      </SettingRow>
      <SettingRow label="Max watched paths" hint="File-watcher limit across all roots." htmlFor={`${id}-watch`}>
        <WorkspaceNumber id={`${id}-watch`} value={maxWatched} min={50} max={5000} step={50} onChange={onMaxWatched} />
      </SettingRow>
    </SettingsSection>
  );
}

function NotificationsSection({
  needsInput,
  finished,
  onNeedsInput,
  onFinished,
}: {
  readonly needsInput: boolean;
  readonly finished: boolean;
  readonly onNeedsInput: (on: boolean) => void;
  readonly onFinished: (on: boolean) => void;
}) {
  return (
    <SettingsSection title="Notifications">
      <Switch
        label="When Claude needs input"
        ariaLabel="Notify when Claude needs input"
        testId="notify-needs-input-toggle"
        checked={needsInput}
        onChange={onNeedsInput}
      />
      <Switch
        label="When Claude finishes"
        ariaLabel="Notify when Claude finishes"
        testId="notify-finished-toggle"
        checked={finished}
        onChange={onFinished}
      />
    </SettingsSection>
  );
}

function FontSettingsControls({
  discovery,
  onLoadInstalledFonts,
}: {
  readonly discovery: FontDiscoveryState;
  readonly onLoadInstalledFonts: () => Promise<void>;
}) {
  const { uiFontFamily, terminalFontFamily } = useFontSettings();

  async function saveFont(
    key: 'ui_font_family' | 'terminal_font_family',
    value: FontFamilyPreference,
  ): Promise<void> {
    await api.invoke('settings:set-font', { key, value });
  }

  return (
    <SettingsSection title={FONT_COPY.sectionLabel} hint="Pick an installed font or type an exact family name.">
      <FontControl
        settingKey="ui_font_family"
        label={FONT_COPY.uiLabel}
        value={uiFontFamily}
        fallback={UI_FONT_FALLBACK}
        discovery={discovery}
        onSave={(value) => saveFont('ui_font_family', value)}
        onLoadInstalledFonts={onLoadInstalledFonts}
      />
      <FontControl
        settingKey="terminal_font_family"
        label={FONT_COPY.terminalLabel}
        value={terminalFontFamily}
        fallback={TERMINAL_FONT_FALLBACK}
        discovery={discovery}
        onSave={(value) => saveFont('terminal_font_family', value)}
        onLoadInstalledFonts={onLoadInstalledFonts}
      />
      <TerminalFontSizeControl />
      <TerminalFontWeightControl />
      <TerminalBoldWeightControl />
    </SettingsSection>
  );
}
