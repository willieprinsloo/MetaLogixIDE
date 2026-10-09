import { useId, type ChangeEvent, type ReactNode } from 'react';

/** Shared Settings panel heading. */
export function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="space-y-1">
      <div className="text-lg font-semibold">{title}</div>
      <div className="text-sm text-[--text-muted]">{subtitle}</div>
    </div>
  );
}

/** Shared Settings label + hint + control stack. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      {hint && <div className="text-xs text-[--text-muted]">{hint}</div>}
      {children}
    </div>
  );
}

interface SectionProps {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}

/** General-board section: a `section` labelled by a muted uppercase `h2` (source text kept as written, so its accessible name is `title`), an optional hint, then its rows. */
export function SettingsSection({ title, hint, children }: SectionProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className="m-0 text-xs font-semibold uppercase tracking-[0.05em] text-[--text-muted]">
          {title}
        </h2>
        {hint && <p className="text-xs text-[--text-muted]">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

interface RowProps {
  readonly label: string;
  readonly hint?: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}

const ROW_LABEL = 'text-[13px] font-medium text-[--text]';

/** Label-left / control-right settings row with a muted hint under the label. Pass `htmlFor` to tie the label to a control by id; controls named another way (radiogroup, `aria-label`) get a plain text label. Wraps rather than overflowing when narrow. */
export function SettingRow({ label, hint, htmlFor, children }: RowProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col">
        {htmlFor ? (
          <label htmlFor={htmlFor} className={ROW_LABEL}>{label}</label>
        ) : (
          <span className={ROW_LABEL}>{label}</span>
        )}
        {hint && <span className="text-xs text-[--text-muted]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Label above a wide control (e.g. palette cards), exposed as a `group` named by the label. */
export function SettingStack({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-2.5">
      <div id={id} className={ROW_LABEL}>{label}</div>
      {children}
    </div>
  );
}

/** Shared visual class for a compact right-aligned number field, reused by `WorkspaceNumber` and `TerminalFontSizeControl` so every Settings number input matches. */
export const NUMBER_FIELD_CLASS =
  'h-[34px] w-[84px] shrink-0 rounded-[9px] bg-[--surface-field] px-2.5 text-right text-[13px] tabular-nums text-[--text] focus:outline-none focus:ring-2 focus:ring-[--accent]/60 focus-visible:rounded-[9px]';

interface NumberProps {
  readonly id: string;
  readonly value: number | null;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
}

/** Compact right-aligned number field for workspace limits; emits finite input clamped to `min..max`, ignores anything else, and renders empty while `value` is null. */
export function WorkspaceNumber({ id, value, min, max, step = 1, onChange }: NumberProps) {
  return (
    <input
      id={id}
      type="number"
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
      }}
      className={NUMBER_FIELD_CLASS}
    />
  );
}

interface SwitchProps {
  readonly label: string;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

/**
 * Settings switch row: visible `label` left, a 38x22 track right. The control is a native
 * checkbox with `role="switch"` stretched transparently over the track so it stays a real click
 * target; `ariaLabel` must contain `label`. State shows by thumb position as well as track colour.
 */
export function Switch({ label, ariaLabel, testId, checked, onChange }: SwitchProps) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4">
      <span className={ROW_LABEL}>{label}</span>
      <span className="relative h-[22px] w-[38px] shrink-0">
        <input
          type="checkbox"
          role="switch"
          aria-label={ariaLabel}
          data-testid={testId}
          checked={checked}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
          className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[11px] bg-[--switch-off] transition-colors peer-checked:bg-[--accent] peer-focus-visible:ring-2 peer-focus-visible:ring-[--accent] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[--panel-strong]"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-[3px] top-[3px] h-4 w-4 rounded-full bg-[--text-muted] transition-transform peer-checked:translate-x-4 peer-checked:bg-[--accent-text]"
        />
      </span>
    </label>
  );
}
