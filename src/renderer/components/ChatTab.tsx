import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';

interface Channel { id: number; project_id: number; name: string; is_private: boolean }
interface MsgUser { id: number; username: string; display_name?: string; avatar_url?: string | null }
interface Msg {
  id: number;
  channel_id: number;
  user_id: number;
  user_name?: string;
  user?: MsgUser;
  message: string;
  created_at: string;
  parent_message_id: number | null;
  /** Locally-set flag when the server broadcasts channel_message_deleted. */
  deleted?: boolean;
}

interface Props {
  projectId: number;
  metaprojectProjectId: string | null;
  /**
   * Renders a channel dropdown at the top instead of a horizontal channels
   * sidebar, so the whole component fits inside the ~400 px side rail.
   */
  compact?: boolean;
}

/**
 * Real chat over the metaproject Socket.IO channel. The main process holds
 * the connection; here we speak IPC. On mount:
 *   1. Ask for status. If not logged in, show a compact login card.
 *   2. Otherwise: list channels for the project, pick the first, load
 *      recent messages, subscribe to `channel_message` for incoming.
 */
export function ChatTab({ projectId, metaprojectProjectId, compact = false }: Props) {
  const numericMpId = useMemo(() => {
    if (!metaprojectProjectId) return null;
    const n = Number(metaprojectProjectId.replace(/^[A-Za-z]+-/, ''));
    return Number.isFinite(n) ? n : null;
  }, [metaprojectProjectId]);

  const [status, setStatus] = useState<{ loggedIn: boolean; connected: boolean; userName: string | null; userId: number | null } | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [composer, setComposer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    const s = await api.invoke('metaproject:status', undefined as never);
    setStatus(s);
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  // Load channels once we're logged in AND have a project id to look up.
  useEffect(() => {
    if (!status?.loggedIn || numericMpId == null) return;
    setLoadingChannels(true);
    (async () => {
      try {
        const { channels } = await api.invoke('metaproject:list-channels', { projectId: numericMpId });
        setChannels(channels);
        if (channels.length > 0 && !activeChannel) setActiveChannel(channels[0]!);
      } catch (e) {
        setError(String(e).replace(/^Error:\s*/, ''));
      } finally {
        setLoadingChannels(false);
      }
    })();
  }, [status?.loggedIn, numericMpId, activeChannel]);

  // Whenever the active channel changes: load history + join room.
  useEffect(() => {
    if (!activeChannel) { setMessages([]); return; }
    setError(null);
    setLoadingMessages(true);
    (async () => {
      try {
        const { messages } = await api.invoke('metaproject:list-messages', { channelId: activeChannel.id, limit: 50, projectId: numericMpId ?? undefined });
        setMessages(messages);
        await api.invoke('metaproject:join-channel', { channelId: activeChannel.id });
      } catch (e) {
        setError(String(e).replace(/^Error:\s*/, ''));
      } finally {
        setLoadingMessages(false);
      }
    })();
  }, [activeChannel, numericMpId]);

  // Subscribe to server events. Fan out to per-channel + notification logic.
  useEffect(() => {
    const off = api.on('metaproject:event', ({ event, payload }) => {
      if (event === 'connect')             void refreshStatus();
      if (event === 'disconnect')          void refreshStatus();
      if (event === 'connect_error') {
        const p = payload as { message?: string } | string | undefined;
        const msg = typeof p === 'string' ? p : (p?.message ?? 'connect failed');
        setError(`Live chat offline: ${msg}`);
      }
      if (event === 'channel_message' && activeChannel) {
        const p = payload as { channel_id: number; message: Msg };
        if (p.channel_id !== activeChannel.id) return;
        setMessages((prev) => [...prev, p.message]);
        // OS notification on @mention or when window unfocused.
        maybeNotify(p.message, status?.userName ?? null);
      }
      if (event === 'channel_message_edited' && activeChannel) {
        const p = payload as { channel_id: number; message: Msg };
        if (p.channel_id !== activeChannel.id) return;
        setMessages((prev) => prev.map((m) => (m.id === p.message.id ? { ...m, ...p.message } : m)));
      }
      if (event === 'channel_message_deleted' && activeChannel) {
        const p = payload as { channel_id: number; message_id: number };
        if (p.channel_id !== activeChannel.id) return;
        setMessages((prev) => prev.map((m) => (m.id === p.message_id ? { ...m, message: '[message deleted]', deleted: true } : m)));
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

  if (!status) {
    return (
      <div className="h-full flex items-center justify-center gap-2 text-sm text-[--text-muted]">
        <span className="mp-spinner" aria-hidden />
        <span>Loading chat…</span>
      </div>
    );
  }

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
    <div className={`h-full min-h-0 ${compact ? 'flex flex-col' : 'flex'}`}>
      {!compact && (
        <aside className="w-52 shrink-0 overflow-y-auto border-r border-[--border] py-2 px-1 text-sm bg-[--panel]/40">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold">Channels</div>
          {loadingChannels && channels.length === 0 && (
            <div className="px-3 py-2 text-[--text-muted] flex items-center gap-2">
              <span className="mp-spinner" aria-hidden />
              <span>Loading…</span>
            </div>
          )}
          {!loadingChannels && channels.length === 0 && <div className="px-3 py-2 text-[--text-muted]">No channels yet.</div>}
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
      )}
      {compact && (
        <div className="px-3 py-2 border-b border-[--border] bg-[--panel]/40 shrink-0 flex items-center gap-2">
          <select
            value={activeChannel?.id ?? ''}
            onChange={(e) => {
              const c = channels.find((ch) => ch.id === Number(e.target.value));
              if (c) setActiveChannel(c);
            }}
            disabled={channels.length === 0 || loadingChannels}
            className="flex-1 bg-[--panel-strong] border border-[--border] rounded-md px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
          >
            {loadingChannels && channels.length === 0 && <option>Loading…</option>}
            {!loadingChannels && channels.length === 0 && <option>No channels</option>}
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.is_private ? '🔒 ' : '# '}{c.name}
              </option>
            ))}
          </select>
        </div>
      )}
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
        <div ref={listRef} className="flex-1 overflow-y-auto py-2 bg-[--chat-surface]">
          {error && <div className="mx-3 mb-2 px-3 py-1.5 rounded-md text-xs bg-[--danger]/10 text-[--danger] border border-[--danger]/30">{error}</div>}
          {loadingMessages && messages.length === 0 && !error && (
            <div className="flex items-center justify-center gap-2 text-[--text-muted] text-sm p-6">
              <span className="mp-spinner" aria-hidden />
              <span>Loading messages…</span>
            </div>
          )}
          <MessageList messages={messages} myUserId={status.userId} channelId={activeChannel?.id ?? null} />
          {!loadingMessages && messages.length === 0 && !error && (
            <div className="text-center text-[--text-muted] text-sm p-6">
              {activeChannel ? 'No messages yet — say hi.' : (compact ? 'Pick a channel above.' : 'Pick a channel on the left.')}
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
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const autoTried = useRef(false);

  // On mount: pre-fill the last-used username, and if the OS keychain has a
  // saved password for it, silently attempt an auto-sign-in. If auto-login
  // fails (server down, password rotated), we surface the reason and let
  // the user type a fresh password — the checkbox stays on so a corrected
  // login refreshes the saved credential.
  useEffect(() => {
    if (autoTried.current) return;
    autoTried.current = true;
    (async () => {
      try {
        const { username: u, hasPassword } = await api.invoke('metaproject:credentials-load', undefined as never);
        if (u) setUsername(u);
        if (u && hasPassword) {
          setBusy(true);
          const res = await api.invoke('metaproject:auto-login', undefined as never);
          if (res.ok) {
            toast(`Signed in to metaproject as ${res.userName ?? u}`, { kind: 'success' });
            onLoggedIn();
          } else if (res.reason && !res.reason.startsWith('no-saved')) {
            setErr(res.reason);
          }
          setBusy(false);
        }
      } catch { /* fine — show manual login */ }
    })();
    // onLoggedIn is stable from parent; refs prevent re-runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const { userName } = await api.invoke('metaproject:login', { username, password, remember });
      toast(`Signed in to metaproject as ${userName}`, { kind: 'success' });
      onLoggedIn();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''));
    } finally { setBusy(false); }
  }
  async function forget() {
    try {
      await api.invoke('metaproject:credentials-clear', undefined as never);
      setPassword('');
      toast('Forgot saved metaproject password', { kind: 'info' });
    } catch { /* fine */ }
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
        <label className="flex items-center gap-2 text-xs text-[--text-muted] select-none cursor-pointer">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="accent-[color:var(--accent)]"
            data-testid="mp-login-remember"
          />
          <span>Remember me on this Mac (uses Keychain)</span>
        </label>
        {err && <div className="text-xs text-[--danger]">{err}</div>}
        <button
          onClick={submit}
          disabled={busy || !username || !password}
          className="w-full bg-[color:var(--accent)] text-white rounded-md py-2 text-sm hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2"
          data-testid="mp-login-submit"
        >
          {busy && <span className="mp-spinner" aria-hidden />}
          <span>{busy ? 'Signing in…' : 'Sign in'}</span>
        </button>
        <button
          onClick={forget}
          className="w-full text-[10px] text-[--text-muted] hover:text-[--text] py-1"
          type="button"
        >
          Forget saved password
        </button>
      </div>
    </div>
  );
}

/**
 * Slack-style message list.
 *
 *  - Groups consecutive messages from the same author when < 5 min apart:
 *    the follow-up rows drop the avatar / name / timestamp so the eye
 *    tracks a single voice.
 *  - Inserts a sticky-ish date divider ("Today", "Yesterday", dd MMM)
 *    whenever the local calendar day changes.
 *  - Chooses a stable HSL colour per user_id so avatars visually cluster
 *    without needing avatar URLs (which the API may not return).
 */
function MessageList({ messages, myUserId, channelId }: { messages: Msg[]; myUserId: number | null; channelId: number | null }) {
  const rows: React.ReactNode[] = [];
  let prev: Msg | null = null;
  let lastDay = '';
  for (const m of messages) {
    const dt = new Date(m.created_at);
    const day = dt.toDateString();
    if (day !== lastDay) {
      rows.push(<DateDivider key={`d-${day}-${m.id}`} date={dt} />);
      lastDay = day;
      prev = null;
    }
    const sameAuthorClose = prev
      && prev.user_id === m.user_id
      && (dt.getTime() - new Date(prev.created_at).getTime()) < 5 * 60 * 1000;
    rows.push(<MessageRow key={m.id} m={m} grouped={!!sameAuthorClose} mine={myUserId != null && m.user_id === myUserId} channelId={channelId} />);
    prev = m;
  }
  return <div className="space-y-0.5">{rows}</div>;
}

function DateDivider({ date }: { date: Date }) {
  const today = new Date();
  const label = (() => {
    if (date.toDateString() === today.toDateString()) return 'Today';
    const y = new Date(today); y.setDate(y.getDate() - 1);
    if (date.toDateString() === y.toDateString()) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  })();
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <div className="flex-1 h-px bg-[--border]" />
      <span className="text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold">{label}</span>
      <div className="flex-1 h-px bg-[--border]" />
    </div>
  );
}

function authorLabel(m: Msg): string {
  return m.user?.display_name || m.user?.username || m.user_name || `user #${m.user_id}`;
}

function userColor(id: number): string {
  const hue = (id * 47) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

function MessageRow({ m, grouped, mine, channelId }: { m: Msg; grouped: boolean; mine: boolean; channelId: number | null }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.message);
  useEffect(() => { setDraft(m.message); }, [m.message]);
  const dt = new Date(m.created_at);
  const t = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const name = authorLabel(m);
  const color = userColor(m.user_id);

  async function saveEdit() {
    const next = draft.trim();
    if (!next || next === m.message || channelId == null) { setEditing(false); return; }
    try {
      await api.invoke('metaproject:edit-message', { channelId, messageId: m.id, message: next });
      setEditing(false);
      // Server broadcasts channel_message_edited; the parent state updates
      // via that path, so no optimistic write here.
    } catch (e) {
      toast('Edit failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }
  async function del() {
    if (channelId == null) return;
    if (!window.confirm('Delete this message?')) return;
    try {
      await api.invoke('metaproject:delete-message', { channelId, messageId: m.id });
    } catch (e) {
      toast('Delete failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  }

  const canEditOrDelete = mine && !m.deleted && !editing;
  return (
    <div className={`group flex gap-2.5 px-4 ${grouped ? 'py-0.5' : 'pt-2 pb-0.5'} hover:bg-[--chat-row-hover] rounded-sm relative`}>
      {/* Avatar column — real avatar on lead row, timestamp on grouped rows. */}
      <div className="w-8 shrink-0 flex justify-center">
        {grouped ? (
          <span className="opacity-0 group-hover:opacity-60 text-[9px] text-[--text-muted] mt-1 font-mono">{t}</span>
        ) : (
          <div
            className="w-8 h-8 rounded-md flex items-center justify-center text-xs font-semibold text-white"
            style={{ background: color }}
            title={name}
          >
            {name.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2 leading-none">
            <span className="text-[13px] font-semibold" style={{ color: mine ? 'var(--accent)' : undefined }}>{name}</span>
            <span className="text-[10px] text-[--text-muted] font-mono">{t}</span>
          </div>
        )}
        {editing ? (
          <div className="mt-1">
            <textarea
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit(); }
                else if (e.key === 'Escape') { setEditing(false); setDraft(m.message); }
              }}
              rows={2}
              className="w-full resize-none bg-[--panel-strong] border border-[--border] rounded-md px-2 py-1 text-[13px] outline-none focus:ring-1 focus:ring-[--accent]/60"
            />
            <div className="flex items-center gap-2 mt-1 text-[10px] text-[--text-muted]">
              <span>⌘/Enter to save · Esc to cancel</span>
              <button className="ml-auto text-[color:var(--accent)] hover:brightness-110" onClick={() => void saveEdit()}>Save</button>
              <button className="text-[--text-muted] hover:text-[--text]" onClick={() => { setEditing(false); setDraft(m.message); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className={`text-[13px] leading-snug whitespace-pre-wrap break-words ${m.deleted ? 'italic text-[--text-muted]' : ''}`}>
            {renderMessage(m.message)}
          </div>
        )}
      </div>
      {canEditOrDelete && (
        <div className="absolute top-1 right-3 opacity-0 group-hover:opacity-100 flex items-center gap-0.5 bg-[--panel-strong] border border-[--border] rounded-md px-1 py-0.5">
          <button
            onClick={() => setEditing(true)}
            title="Edit"
            className="w-5 h-5 flex items-center justify-center rounded text-[--text-muted] hover:text-[--text] hover:bg-[--panel]"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
            </svg>
          </button>
          <button
            onClick={del}
            title="Delete"
            className="w-5 h-5 flex items-center justify-center rounded text-[--text-muted] hover:text-[--danger] hover:bg-[--panel]"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Lightweight @mention highlighter. Marks `@handle` fragments so mentions
 * stand out even without a proper markdown pipeline. Everything else is
 * rendered as plain text (no HTML injection).
 */
function renderMessage(text: string): React.ReactNode {
  const parts = text.split(/(@[A-Za-z0-9._-]+)/g);
  return parts.map((p, i) =>
    p.startsWith('@')
      ? <span key={i} className="rounded px-1 bg-[color:var(--accent)]/20 text-[color:var(--accent)] font-medium">{p}</span>
      : <span key={i}>{p}</span>,
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
