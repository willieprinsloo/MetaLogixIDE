import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';

interface Channel { id: number; project_id: number; name: string; is_private: boolean }
interface Msg {
  id: number;
  channel_id: number;
  user_id: number;
  user_name?: string;
  message: string;
  created_at: string;
  parent_message_id: number | null;
}

interface Props {
  projectId: number;
  metaprojectProjectId: string | null;
}

/**
 * Real chat over the metaproject Socket.IO channel. The main process holds
 * the connection; here we speak IPC. On mount:
 *   1. Ask for status. If not logged in, show a compact login card.
 *   2. Otherwise: list channels for the project, pick the first, load
 *      recent messages, subscribe to `channel_message` for incoming.
 */
export function ChatTab({ projectId, metaprojectProjectId }: Props) {
  const numericMpId = useMemo(() => {
    if (!metaprojectProjectId) return null;
    const n = Number(metaprojectProjectId.replace(/^[A-Za-z]+-/, ''));
    return Number.isFinite(n) ? n : null;
  }, [metaprojectProjectId]);

  const [status, setStatus] = useState<{ loggedIn: boolean; connected: boolean; userName: string | null } | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [composer, setComposer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    const s = await api.invoke('metaproject:status', undefined as never);
    setStatus(s);
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  // Load channels once we're logged in AND have a project id to look up.
  useEffect(() => {
    if (!status?.loggedIn || numericMpId == null) return;
    (async () => {
      try {
        const { channels } = await api.invoke('metaproject:list-channels', { projectId: numericMpId });
        setChannels(channels);
        if (channels.length > 0 && !activeChannel) setActiveChannel(channels[0]!);
      } catch (e) {
        setError(String(e).replace(/^Error:\s*/, ''));
      }
    })();
  }, [status?.loggedIn, numericMpId, activeChannel]);

  // Whenever the active channel changes: load history + join room.
  useEffect(() => {
    if (!activeChannel) { setMessages([]); return; }
    setError(null);
    (async () => {
      try {
        const { messages } = await api.invoke('metaproject:list-messages', { channelId: activeChannel.id, limit: 50 });
        setMessages(messages);
        await api.invoke('metaproject:join-channel', { channelId: activeChannel.id });
      } catch (e) {
        setError(String(e).replace(/^Error:\s*/, ''));
      }
    })();
  }, [activeChannel]);

  // Subscribe to server events. Fan out to per-channel + notification logic.
  useEffect(() => {
    const off = api.on('metaproject:event', ({ event, payload }) => {
      if (event === 'connect')             void refreshStatus();
      if (event === 'disconnect')          void refreshStatus();
      if (event === 'channel_message' && activeChannel) {
        const p = payload as { channel_id: number; message: Msg };
        if (p.channel_id !== activeChannel.id) return;
        setMessages((prev) => [...prev, p.message]);
        // OS notification on @mention or when window unfocused.
        maybeNotify(p.message, status?.userName ?? null);
      }
      if (event === 'chat_error') {
        const p = payload as { error?: string };
        toast('Chat error', { kind: 'error', detail: p?.error ?? 'unknown' });
      }
    });
    return () => { off(); };
  }, [activeChannel, refreshStatus, status?.userName]);

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send() {
    const msg = composer.trim();
    if (!msg || !activeChannel) return;
    setComposer('');
    try {
      await api.invoke('metaproject:send-message', { channelId: activeChannel.id, message: msg });
    } catch (e) {
      setComposer(msg);
      toast('Send failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  if (!status) return <div className="p-6 text-sm text-[--text-muted]">Loading chat…</div>;

  if (!status.loggedIn) {
    return <LoginCard onLoggedIn={refreshStatus} />;
  }

  if (numericMpId == null) {
    return (
      <div className="p-6 text-sm text-[--text-muted] space-y-2">
        <div>This project has no metaproject link.</div>
        <div>Add <code className="font-mono">project_id: PROJ-42</code> (or a bare integer) to <code className="font-mono">.metaproject.yaml</code> to enable chat.</div>
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      <aside className="w-52 shrink-0 overflow-y-auto border-r border-[--border] py-2 px-1 text-sm bg-[--panel]/40">
        <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold">Channels</div>
        {channels.length === 0 && <div className="px-3 py-2 text-[--text-muted]">No channels yet.</div>}
        {channels.map((c) => (
          <button
            key={c.id}
            onClick={() => setActiveChannel(c)}
            className={`w-full text-left px-3 py-1 rounded-md flex items-center gap-1.5 mx-1 ${
              activeChannel?.id === c.id ? 'bg-[color:var(--accent)] text-white' : 'hover:bg-[--panel-strong]'
            }`}
          >
            <span className="opacity-70">{c.is_private ? '🔒' : '#'}</span>
            <span className="truncate">{c.name}</span>
          </button>
        ))}
      </aside>
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-3 py-1.5 border-b border-[--border] text-[11px] text-[--text-muted] flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.connected ? 'bg-green-500 live-dot' : 'bg-amber-400'}`} />
            {status.connected ? 'connected' : 'reconnecting…'}
          </span>
          <span className="opacity-60">·</span>
          <span>{status.userName ?? 'signed in'}</span>
          <span className="opacity-60">·</span>
          <span className="font-mono">{activeChannel ? `#${activeChannel.name}` : 'no channel'}</span>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-1">
          {error && <div className="text-sm text-[--danger]">{error}</div>}
          {messages.map((m) => (
            <MessageRow key={m.id} m={m} me={status.userName} />
          ))}
          {messages.length === 0 && !error && (
            <div className="text-center text-[--text-muted] text-sm p-6">
              {activeChannel ? 'No messages yet — say hi.' : 'Pick a channel on the left.'}
            </div>
          )}
        </div>
        <div className="p-2 border-t border-[--border] bg-[--panel]/40">
          <textarea
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            disabled={!activeChannel}
            placeholder={activeChannel ? `Message #${activeChannel.name} — ⌘/Enter to send` : 'Pick a channel first'}
            rows={2}
            className="w-full resize-none bg-[--panel-strong] border border-[--border] rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
          />
        </div>
      </div>
      {/* Preserve unused parameter to avoid lint noise. */}
      <input type="hidden" value={projectId} readOnly />
    </div>
  );
}

function LoginCard({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const { userName } = await api.invoke('metaproject:login', { username, password });
      toast(`Signed in to metaproject as ${userName}`, { kind: 'success' });
      onLoggedIn();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''));
    } finally { setBusy(false); }
  }
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="w-[360px] space-y-3 bg-[--panel-strong] border border-[--border] rounded-lg p-5">
        <div className="text-sm font-semibold">Sign in to metaproject</div>
        <div className="text-xs text-[--text-muted]">Uses the same credentials as the web board. Session cookie stays in the main process.</div>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username or email"
          autoFocus
          className="w-full bg-[--panel] border border-[--border] rounded-md px-3 py-2 text-sm"
          data-testid="mp-login-username"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          placeholder="password"
          className="w-full bg-[--panel] border border-[--border] rounded-md px-3 py-2 text-sm"
          data-testid="mp-login-password"
        />
        {err && <div className="text-xs text-[--danger]">{err}</div>}
        <button
          onClick={submit}
          disabled={busy || !username || !password}
          className="w-full bg-[color:var(--accent)] text-white rounded-md py-2 text-sm hover:brightness-110 disabled:opacity-50"
          data-testid="mp-login-submit"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}

function MessageRow({ m, me }: { m: Msg; me: string | null }) {
  const t = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const mine = me && (m.user_name === me);
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      <div className="text-[10px] text-[--text-muted] flex gap-1.5">
        <span className="font-medium text-[--text]">{m.user_name ?? `user #${m.user_id}`}</span>
        <span>{t}</span>
      </div>
      <div className={`text-sm max-w-[70%] whitespace-pre-wrap break-words rounded-md px-2 py-1 mt-0.5 ${
        mine ? 'bg-[color:var(--accent)]/80 text-white' : 'bg-[--panel-strong]'
      }`}>
        {m.message}
      </div>
    </div>
  );
}

function maybeNotify(m: Msg, me: string | null) {
  const mentioned = me && new RegExp(`@${me}\\b`, 'i').test(m.message);
  const unfocused = !document.hasFocus();
  if (!mentioned && !unfocused) return;
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(mentioned ? `@${me}` : (m.user_name ?? 'metaproject'), { body: m.message });
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  } catch { /* ignore */ }
}
