import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { RemoteWorkspace } from '@renderer/p2p/remote-workspace';
import type { Result } from '@shared/p2p-contract';
import { PROJECT_SETTINGS_COPY as COPY, PROJECT_SETTINGS_TESTIDS as TESTIDS } from '@renderer/project-settings-contract';
import { SettingRow } from './settings/primitives';

export interface RemoteProjectSettingsProps {
  readonly remote: RemoteWorkspace;
  readonly projectId: number;
  readonly projectName: string;
}

type AgentSettings = Result<'workspace.agentSettings'>;
type SettingsState =
  | { status: 'loading' }
  | { status: 'load-error' }
  | { status: 'ready'; settings: AgentSettings; feedback: 'idle' | 'saved' | 'save-error' }
  | { status: 'saving'; settings: AgentSettings; pending: string | null };

interface SettingsSession {
  remote: RemoteWorkspace;
  projectId: number;
  busy: boolean;
}

const INHERIT = 'inherit:';
const LOADING: SettingsState = { status: 'loading' };

function agentValue(name: string | null): string {
  return name === null ? INHERIT : `profile:${name}`;
}

/** Settings surface limited to remote default-agent selection. */
export function RemoteProjectSettings({ remote, projectId, projectName }: RemoteProjectSettingsProps): ReactElement | null {
  const id = useId();
  const sessionRef = useRef<SettingsSession | null>(null);
  const [loaded, setLoaded] = useState<{ session: SettingsSession; state: SettingsState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const session = loaded?.session;
  const state = loaded && loaded.session.remote === remote && loaded.session.projectId === projectId ? loaded.state : LOADING;

  useEffect(() => {
    const current = { remote, projectId, busy: false };
    sessionRef.current = current;
    setLoaded({ session: current, state: LOADING });
    async function load() {
      try {
        const settings = await remote.call('workspace.agentSettings', { projectId });
        if (sessionRef.current === current) setLoaded({ session: current, state: { status: 'ready', settings, feedback: 'idle' } });
      } catch {
        if (sessionRef.current === current) setLoaded({ session: current, state: { status: 'load-error' } });
      }
    }
    void load();
    return () => { sessionRef.current = null; };
  }, [remote, projectId, attempt]);

  async function choose(value: string) {
    if (!session || sessionRef.current !== session || session.busy || state.status !== 'ready') return;
    const { settings } = state;
    if (settings.hasCustomCommand) return;
    const pending = value === INHERIT ? null : settings.choices.find((name) => agentValue(name) === value);
    if (pending === undefined || pending === settings.defaultAgent) return;
    session.busy = true;
    setLoaded({ session, state: { status: 'saving', settings, pending } });
    try {
      const confirmed = await remote.call('workspace.setDefaultAgent', { projectId, defaultAgent: pending });
      if (sessionRef.current === session) setLoaded({ session, state: { status: 'ready', settings: confirmed, feedback: 'saved' } });
    } catch {
      if (sessionRef.current === session) setLoaded({ session, state: { status: 'ready', settings, feedback: 'save-error' } });
    } finally {
      session.busy = false;
    }
  }

  const settings = state.status === 'ready' || state.status === 'saving' ? state.settings : null;
  const saved = settings?.defaultAgent ?? null;
  const choices = settings ? [...new Set(settings.choices)] : [];
  const missing = saved !== null && !choices.includes(saved);
  const legacy = settings?.hasCustomCommand === true;
  return <div className="min-w-0 space-y-5 p-4 sm:p-5" data-testid={TESTIDS.panel}>
    <h3 className="break-words text-base font-semibold text-[--text]" data-testid={TESTIDS.projectName}>{projectName}</h3>
    {settings && <p id={`${id}-notice`} data-testid={legacy ? TESTIDS.legacyNotice : TESTIDS.notice}
      className={`text-sm leading-relaxed ${legacy ? 'text-[--hue-orange-text]' : 'text-[--text-muted]'}`}>
      {legacy
        ? 'This project uses custom launch commands. Change its default agent on the host to avoid replacing those commands remotely.'
        : COPY.nextLaunchNotice}
    </p>}
    <SettingRow label={COPY.defaultAgentLabel} htmlFor={id}>
      <select id={id}
        value={agentValue(state.status === 'saving' ? state.pending : saved)}
        disabled={state.status !== 'ready' || legacy}
        aria-busy={state.status === 'saving'}
        aria-describedby={settings ? `${id}-notice` : undefined}
        className="min-h-11 w-full min-w-0 rounded-lg border border-[--border] bg-[--surface-field] px-3 text-base text-[--text] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] disabled:opacity-50"
        data-testid={TESTIDS.defaultAgent}
        onChange={(event) => void choose(event.currentTarget.value)}>
        <option value={INHERIT}>{settings ? COPY.globalDefault : state.status === 'load-error' ? COPY.loadFailed : COPY.loading}</option>
        {missing && <option value={agentValue(saved)} disabled>{COPY.unavailableProfile(saved)}</option>}
        {choices.map((name) => <option key={name} value={agentValue(name)}>{name}</option>)}
      </select>
    </SettingRow>
    {state.status === 'load-error' && <>
      <p role="alert" className="text-sm text-[--danger]" data-testid={TESTIDS.error}>
        {COPY.loadFailed}. Check that the host is connected and supports remote project settings.
      </p>
      <button type="button" data-testid={TESTIDS.retry} onClick={() => setAttempt((previous) => previous + 1)}
        className="min-h-11 rounded-lg border border-[--border] px-3 text-sm text-[--text] hover:bg-[--surface-hover] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]">
        {COPY.retry}
      </button>
    </>}
    {state.status === 'loading' && <p role="status" data-testid={TESTIDS.loading} className="text-sm text-[--text-muted]">{COPY.loading}</p>}
    {state.status === 'saving' && <p role="status" data-testid={TESTIDS.status} className="text-sm text-[--text-muted]">
      {COPY.saving} Current saved default: {saved ?? COPY.globalDefault}
    </p>}
    {state.status === 'ready' && state.feedback === 'saved' && <p role="status" data-testid={TESTIDS.status} className="text-sm text-[--text-muted]">{COPY.saved}</p>}
    {state.status === 'ready' && state.feedback === 'save-error' && <p role="alert" data-testid={TESTIDS.error} className="text-sm text-[--danger]">
      {COPY.saveFailed}. Choose again to retry.
    </p>}
  </div>;
}
