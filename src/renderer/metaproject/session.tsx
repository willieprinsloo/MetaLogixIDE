/** Observes main's account state and owns the single, cancellable IDE sign-in prompt. */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '@renderer/api';
import { ModalFrame } from '@renderer/components/ModalFrame';
import type { MetaprojectIpc, MetaprojectSessionSnapshot } from '@shared/metaproject-contract';
import { failureCopy, mpButton, mpInput, persistenceCopy } from './messages';

type SignedIn = Extract<MetaprojectSessionSnapshot, { phase: 'signed-in' }>;
type Resume = (snapshot: SignedIn) => void;
type Prompt = { label: string; resume?: Resume; onCancel?: () => void; opener: HTMLElement | null; attemptId?: string; origin: string };
type PromptState = Pick<ReturnType<typeof useSnapshot>, 'current' | 'accept' | 'version'>;
type AccountCommand = 'metaproject:session-origin' | 'metaproject:session-logout' | 'metaproject:session-retry';
type SessionContext = {
  snapshot: MetaprojectSessionSnapshot | null;
  statusError: boolean;
  chatGeneration: number;
  refresh: () => void;
  promptOpen: boolean;
  request: (label: string, resume?: Resume, onCancel?: () => void) => (() => void) | undefined;
  current: () => MetaprojectSessionSnapshot | null;
  command: <C extends AccountCommand>(channel: C, request: MetaprojectIpc[C]['request']) => Promise<string | null>;
};
const Session = createContext<SessionContext | null>(null);

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<MetaprojectSessionSnapshot | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [chatGeneration, bumpChatGeneration] = useState(0);
  const state = useRef<MetaprojectSessionSnapshot | null>(null);
  const version = useRef(0);
  const accept = useCallback((next: MetaprojectSessionSnapshot) => {
    if (!next || typeof next.epoch !== 'number' || (state.current && next.epoch < state.current.epoch)) return;
    const prior = state.current;
    if (prior?.phase === 'signed-in' && !prior.connected && next.phase === 'signed-in' && next.connected && prior.epoch === next.epoch) bumpChatGeneration((n) => n + 1);
    version.current += 1;
    state.current = next;
    setStatusError(false);
    setSnapshot(next);
  }, []);
  const refresh = useCallback(() => {
    const before = version.current;
    void api.invoke('metaproject:session-status', undefined).then((next) => {
      if (version.current === before) accept(next);
    }).catch(() => { if (version.current === before) setStatusError(true); });
  }, [accept]);
  useEffect(() => {
    const off = api.on('metaproject:session-changed', accept);
    refresh();
    return () => { version.current += 1; off(); };
  }, [accept, refresh]);
  const current = useCallback(() => state.current, []);
  return { snapshot, statusError, chatGeneration, current, refresh, accept, version };
}

function useSignInPrompt(account: ReturnType<typeof useSnapshot>) {
  const { current, accept, version, refresh } = account;
  const active = useRef<Prompt | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dismiss = useCallback((entry: Prompt, cancel: boolean) => {
    if (active.current !== entry) return;
    active.current = null;
    setPrompt(null);
    setBusy(false);
    if (cancel && entry.attemptId) {
      const before = version.current;
      void api.invoke('metaproject:session-cancel', { attemptId: entry.attemptId }).then((next) => {
        if (version.current === before) accept(next);
      }).catch(refresh);
    }
    queueMicrotask(() => { if (!active.current && entry.opener?.isConnected) entry.opener.focus(); });
  }, [accept, refresh, version]);

  const request = useCallback((label: string, resume?: Resume, onCancel?: () => void) => {
    const now = current();
    if (now?.phase === 'signed-in') { resume?.(now); return; }
    if (!now?.origin || now.phase !== 'signed-out' || active.current) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry: Prompt = { label, resume, onCancel, opener, origin: now.origin };
    active.current = entry;
    setError(null);
    setPrompt(entry);
    return () => dismiss(entry, true);
  }, [current, dismiss]);

  const submit = (form: HTMLFormElement) => submitSignIn(form, { current, accept, version }, {
    active, dismiss, setBusy, setError,
  });
  return { prompt, request, dismiss, submit, busy, error };
}

