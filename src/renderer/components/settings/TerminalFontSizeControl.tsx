import { useEffect, useId, useState, type JSX, type KeyboardEvent } from 'react';
import { TERMINAL_FONT_SIZE } from '@shared/terminal-font-size';
import { FONT_COPY, FONT_TEST_IDS } from '@renderer/fonts/font-contract';
import { useTerminalFontSize } from '@renderer/fonts/terminal-font-size-context';
import { NUMBER_FIELD_CLASS, SettingRow } from '@renderer/components/settings/primitives';
import { initialDraft, onCommit, onExternalUpdate, onInput, onStep, type DraftState } from '@renderer/components/settings/font-size-draft';

const HIDE_NATIVE_SPINNER_CLASS =
  '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]';

const STEP_BUTTON_CLASS =
  'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-[--surface-field] text-[13px] text-[--text] focus:outline-none focus:ring-2 focus:ring-[--accent]/60 focus-visible:rounded-[9px]';

/** One ± stepper button beside the terminal-size field. `onMouseDown` preventDefault keeps focus on the field, so clicking it never blur-commits a partial typed edit before the step runs. */
function StepButton({ label, glyph, onPress }: { readonly label: string; readonly glyph: string; readonly onPress: () => void }): JSX.Element {
  return (
    <button type="button" aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={onPress} className={STEP_BUTTON_CLASS}>
      {glyph}
    </button>
  );
}

/** Settings row for the one shared integrated-terminal font size: a 9..28 px number field, flanked by explicit "−"/"+" stepper buttons, with a "px" readout, named "Terminal font size". AC2 (amended): typed text never saves while typing, only on blur or Enter (clamped if out of range, reverted to the saved value if empty, non-numeric or non-integer); the stepper buttons and ArrowUp/ArrowDown on the field save immediately, stepping from an unsaved typed draft when one is present. The native spinner is hidden so there is exactly one way to step. Follows the shared size (keyboard zoom, other windows, or a reverted failed save) while the field holds no uncommitted typed edit. */
export function TerminalFontSizeControl(): JSX.Element {
  const { size, setSize } = useTerminalFontSize();
  const id = useId();
  const [state, setState] = useState<DraftState>(() => initialDraft(size));

  useEffect(() => {
    setState((prev) => onExternalUpdate(prev, size));
  }, [size]);

  function commit(raw: string): void {
    const result = onCommit(raw, size);
    setState(result.state);
    if (result.commit !== null) setSize(result.commit);
  }

  function step(direction: 'in' | 'out'): void {
    const result = onStep(state, size, direction);
    setState(result.state);
    if (result.commit !== null) setSize(result.commit);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') commit(e.currentTarget.value);
    else if (e.key === 'ArrowUp') { e.preventDefault(); step('in'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step('out'); }
  }

  return (
    <SettingRow label={FONT_COPY.terminalSizeLabel} hint={FONT_COPY.terminalSizeHint} htmlFor={id}>
      <div className="flex items-center gap-2">
        <StepButton label="Decrease terminal font size" glyph="−" onPress={() => step('out')} />
        <input
          id={id}
          type="number"
          min={TERMINAL_FONT_SIZE.min}
          max={TERMINAL_FONT_SIZE.max}
          step={TERMINAL_FONT_SIZE.step}
          value={state.draft}
          data-testid={FONT_TEST_IDS.terminalSizeInput}
          onChange={(e) => setState(onInput(e.target.value).state)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={handleKeyDown}
          className={`${NUMBER_FIELD_CLASS} ${HIDE_NATIVE_SPINNER_CLASS}`}
        />
        <StepButton label="Increase terminal font size" glyph="+" onPress={() => step('in')} />
        <span className="text-[13px] text-[--text-muted]">{FONT_COPY.terminalSizeUnit}</span>
      </div>
    </SettingRow>
  );
}
