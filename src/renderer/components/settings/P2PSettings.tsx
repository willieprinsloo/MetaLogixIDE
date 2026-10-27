import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { ModalFrame } from '@renderer/components/ModalFrame';
import { Header, SettingsSection, Switch } from '@renderer/components/settings/primitives';
import { useFleet } from '@renderer/p2p/useFleet';
import type { P2PSettings as P2PSettingsPatch, P2PSettingsView } from '@shared/p2p-contract';

const INPUT_CLASS =
  'bg-[--surface-field] text-[--text] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[--accent]/60';
const BUTTON_CLASS =
  'rounded-lg border border-[--border] bg-[--panel] px-3 py-1.5 text-sm text-[--text] hover:bg-[--panel-strong] focus-visible:ring-2 focus-visible:ring-[--accent]';

const DEFAULT_RELAY_URL = 'remote.metalogix.solutions';
const DEFAULT_RELAY_PORT = '7100';

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function PairModal({ onClose }: { onClose: () => void }) {
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // The code is minted by the relay on first connect; until then main answers relay_not_ready, so keep trying briefly.
    const attempt = (n: number) => {
      api.invoke('p2p:pair-generate-code', undefined).then(
        (res) => { if (alive) { setPair(res); setError(null); } },
        (e: unknown) => {
          if (!alive) return;
          const msg = e instanceof Error ? e.message : String(e);
          if (/relay_not_ready/.test(msg) && n < 15) retry = setTimeout(() => attempt(n + 1), 1000);
          else setError(/relay_not_ready/.test(msg) ? 'Not connected to the relay yet. Check the relay address and try again.' : /serve_disabled/.test(msg) ? 'Turn on "Serve this machine" first.' : msg);
        },
      );
    };
    attempt(0);
    return () => { alive = false; if (retry) clearTimeout(retry); };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const remaining = pair ? pair.expiresAt - now : 0;
  return (
    <ModalFrame testId="p2p-pair-modal" tier="modal" motion="fade" layerClassName="flex items-center justify-center p-4" onDismiss={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="p2p-pair-title"
        className="modal-panel modal-sheet w-[480px] max-w-full space-y-4 px-5 py-5"
      >
        <h2 id="p2p-pair-title" className="text-lg font-semibold text-[--text]">Pair a new machine</h2>
        <p className="text-sm text-[--modal-text-muted]">
          On the other machine, open Settings → P2P, choose Join a fleet and enter this code. It stays valid while this window is open.
        </p>
        {error && <div role="alert" className="text-sm text-[--danger,#e5484d]">{error}</div>}
        {!pair && !error && <div className="text-sm opacity-60">Generating…</div>}
        {pair && (
          <>
            <div className="text-xs text-[--text-muted]">Your pair code</div>
            <div data-testid="p2p-pair-code" className="select-text rounded-lg bg-[--surface-field] px-4 py-3 text-center font-mono text-lg tracking-widest">
              {pair.code}
            </div>
            <div className="text-xs text-[--text-muted]" data-testid="p2p-pair-expiry">
              {remaining > 0 ? `Expires in ${formatRemaining(remaining)}` : 'Code expired. Close and generate a new one.'}
            </div>
          </>
        )}
        <div className="flex justify-end">
          <button type="button" className={BUTTON_CLASS} onClick={onClose}>Close</button>
        </div>
      </div>
    </ModalFrame>
  );
}

/** Enter another machine's pair code to join its fleet. */
function JoinFleet({ onJoined }: { onJoined: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const join = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.invoke('p2p:pair-redeem-code', { code: code.trim() });
      if (r.ok) { setMsg({ ok: true, text: 'Paired.' }); setCode(''); onJoined(); }
      else setMsg({ ok: false, text: `Could not pair: ${r.error}` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          aria-label="Pair code of the other machine"
          data-testid="p2p-join-code"
          className={`${INPUT_CLASS} w-48 font-mono`}
          placeholder="Pair code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && code.trim() && !busy) void join(); }}
        />
        <button type="button" className={BUTTON_CLASS} disabled={busy || !code.trim()} onClick={() => void join()}>Join a fleet</button>
      </div>
      {msg && <div role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-[--text-muted]' : 'text-[--danger]'}`}>{msg.text}</div>}
    </div>
  );
}

/** Settings → P2P: device identity, relay endpoint, serve toggle, pairing and fleet members. */
export function P2PSettings() {
  const [settings, setSettings] = useState<P2PSettingsView | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [relayPort, setRelayPort] = useState('');
  const [serveEnabled, setServeEnabled] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const { machines, error: fleetError, refresh } = useFleet();

  useEffect(() => {
    let alive = true;
    api.invoke('p2p:settings-get', undefined).then(
      (s) => {
        if (!alive) return;
        setSettings(s);
        setDeviceName(s.deviceName);
        setRelayUrl(s.relayUrl);
        setRelayPort(String(s.relayPort));
        setServeEnabled(s.serveEnabled);
      },
      (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { alive = false; };
  }, []);

  const save = useCallback(async (patch: Partial<P2PSettingsPatch>) => {
    try {
      await api.invoke('p2p:settings-set', patch);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const saveDeviceName = () => {
    if (!settings) return;
    const name = deviceName.trim();
    if (!name) { setDeviceName(settings.deviceName); return; }
    setDeviceName(name);
    if (name === settings.deviceName) return;
    setSettings((prev) => (prev ? { ...prev, deviceName: name } : prev));
    void save({ deviceName: name });
  };

  const saveRelayUrl = () => {
    if (!settings) return;
    const url = relayUrl.trim();
    if (!url) { setRelayUrl(settings.relayUrl); return; }
    setRelayUrl(url);
    if (url === settings.relayUrl) return;
    setSettings((prev) => (prev ? { ...prev, relayUrl: url } : prev));
    void save({ relayUrl: url });
  };

  const saveRelayPort = () => {
    const n = Number.parseInt(relayPort, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      setRelayPort(settings ? String(settings.relayPort) : '');
      return;
    }
    setSettings((prev) => (prev ? { ...prev, relayPort: n } : prev));
    void save({ relayPort: n });
  };

  const revoke = async (deviceId: string, name: string) => {
    if (!window.confirm(`Revoke pairing with ${name}? You'll need a fresh pairing code to reconnect.`)) return;
    setRevokingId(deviceId);
    try {
      await api.invoke('p2p:revoke-device', { deviceId });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevokingId(null);
    }
  };

  const members = machines.filter((m) => !m.self);

  return (
    <div className="space-y-6">
      <Header title="P2P" subtitle="Reach your other machines directly, through a signalling relay. Pair machines once; they then appear in the sidebar." />
      {error && <div role="alert" className="text-sm text-[--danger,#e5484d]">{error}</div>}

      <SettingsSection title="Device">
        <div className="space-y-1">
          <label htmlFor="p2p-device-name" className="text-[13px] font-medium">Device name</label>
          <input
            id="p2p-device-name"
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            onBlur={saveDeviceName}
            className={`${INPUT_CLASS} w-full`}
          />
        </div>
        <div className="space-y-1">
          <div className="text-[13px] font-medium">Device fingerprint</div>
          <div data-testid="p2p-fingerprint" className="select-text font-mono text-sm text-[--text-muted]">
            {settings?.deviceFingerprint ?? ''}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Relay">
        <div className="flex gap-2">
          <div className="flex-1 space-y-1">
            <label htmlFor="p2p-relay-url" className="text-[13px] font-medium">Relay URL</label>
            <input
              id="p2p-relay-url"
              type="text"
              value={relayUrl}
              placeholder={DEFAULT_RELAY_URL}
              onChange={(e) => setRelayUrl(e.target.value)}
              onBlur={saveRelayUrl}
              className={`${INPUT_CLASS} w-full`}
            />
          </div>
          <div className="w-28 space-y-1">
            <label htmlFor="p2p-relay-port" className="text-[13px] font-medium">Port</label>
            <input
              id="p2p-relay-port"
              type="text"
              inputMode="numeric"
              value={relayPort}
              placeholder={DEFAULT_RELAY_PORT}
              onChange={(e) => setRelayPort(e.target.value)}
              onBlur={() => { if (settings && relayPort !== String(settings.relayPort)) saveRelayPort(); }}
              className={`${INPUT_CLASS} w-full`}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Sharing">
        <Switch
          label="Serve this machine"
          ariaLabel="Serve this machine"
          testId="p2p-serve-toggle"
          checked={serveEnabled}
          onChange={(checked) => { setServeEnabled(checked); void save({ serveEnabled: checked }); }}
        />
      </SettingsSection>

      <SettingsSection title="Fleet members">
        <div>
          <button type="button" className={BUTTON_CLASS} onClick={() => setPairing(true)}>Pair a new machine</button>
        </div>
        <JoinFleet onJoined={refresh} />
        {fleetError ? (
          <div role="alert" className="text-sm text-[--danger]">Fleet unavailable: {fleetError}</div>
        ) : members.length === 0 ? (
          <div className="text-sm text-[--text-muted]">No paired machines yet.</div>
        ) : (
          <ul className="space-y-2">
            {members.map((m) => (
              <li key={m.deviceId} className="flex items-center justify-between gap-3 rounded-lg bg-[--panel] px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm">{m.name}</div>
                  <div className="font-mono text-xs text-[--text-muted]" title={m.deviceId}>{truncateId(m.deviceId)}</div>
                </div>
                <button type="button" className={BUTTON_CLASS} aria-label={`Revoke ${m.name}`} disabled={revokingId === m.deviceId} onClick={() => void revoke(m.deviceId, m.name)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      {pairing && <PairModal onClose={() => { setPairing(false); refresh(); }} />}
    </div>
  );
}