type PromptActions = {
  active: { current: Prompt | null }; dismiss: (prompt: Prompt, cancel: boolean) => void;
  setBusy: (busy: boolean) => void; setError: (error: string | null) => void;
};

async function submitSignIn(form: HTMLFormElement, { current, accept, version }: PromptState, { active, dismiss, setBusy, setError }: PromptActions) {
    const entry = active.current;
    const now = current();
    if (!entry || entry.attemptId || now?.phase !== 'signed-out' || now.origin !== entry.origin) return;
    const attemptId = crypto.randomUUID();
    const before = version.current;
    try {
      const pending = loginFromForm(form, attemptId, now.epoch);
      if (!pending) { setError(failureCopy['invalid-input']); return; }
      entry.attemptId = attemptId;
      setBusy(true);
      setError(null);
      const result = await pending;
      if (active.current !== entry) return;
      if (!result.ok) { setError(failureCopy[result.reason]); return; }
      if (version.current === before) accept(result.value);
      const latest = current();
      if (result.value.phase === 'signed-in' && latest?.phase === 'signed-in' && latest.epoch === result.value.epoch && latest.origin === entry.origin) {
        dismiss(entry, false);
        entry.resume?.(latest);
      } else setError(failureCopy.stale);
    } catch { if (active.current === entry) setError(failureCopy.unavailable); }
    finally {
      if (active.current === entry) { entry.attemptId = undefined; setBusy(false); }
    }
}

function loginFromForm(form: HTMLFormElement, attemptId: string, epoch: number) {
  const username = form.querySelector<HTMLInputElement>('input[name="username"]')?.value.trim();
  const input = form.querySelector<HTMLInputElement>('input[name="password"]');
  const password = input?.value;
  if (input) input.value = '';
  if (!username || !password) return null;
  const remember = form.querySelector<HTMLInputElement>('input[name="remember"]')?.checked === true;
  return api.invoke('metaproject:session-login', { attemptId, epoch, username, password, remember });
}

/** Provides one session observer and prompt to the main IDE window, not pop-outs. */
export function MetaprojectSessionProvider({ children }: { children: ReactNode }) {
  const account = useSnapshot();
  const { accept, current, version, snapshot, refresh, statusError, chatGeneration } = account;
  const { prompt, request, dismiss, submit, busy, error } = useSignInPrompt(account);
  useLayoutEffect(() => {
    if (prompt && snapshot?.origin !== prompt.origin) dismiss(prompt, true);
  }, [prompt, snapshot?.origin, dismiss]);
  const command: SessionContext['command'] = async (channel, input) => {
    const before = version.current;
    try {
      const result = await api.invoke(channel, input);
      if (!result.ok) return failureCopy[result.reason];
      if (version.current === before) accept(result.value);
      return null;
    } catch { return failureCopy.unavailable; }
  };
  return <Session.Provider value={{ snapshot, statusError, chatGeneration, refresh, current, command, request, promptOpen: prompt !== null }}>
    <div className="contents" {...(prompt ? { inert: '' } : {})}>{children}</div>
    {prompt && <SignInDialog label={prompt.label} origin={prompt.origin} busy={busy} error={error}
      onCancel={() => { prompt.onCancel?.(); dismiss(prompt, true); }} onSubmit={submit} />}
  </Session.Provider>;
}

/** Reads the current shared account, including a synchronous fence for late IPC replies. */
export function useMetaprojectSession(): SessionContext {
  const session = useContext(Session);
  if (!session) throw new Error('Metaproject session provider missing');
  return session;
}

/** Cancels only this consumer's intent when its target changes or unmounts. */
export function useSignInIntent(scope: string | number | null) {
  const { request } = useMetaprojectSession();
  const cancel = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => () => { cancel.current?.(); cancel.current = undefined; }, [scope]);
  return useCallback((label: string, resume?: Resume, onCancel?: () => void) => {
    const dispose = request(label, resume, onCancel);
    if (dispose) cancel.current = dispose;
  }, [request]);
}

