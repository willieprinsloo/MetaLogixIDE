/**
 * Read-only "From app settings" section of the project Env tab: the saved
 * app-wide variables with masked values, each with reveal and copy, an
 * "Overridden by this project" marker and a button to Settings → Environment.
 */
import type { InheritedEnvRow } from '@renderer/app-env-inherited';
import type { AppEnvLoad } from '@renderer/hooks/useAppEnv';
import type { RevealState } from '@renderer/hooks/useRevealState';
import { ENV_COPY, ENV_TESTIDS } from '@renderer/project-env-copy';
import { ENV_FOCUS_RING, EnvValueField } from './EnvValueField';

interface Props {
  rows: InheritedEnvRow[];
  load: AppEnvLoad;
  reveal: RevealState;
  onCopy: (value: string) => void;
  onOpenAppEnv: () => void;
}

interface RowProps {
  row: InheritedEnvRow;
  n: number;
  reveal: RevealState;
  onCopy: (value: string) => void;
}

const TITLE_ID = 'project-env-inherited-title';

function InheritedRow({ row, n, reveal, onCopy }: RowProps) {
  const key = `app:${row.name}`;
  return (
    <li className="space-y-0.5" data-testid={ENV_TESTIDS.inheritedRow}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
        <span
          className="min-w-0 truncate px-2.5 font-mono text-sm text-[--text-muted] sm:w-[38%] sm:flex-none"
          title={row.name}
          data-testid={ENV_TESTIDS.inheritedName}
        >
          {row.name}
        </span>
        <EnvValueField
          value={row.value}
          labels={{
            value: ENV_COPY.inheritedValueLabel(n),
            reveal: ENV_COPY.inheritedRevealLabel(n),
            hide: ENV_COPY.inheritedHideLabel(n),
            copy: ENV_COPY.inheritedCopyLabel(n),
          }}
          revealed={reveal.isRevealed(key)}
          onToggle={() => reveal.toggle(key)}
          onCopy={() => onCopy(row.value)}
          testId={ENV_TESTIDS.inheritedValue}
        />
      </div>
      {row.overridden && (
        <p
          className="px-2.5 text-xs text-[--text-muted]"
          data-testid={ENV_TESTIDS.inheritedOverridden}
        >
          {ENV_COPY.inheritedOverridden}
        </p>
      )}
    </li>
  );
}

/**
 * The inherited list, recessive below the editable rows. `rows` come from the
 * saved app-wide map; `reveal` keys them as `app:<name>` and `onCopy` gets the
 * raw value. The empty line shows only once `load` is ready.
 */
export function InheritedEnvList({ rows, load, reveal, onCopy, onOpenAppEnv }: Props) {
  return (
    <section
      aria-labelledby={TITLE_ID}
      className="space-y-3 pt-2"
      data-testid={ENV_TESTIDS.inherited}
    >
      <h3
        id={TITLE_ID}
        className="text-xs font-semibold uppercase tracking-[0.05em] text-[--text-muted]"
      >
        {ENV_COPY.inheritedTitle}
      </h3>
      {load === 'ready' && rows.length === 0 && (
        <p className="text-sm text-[--text-muted]" data-testid={ENV_TESTIDS.inheritedEmpty}>
          {ENV_COPY.inheritedEmpty}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="space-y-1.5">
          {rows.map((row, i) => (
            <InheritedRow key={row.name} row={row} n={i + 1} reveal={reveal} onCopy={onCopy} />
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onOpenAppEnv}
        className={`text-sm px-3 py-1.5 rounded-md border border-[--border] text-[--text] hover:bg-[--panel] ${ENV_FOCUS_RING}`}
        data-testid={ENV_TESTIDS.openAppEnv}
      >
        {ENV_COPY.openAppEnv}
      </button>
    </section>
  );
}
