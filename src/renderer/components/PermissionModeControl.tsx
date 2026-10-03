import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from '@shared/claude-permission-mode';
import { PERMISSION_MODE_COPY, PERMISSION_MODE_TEST_IDS } from '@renderer/permission-mode-copy';

interface Props {
  mode: ClaudePermissionMode | null;
  disabled?: boolean;
  onChange: (mode: ClaudePermissionMode) => void;
}

const TEST_IDS: Record<ClaudePermissionMode, string> = {
  auto: PERMISSION_MODE_TEST_IDS.settingsAuto,
  bypass: PERMISSION_MODE_TEST_IDS.settingsBypass,
};

/**
 * Two-segment Auto / Bypass toggle for Settings → Launch commands, in the
 * Appearance control's style. The segment matching `mode` is `aria-pressed`;
 * clicking it again does nothing, clicking the other calls `onChange(mode)`.
 * `disabled` locks both segments while a change is in flight.
 */
export function PermissionModeControl({ mode, disabled = false, onChange }: Props) {
  return (
    <div className="flex gap-2" role="group" aria-label={PERMISSION_MODE_COPY.settingsLabel}>
      {CLAUDE_PERMISSION_MODES.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          disabled={disabled}
          onClick={() => { if (mode !== m) onChange(m); }}
          className={`px-3 py-1.5 rounded-md text-sm border disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-1 focus-visible:ring-offset-[--panel-strong] ${
            mode === m
              ? 'bg-[--accent] text-white border-transparent'
              : 'bg-[--panel] border-[--border] hover:bg-[--panel-strong]'
          }`}
          data-testid={TEST_IDS[m]}
        >
          {PERMISSION_MODE_COPY[m].label}
        </button>
      ))}
    </div>
  );
}