/** Preserves a session-only fallback warning after the shared prompt has closed. */
export function SignedInPersistenceWarning() {
  const { snapshot } = useMetaprojectSession();
  return snapshot?.phase === 'signed-in' && snapshot.warning ? <p role="alert">{persistenceCopy[snapshot.warning]}</p> : null;
}

/** Common status, safe errors and warning/retry controls for protected entry points. */
export function AccountStatus({ onSignIn }: { onSignIn: () => void }) {
  const { snapshot, statusError, refresh, command } = useMetaprojectSession();
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  if (!snapshot) return statusError ? <div role="alert">Unable to load Metaproject status. <button className={mpButton} onClick={refresh}>Retry</button></div> : <p role="status">Loading Metaproject account…</p>;
  if (snapshot.phase === 'restoring' || snapshot.phase === 'signing-in') return <p role="status">{snapshot.phase === 'restoring' ? 'Restoring Metaproject sign-in…' : 'Signing in…'}</p>;
  if (snapshot.phase === 'signed-in') return <div>
    <p role="status">Signed in as {snapshot.actor.display_name || snapshot.actor.username}{snapshot.remembered ? ' · Remembered on this device' : ''}</p>
    {snapshot.warning && <p role="alert">{persistenceCopy[snapshot.warning]}</p>}
  </div>;
  if (snapshot.phase !== 'signed-out') return null;
  return <div className="space-y-2">
    <p role="status">Signed out of Metaproject.</p>
    {!snapshot.origin ? <p>{failureCopy['invalid-origin']}</p> : <>
      {snapshot.reason && snapshot.reason !== 'signed-out' && <p role="alert">{failureCopy[snapshot.reason]}</p>}
      <div className="flex flex-wrap gap-2">
        <button className={mpButton} onClick={onSignIn}>Sign in to Metaproject</button>
        {snapshot.retryRestore && <button className={mpButton} disabled={retrying} onClick={async () => {
          setRetrying(true); setError(await command('metaproject:session-retry', { epoch: snapshot.epoch })); setRetrying(false);
        }}>Retry remembered sign-in</button>}
      </div>
    </>}
    {snapshot.warning && <p role="alert">{persistenceCopy[snapshot.warning]}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

interface SignInDialogProps {
  label: string; origin: string; busy: boolean; error: string | null;
  onCancel: () => void; onSubmit: (form: HTMLFormElement) => Promise<void>;
}

function SignInDialog({ label, origin, busy, error, onCancel, onSubmit }: SignInDialogProps) {
  const form = useRef<HTMLFormElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { form.current?.querySelector('input')?.focus(); }, []);
  useLayoutEffect(() => { if (busy) cancel.current?.focus(); }, [busy]);
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void onSubmit(event.currentTarget); };
  return <ModalFrame testId="metaproject-sign-in" tier="blocking" motion="none" layerClassName="flex items-center justify-center p-4" onDismiss={onCancel}>
    <form ref={form} role="dialog" aria-modal="true" aria-label="Sign in to Metaproject" onSubmit={submit}
      className="modal-sheet w-[400px] max-w-full max-h-full overflow-auto space-y-3 p-5 text-[--text]"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input:enabled,button:enabled')];
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <h2 className="font-semibold">Sign in to Metaproject</h2>
      <p className="break-words text-sm text-[--text-muted]">{label} · {origin}</p>
      <fieldset disabled={busy} className="space-y-3">
        <label className="block text-sm">Username or email<input className={mpInput} name="username" autoComplete="username" required maxLength={254} /></label>
        <label className="block text-sm">Password<input className={mpInput} name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="remember" /> Remember me on this device</label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Signing in…</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={mpButton} onClick={onCancel} ref={cancel}>Cancel</button>
        <button type="submit" className={mpButton} disabled={busy}>Sign in</button>
      </div>
    </form>
  </ModalFrame>;
}
