import { useId, type ChangeEvent, type JSX } from 'react';
import {
  TERMINAL_FONT_WEIGHTS,
  boldWeightChoices,
  parseTerminalFontWeight,
  type TerminalFontWeight,
} from '@shared/terminal-font-weight';
import { FONT_COPY, FONT_TEST_IDS } from '@renderer/fonts/font-contract';
import { useTerminalFontWeight } from '@renderer/fonts/terminal-font-weight-context';
import { SettingRow } from '@renderer/components/settings/primitives';

const SELECT_CLASS =
  'h-[34px] shrink-0 rounded-[9px] bg-[--surface-field] px-2.5 text-[13px] tabular-nums text-[--text] focus:outline-none focus:ring-2 focus:ring-[--accent]/60 focus-visible:rounded-[9px] disabled:opacity-60';

interface WeightSelectRowProps {
  readonly label: string;
  readonly hint: string;
  readonly testId: string;
  readonly value: TerminalFontWeight;
  readonly choices: readonly TerminalFontWeight[];
  readonly disabled?: boolean;
  readonly onChoose: (weight: TerminalFontWeight) => void;
}

/** One settings row holding a native weight select, named by its label; options use the shared CSS weight labels, and a value outside the nine weights is ignored. */
function WeightSelectRow({ label, hint, testId, value, choices, disabled = false, onChoose }: WeightSelectRowProps): JSX.Element {
  const id = useId();

  function handleChange(e: ChangeEvent<HTMLSelectElement>): void {
    const parsed = parseTerminalFontWeight(Number(e.target.value));
    if (parsed.ok) onChoose(parsed.value);
  }

  return (
    <SettingRow label={label} hint={hint} htmlFor={id}>
      <select id={id} value={value} disabled={disabled} data-testid={testId} onChange={handleChange} className={SELECT_CLASS}>
        {choices.map((w) => (
          <option key={w} value={w}>
            {FONT_COPY.terminalWeightOptionLabel(w)}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

/** Settings row for the shared terminal font weight: a native select named "Terminal font weight" offering all nine CSS weights. Choosing one saves it immediately (the store also resets bold to its derived weight); follows the shared weight from other windows and reverted failed saves. */
export function TerminalFontWeightControl(): JSX.Element {
  const { weight, setWeight } = useTerminalFontWeight();
  return (
    <WeightSelectRow
      label={FONT_COPY.terminalWeightLabel}
      hint={FONT_COPY.terminalWeightHint}
      testId={FONT_TEST_IDS.terminalWeightSelect}
      value={weight}
      choices={TERMINAL_FONT_WEIGHTS}
      onChoose={setWeight}
    />
  );
}

/** Settings row for the shared terminal bold weight: a native select named "Terminal bold weight" offering only weights heavier than the font weight, disabled at font weight 900 where Black (900) is the only choice. Choosing one saves it immediately. */
export function TerminalBoldWeightControl(): JSX.Element {
  const { weight, boldWeight, setBoldWeight } = useTerminalFontWeight();
  return (
    <WeightSelectRow
      label={FONT_COPY.terminalBoldLabel}
      hint={FONT_COPY.terminalBoldHint}
      testId={FONT_TEST_IDS.terminalBoldSelect}
      value={boldWeight}
      choices={boldWeightChoices(weight)}
      disabled={weight === 900}
      onChoose={setBoldWeight}
    />
  );
}
