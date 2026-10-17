import { FROSTED_GLASS_COPY } from '@renderer/frosted-chrome-contract';
import { SegmentedRadioGroup } from '@renderer/components/settings/SegmentedRadioGroup';
import type { TerminalFrostLevel } from '@shared/frosted-glass';

export interface FrostLevelRowProps<T extends TerminalFrostLevel> {
  label: string;
  options: readonly T[];
  value: T;
  disabled: boolean;
  testId: string;
  onChange: (level: T) => void;
}

/**
 * One Frosted glass level row: the visible `label` left, a level `SegmentedRadioGroup` right
 * (named by `label`, carrying `testId`). While `disabled` the radios stay readable and the
 * "Needs Frosted chrome" reason shows under them, linked to the radiogroup with
 * `aria-describedby` so it is announced with the disabled radios (AC9).
 */
export function FrostLevelRow<T extends TerminalFrostLevel>({ label, options, value, disabled, testId, onChange }: FrostLevelRowProps<T>) {
  const hintId = `${testId}-hint`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <span className="text-[13px] font-medium text-[--text]">{label}</span>
      <div className="flex flex-col items-end gap-1">
        <SegmentedRadioGroup
          label={label}
          options={options}
          labels={FROSTED_GLASS_COPY.levels}
          value={value}
          disabled={disabled}
          testId={testId}
          describedBy={disabled ? hintId : undefined}
          onChange={onChange}
        />
        {disabled && <span id={hintId} className="text-xs text-[--text-muted]">{FROSTED_GLASS_COPY.disabledReason}</span>}
      </div>
    </div>
  );
}
