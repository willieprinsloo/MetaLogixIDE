/** Presentational project identity, immediate default selector, and truthful session feedback. */
import { useId, type ReactElement } from 'react';
import type { ProjectDefaultAgentSnapshot } from '@renderer/project-default-agent-store';
import { hasCustomLaunchCommands } from '@renderer/project-default-agent-store';
import { PROJECT_SETTINGS_COPY as COPY, PROJECT_SETTINGS_TESTIDS as TESTIDS } from '@renderer/project-settings-contract';
import { SettingRow } from './settings/primitives';
import { TERMINAL_AGENT_NAME } from '@shared/project-default-agent';

interface Props {
  readonly snapshot: ProjectDefaultAgentSnapshot;
  readonly onChoose: (name: string | null) => void;
  readonly onReplaceCustomCommands: () => void;
  readonly onRetry: () => void;
}

const BUTTON_CLASS = 'min-h-11 rounded-lg border border-[--border] px-3 text-sm text-[--text] hover:bg-[--surface-hover] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] disabled:opacity-50';
const SELECT_CLASS = 'min-h-11 w-full min-w-0 rounded-lg border border-[--border] bg-[--surface-field] px-3 text-base text-[--text] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] disabled:opacity-50';
const GLOBAL_VALUE = 'inherit:';
type ReadySnapshot = Extract<ProjectDefaultAgentSnapshot, { status: 'ready' }>;

function SessionFeedback({ snapshot }: { readonly snapshot: ReadySnapshot }) {
  const feedback = snapshot.feedback;
  if (feedback.status === 'error') {
    return <div role="alert" className="text-sm text-[--danger]" data-testid={TESTIDS.error}>
      {COPY.saveFailed}: {feedback.message} Choose again to retry.
    </div>;
  }
  return <div role="status" aria-live="polite" className="text-sm text-[--text-muted]" data-testid={TESTIDS.status}>
    {feedback.status === 'saving' && <>
      <div>{COPY.saving}</div>
      <div>Current saved default: {snapshot.confirmedName ?? COPY.globalDefault}</div>
    </>}
    {feedback.status === 'saved' && COPY.saved}
  </div>;
}

function ReadyControl({ snapshot, onChoose, onReplaceCustomCommands }: Omit<Props, 'onRetry'> & { readonly snapshot: ReadySnapshot }) {
  const id = useId();
  const legacy = hasCustomLaunchCommands(snapshot.project);
  // The built-in Terminal choice is offered unless a CLI profile already uses that name.
  const builtInTerminal = !snapshot.profiles.some((profile) => profile.name === TERMINAL_AGENT_NAME);
  const missing = snapshot.confirmedName !== null && !(builtInTerminal && snapshot.confirmedName === TERMINAL_AGENT_NAME)
    && !snapshot.profiles.some((profile) => profile.name === snapshot.confirmedName);
  const saving = snapshot.feedback.status === 'saving';
  const value = snapshot.pendingName === null ? GLOBAL_VALUE : `profile:${snapshot.pendingName}`;
  const describedBy = `${id}-notice${missing ? ` ${id}-missing` : ''}`;
  return <>
    <p id={`${id}-notice`} data-testid={legacy ? TESTIDS.legacyNotice : TESTIDS.notice} className={`text-sm leading-relaxed ${legacy ? 'text-[--hue-orange-text]' : 'text-[--text-muted]'}`}>
      {legacy ? COPY.customCommandsNotice : COPY.nextLaunchNotice}
    </p>
    {legacy && <p data-testid={TESTIDS.notice} className="text-sm leading-relaxed text-[--text-muted]">{COPY.nextLaunchNotice}</p>}
    <SettingRow label={COPY.defaultAgentLabel} htmlFor={id}>
      <select id={id} value={value} disabled={saving} aria-describedby={describedBy} aria-busy={saving}
        className={SELECT_CLASS} data-testid={TESTIDS.defaultAgent} onChange={(event) => {
          if (event.target.value === GLOBAL_VALUE) { onChoose(null); return; }
          if (builtInTerminal && event.target.value === `profile:${TERMINAL_AGENT_NAME}`) { onChoose(TERMINAL_AGENT_NAME); return; }
          const profile = snapshot.profiles.find((item) => `profile:${item.name}` === event.target.value);
          if (profile) onChoose(profile.name);
        }}>
        <option value={GLOBAL_VALUE}>{COPY.globalDefault}</option>
        {missing && <option value={`profile:${snapshot.confirmedName}`} disabled>{COPY.unavailableProfile(snapshot.confirmedName ?? '')}</option>}
        {builtInTerminal && <option value={`profile:${TERMINAL_AGENT_NAME}`}>{COPY.terminalAgent}</option>}
        {snapshot.profiles.map((profile) => <option key={profile.name} value={`profile:${profile.name}`}>{profile.name}</option>)}
      </select>
    </SettingRow>
    {missing && <div id={`${id}-missing`} data-testid={TESTIDS.missingProfile} className="space-y-2 text-sm text-[--text-muted]">
      <p>{COPY.missingProfileNotice(snapshot.confirmedName ?? '')}</p>
      {!legacy && <p>{COPY.missingProfileFallback}</p>}
    </div>}
    {legacy && !missing && <button type="button" onClick={onReplaceCustomCommands} disabled={saving}
      className={BUTTON_CLASS} data-testid={TESTIDS.replaceCustomCommands}>{COPY.replaceCustomCommands}</button>}
    <SessionFeedback snapshot={snapshot} />
  </>;
}

function UnloadedControl({ snapshot, onRetry }: Pick<Props, 'snapshot' | 'onRetry'>) {
  const id = useId();
  return <>
    <SettingRow label={COPY.defaultAgentLabel} htmlFor={id}>
      <select id={id} disabled className={SELECT_CLASS} data-testid={TESTIDS.defaultAgent}>
        <option>{snapshot.status === 'error' ? COPY.loadFailed : COPY.loading}</option>
      </select>
    </SettingRow>
    {snapshot.status === 'loading' && <p role="status" data-testid={TESTIDS.loading} className="text-sm text-[--text-muted]">{COPY.loading}</p>}
    {snapshot.status === 'error' && <>
      <p role="alert" data-testid={TESTIDS.error} className="text-sm text-[--danger]">{COPY.loadFailed}: {snapshot.message}</p>
      <button type="button" onClick={onRetry} className={BUTTON_CLASS} data-testid={TESTIDS.retry}>{COPY.retry}</button>
    </>}
  </>;
}

/** Renders session state without fetching, persisting, or changing active projects. */
export function ProjectSettingsPanel({ snapshot, onChoose, onReplaceCustomCommands, onRetry }: Props): ReactElement {
  const identity = snapshot.status === 'ready' ? snapshot.project : snapshot.target;
  return <div className="min-w-0 space-y-5 p-4 sm:p-5" data-testid={TESTIDS.panel}>
    <div className="min-w-0 space-y-1">
      <h3 className="break-words text-base font-semibold text-[--text]" data-testid={TESTIDS.projectName}>{identity.name}</h3>
      <p className="break-all text-sm text-[--text-muted]" data-testid={TESTIDS.projectPath}>{identity.path}</p>
    </div>
    {snapshot.status === 'ready'
      ? <ReadyControl snapshot={snapshot} onChoose={onChoose} onReplaceCustomCommands={onReplaceCustomCommands} />
      : <UnloadedControl snapshot={snapshot} onRetry={onRetry} />}
  </div>;
}
