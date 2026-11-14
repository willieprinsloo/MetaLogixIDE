import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  USAGE_PROVIDER_LABEL,
  USAGE_TESTIDS,
  type ProviderUsage,
  type UsageProvider,
  type UsageWindow,
} from '@shared/usage-contract';
import { useAgentUsage } from '@renderer/hooks/useAgentUsage';
import { PROVIDERS, USAGE_LEVEL_FILL, USAGE_LEVEL_TEXT, formatResetIn, gutterBars, peakWeekly, usageLevel } from '@renderer/usage-format';
import { ICON_SIZE } from './icon-size';

const OPEN_DELAY_MS = 250;

/** Activity-bar AI usage widget: icon plus one weekly bar per signed-in provider, details on hover. */
export function UsageMeter() {
  const { usage, loading, refresh } = useAgentUsage();
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setAnchor({ x: r.right + 8, y: r.bottom });
    }, OPEN_DELAY_MS);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setAnchor(null);
  };

  const bars = gutterBars(usage);
  const peak = peakWeekly(usage);
  const label = peak === null ? 'AI usage' : `AI usage — weekly peak ${Math.round(peak)}%`;

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        data-testid={USAGE_TESTIDS.button}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => refresh(true)}
        className="relative w-11 py-1.5 flex flex-col items-center justify-center gap-1 rounded-[10px] pressable text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover]"
      >
        <SparklesIcon />
        {bars.length > 0 && (
          <span className="flex flex-col gap-[3px] w-7" aria-hidden>
            {bars.map((bar) => (
              <span key={bar.key} className="block h-[3px] w-full rounded-full bg-[--surface-hover] overflow-hidden" data-testid={USAGE_TESTIDS.meter(bar.key)}>
                <span
                  className={`block h-full rounded-full ${USAGE_LEVEL_FILL[usageLevel(bar.weekly.usedPercent)]}`}
                  data-level={usageLevel(bar.weekly.usedPercent)}
                  style={{ width: `${bar.weekly.usedPercent}%` }}
                />
              </span>
            ))}
          </span>
        )}
      </button>
      {anchor && createPortal(
        <div
          role="tooltip"
          data-testid={USAGE_TESTIDS.popover}
          className="fixed z-[9999] pointer-events-none select-none w-64 p-3 rounded-lg text-[11px] bg-[--panel-strong] text-[--text] border border-[--border] shadow-lg"
          style={{ left: anchor.x, top: anchor.y, transform: 'translateY(-100%)' }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-[12px]">AI usage limits</span>
            {loading && <span className="text-[--text-muted]">refreshing…</span>}
          </div>
          <div className="flex flex-col gap-3">
            {PROVIDERS.map((p) => <ProviderRows key={p} usage={usage?.[p]} provider={p} />)}
          </div>
          <div className="mt-2 text-[10px] text-[--text-muted]">Click to refresh</div>
        </div>,
        document.body,
      )}
    </>
  );
}

function ProviderRows({ provider, usage }: { provider: UsageProvider; usage: ProviderUsage | undefined }) {
  const title = <div className="font-medium mb-1">{USAGE_PROVIDER_LABEL[provider]}</div>;
  if (!usage) return <div>{title}<div className="text-[--text-muted]">Loading…</div></div>;
  if (usage.status === 'signed-out') return <div>{title}<div className="text-[--text-muted]">Not signed in to the CLI</div></div>;
  if (usage.status === 'error') return <div>{title}<div className="text-[--hue-orange]">{usage.message}{retryText(usage.retryAt)}</div></div>;
  const now = Date.now();
  return (
    <div>
      {title}
      <WindowRow name="Weekly" win={usage.weekly} now={now} />
      {usage.models?.map((m) => <WindowRow key={m.id} name={`Weekly · ${m.label}`} win={m.weekly} now={now} testId={USAGE_TESTIDS.modelRow(provider, m.id)} />)}
      <WindowRow name="5-hour" win={usage.session} now={now} />
      {usage.note && <div className="text-[10px] text-[--hue-orange]">{usage.note}{retryText(usage.retryAt)}</div>}
    </div>
  );
}

/** " — retrying in 9m" while a rate-limit backoff runs. */
function retryText(retryAt: number | undefined): string {
  return retryAt && retryAt > Date.now() ? ` — retrying in ${formatResetIn(retryAt, Date.now())}` : '';
}

function WindowRow({ name, win, now, testId }: { name: string; win: UsageWindow | null; now: number; testId?: string }) {
  if (!win) return null;
  const level = usageLevel(win.usedPercent);
  return (
    <div className="mb-1.5" data-testid={testId}>
      <div className="flex justify-between text-[--text-muted]">
        <span>{name} · <span className={`font-medium ${USAGE_LEVEL_TEXT[level]}`}>{Math.round(win.usedPercent)}%</span></span>
        {win.resetsAt !== null && <span>resets in {formatResetIn(win.resetsAt, now)}</span>}
      </div>
      <div className="mt-0.5 h-1 rounded-full bg-[--surface-hover] overflow-hidden">
        <div className={`h-full rounded-full ${USAGE_LEVEL_FILL[level]}`} style={{ width: `${win.usedPercent}%` }} />
      </div>
    </div>
  );
}

function SparklesIcon() {
  // Two four-point stars — the common "AI" glyph.
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3.5 11.6 8.4 16.5 10 11.6 11.6 10 16.5 8.4 11.6 3.5 10 8.4 8.4z" />
      <path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </svg>
  );
}
