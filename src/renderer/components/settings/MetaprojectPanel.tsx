/** Existing application-settings entry for Metaproject account and origin controls. */
import { useState } from 'react';
import { parseMetaprojectOrigin, type MetaprojectSessionSnapshot } from '@shared/metaproject-contract';
import { Header } from '@renderer/components/settings/primitives';
import { failureCopy, mpButton, mpInput } from '@renderer/metaproject/messages';
import { AccountStatus, useMetaprojectSession, useSignInIntent } from '@renderer/metaproject/session';

/** Shows one shared account and changes origin only through the dedicated account transition. */
export function MetaprojectPanel() {
  const { snapshot } = useMetaprojectSession();
  const signIn = useSignInIntent('settings');
  return <div className="space-y-6">
    <Header title="Metaproject" subtitle="One IDE sign-in for Board, Chat and project assignments." />
    <div className="space-y-3 text-sm">
      <AccountStatus onSignIn={() => signIn('Metaproject Settings')} />
      {snapshot && <AccountControls snapshot={snapshot} />}
    </div>
    <p className="text-xs text-[--text-muted]">Use Project Settings to assign a folder. Open in Browser uses the browser’s own sign-in.</p>
  </div>;
}

function AccountControls({ snapshot }: { snapshot: MetaprojectSessionSnapshot }) {
  const { command, current } = useMetaprojectSession();
  const [draft, setDraft] = useState<{ value: string; from: string }>();
  const [confirm, setConfirm] = useState<{ origin: string; epoch: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const origin = snapshot.configuredOrigin;
  const text = draft?.from === origin ? draft.value : origin;
  const pending = confirm?.epoch === snapshot.epoch ? confirm : undefined;
  const maySignOut = snapshot.phase === 'signed-in' || (snapshot.phase === 'signed-out' && !!snapshot.warning);
  const transitioning = snapshot.phase === 'restoring' || snapshot.phase === 'signing-in';

  async function save(newOrigin: string, epoch: number) {
    if (current()?.epoch !== epoch) return;
    setConfirm(undefined); setError(null); setBusy(true);
    const message = await command('metaproject:session-origin', { epoch, origin: newOrigin });
    setError(message); setBusy(false);
    if (!message) setDraft(undefined);
  }

  return <div className="space-y-3">
    {maySignOut && <button className={mpButton} disabled={busy} onClick={async () => {
      setBusy(true); setError(await command('metaproject:session-logout', { epoch: snapshot.epoch })); setBusy(false);
    }}>{snapshot.phase === 'signed-in' ? 'Sign out and forget' : 'Retry sign-out'}</button>}
    <form className="space-y-2" onSubmit={(event) => {
      event.preventDefault(); setError(null);
      const validated = parseMetaprojectOrigin(text, true);
      if (!validated) { setError('Enter an HTTPS origin without a path, query, or credentials. HTTP is only supported on literal loopback.'); return; }
      if (validated === snapshot.origin) { setDraft(undefined); return; }
      setConfirm({ origin: validated, epoch: snapshot.epoch });
    }}>
      <label className="block">Service origin<input className={mpInput} maxLength={2048} disabled={busy || transitioning}
        data-testid="metaproject-base-url" value={text} onChange={(event) => { setConfirm(undefined); setDraft({ from: origin, value: event.target.value }); }} /></label>
      <p className="text-xs text-[--text-muted]">Use the root HTTPS address of your Metaproject service; do not include a project path.</p>
      <button className={mpButton} disabled={busy || transitioning || !!pending} type="submit">Save service origin</button>
    </form>
    {pending && <div className="space-y-2" role="group" aria-label="Confirm service origin change">
      <p className="break-words">Switch to {pending.origin}? This signs you out and forgets remembered sign-in. Existing assignments are not moved to the new origin.</p>
      <div className="flex flex-wrap gap-2">
        <button className={mpButton} onClick={() => setConfirm(undefined)}>Cancel origin change</button>
        <button className={mpButton} onClick={() => void save(pending.origin, pending.epoch)}>Switch origin</button>
      </div>
    </div>}
    {error && <p role="alert">{error}</p>}
    {!snapshot.origin && !error && snapshot.phase !== 'signed-out' && <p>{failureCopy['invalid-origin']}</p>}
  </div>;
}
