/**
 * Masked env value field shared by both env editors and the inherited list:
 * a password-style input that shows its value only while `revealed`, then a
 * reveal toggle and a copy button. It holds no state; reveal, copy and edits
 * are the caller's.
 */
import { Tooltip } from '@renderer/components/Tooltip';
import { ENV_COPY, ENV_TESTIDS } from '@renderer/project-env-copy';

/** Accessible names for one row's value input, reveal toggle (both states) and copy button. */
export interface EnvValueLabels {
  value: string;
  reveal: string;
  hide: string;
  copy: string;
}

interface Props {
  value: string;
  labels: EnvValueLabels;
  revealed: boolean;
  onToggle: () => void;
  onCopy: () => void;
  onChange?: (value: string) => void;
  reasonId?: string;
  testId: string;
}

/** Keyboard focus ring shared by every env editor control. */
export const ENV_FOCUS_RING =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]';

/** Input chrome shared by the editable name and value inputs; add a border colour. */
export const ENV_INPUT_CLASS =
  'w-full min-w-0 font-mono bg-[--panel] text-[--text] border rounded-md px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[--accent]/60';

/** Tertiary icon-only button used for reveal, copy and remove. */
export const ENV_ICON_BUTTON = `shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-[--text-muted] hover:bg-[--panel] disabled:opacity-40 disabled:pointer-events-none ${ENV_FOCUS_RING}`;

/** Attributes that keep the browser from rewriting env names and values as they are typed. */
export const ENV_RAW_TEXT = {
  spellCheck: false,
  autoCapitalize: 'off',
  autoCorrect: 'off',
} as const;

const ROW_BUTTON = `${ENV_ICON_BUTTON} hover:text-[--text]`;

const READONLY_INPUT_CLASS =
  'w-full min-w-0 font-mono bg-transparent text-[--text-muted] border border-transparent rounded-md px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[--accent]/60';

function inputClass(editable: boolean, bad: boolean): string {
  if (!editable) return READONLY_INPUT_CLASS;
  return `${ENV_INPUT_CLASS} ${bad ? 'border-[--danger]' : 'border-[--border]'}`;
}

/**
 * One masked value with its reveal and copy buttons, in that DOM order. The
 * input is `type=password` until `revealed`; without `onChange` it is
 * read-only. `reasonId` marks it invalid and points at the reason text. The
 * toggle's label switches between `labels.reveal` and `labels.hide` and never
 * carries `aria-pressed`; copy is disabled while the value is empty. A
 * read-only input is skipped by Tab, leaving its two buttons.
 */
export function EnvValueField({
  value,
  labels,
  revealed,
  onToggle,
  onCopy,
  onChange,
  reasonId,
  testId,
}: Props) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <input
        type={revealed ? 'text' : 'password'}
        value={value}
        readOnly={!onChange}
        tabIndex={onChange ? undefined : -1}
        onChange={onChange && ((e) => onChange(e.target.value))}
        aria-label={labels.value}
        aria-invalid={reasonId ? true : undefined}
        aria-describedby={reasonId}
        autoComplete="off"
        {...ENV_RAW_TEXT}
        className={`flex-1 ${inputClass(Boolean(onChange), Boolean(reasonId))}`}
        data-testid={testId}
      />
      <EnvRowButtons
        value={value}
        labels={labels}
        revealed={revealed}
        onToggle={onToggle}
        onCopy={onCopy}
      />
    </div>
  );
}

type ButtonsProps = Pick<Props, 'value' | 'labels' | 'revealed' | 'onToggle' | 'onCopy'>;

function EnvRowButtons({ value, labels, revealed, onToggle, onCopy }: ButtonsProps) {
  return (
    <>
      <Tooltip label={revealed ? ENV_COPY.hideTooltip : ENV_COPY.revealTooltip} focusable>
        <button
          type="button"
          onClick={onToggle}
          aria-label={revealed ? labels.hide : labels.reveal}
          className={ROW_BUTTON}
          data-testid={ENV_TESTIDS.reveal}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </Tooltip>
      <Tooltip label={ENV_COPY.copyTooltip} focusable>
        <button
          type="button"
          onClick={onCopy}
          disabled={value === ''}
          aria-label={labels.copy}
          className={ROW_BUTTON}
          data-testid={ENV_TESTIDS.copy}
        >
          <CopyIcon />
        </button>
      </Tooltip>
    </>
  );
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function EyeIcon() {
  return (
    <Icon>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

function EyeOffIcon() {
  return (
    <Icon>
      <path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20" />
    </Icon>
  );
}

function CopyIcon() {
  return (
    <Icon>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  );
}
