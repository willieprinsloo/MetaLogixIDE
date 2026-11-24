import { FROSTED_GLASS_COPY, FROSTED_GLASS_TESTIDS } from '@renderer/frosted-chrome-contract';
import { CHROME_FROST_LEVELS, TERMINAL_FROST_LEVELS, type FrostPlatform } from '@shared/frosted-glass';
import { useFrostedGlassSettings } from '@renderer/hooks/useFrostedGlassSettings';
import { usePrefersReducedTransparency } from '@renderer/hooks/usePrefersReducedTransparency';
import { Switch } from '@renderer/components/settings/primitives';
import { FrostLevelRow } from '@renderer/components/settings/FrostLevelRow';
import { MaterialRow } from '@renderer/components/settings/MaterialRow';

const ROW_LABEL = 'text-[13px] font-medium text-[--text]';
const HINT = 'text-xs text-[--text-muted]';

/**
 * Settings > General > Appearance "Frosted glass" group, rendered on macOS and Linux (D21, AC26)
 * and varied by `platform`: Frosted chrome switch, Chrome frost and Terminal frost radiogroups,
 * and, on macOS only, the Material select (vibrancy is a macOS API), in that order. It owns its
 * state through `useFrostedGlassSettings`; the level radiogroups stay readable but disabled with
 * "Needs Frosted chrome" (AC9) while Frosted chrome is off, and a `usePrefersReducedTransparency`
 * line (D12, AC24) explains that the system keeps surfaces solid, with Linux-specific copy that
 * names no macOS setting.
 */
export function FrostedGlassGroup({ platform }: { readonly platform: FrostPlatform }) {
  const { values, setFrostChrome, setChromeFrostLevel, setTerminalFrostLevel, setVibrancyMaterial } =
    useFrostedGlassSettings();
  const reduceTransparency = usePrefersReducedTransparency();
  const headingId = `${FROSTED_GLASS_TESTIDS.group}-heading`;
  const levelsDisabled = !values.frostChrome;
  const isLinux = platform === 'linux';

  return (
    <div role="group" aria-labelledby={headingId} data-testid={FROSTED_GLASS_TESTIDS.group} className="flex flex-col gap-3.5">
      <div id={headingId} className={ROW_LABEL}>{FROSTED_GLASS_COPY.group}</div>
      <div className="flex flex-col gap-1">
        <Switch
          label={FROSTED_GLASS_COPY.frostChrome}
          ariaLabel={FROSTED_GLASS_COPY.frostChrome}
          testId={FROSTED_GLASS_TESTIDS.frostChrome}
          checked={values.frostChrome}
          onChange={(next) => void setFrostChrome(next)}
        />
        <span className={HINT}>
          {isLinux ? FROSTED_GLASS_COPY.frostChromeHintLinux : FROSTED_GLASS_COPY.frostChromeHint}
        </span>
      </div>
      <FrostLevelRow
        label={FROSTED_GLASS_COPY.chromeFrost}
        options={CHROME_FROST_LEVELS}
        value={values.chromeFrostLevel}
        disabled={levelsDisabled}
        testId={FROSTED_GLASS_TESTIDS.chromeFrost}
        onChange={(next) => void setChromeFrostLevel(next)}
      />
      <FrostLevelRow
        label={FROSTED_GLASS_COPY.terminalFrost}
        options={TERMINAL_FROST_LEVELS}
        value={values.terminalFrostLevel}
        disabled={levelsDisabled}
        testId={FROSTED_GLASS_TESTIDS.terminalFrost}
        onChange={(next) => void setTerminalFrostLevel(next)}
      />
      {!isLinux && <MaterialRow value={values.vibrancyMaterial} onChange={(next) => void setVibrancyMaterial(next)} />}
      {reduceTransparency && (
        <p data-testid={FROSTED_GLASS_TESTIDS.reduceTransparency} className={HINT}>
          {isLinux ? FROSTED_GLASS_COPY.reduceTransparencyLinux : FROSTED_GLASS_COPY.reduceTransparency}
        </p>
      )}
    </div>
  );
}
