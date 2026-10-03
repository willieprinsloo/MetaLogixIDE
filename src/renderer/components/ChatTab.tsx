import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import { usePersistedState } from '@renderer/hooks/usePersistedState';

interface Channel { id: number; project_id: number | null; name: string; is_private: boolean }
interface MpProject { id: number; name: string; identifier?: string | null }
interface MsgUser { id: number; username: string; display_name?: string; avatar_url?: string | null }
interface Attachment {
  id: number;
  filename: string;
  file_size: number;
  mime_type?: string | null;
}

interface Msg {
  id: number;
  channel_id: number;
  /** Null on global channels. Present on project-scoped ones. */
  project_id?: number | null;
  user_id: number;
  user_name?: string;
  user?: MsgUser;
  message: string;
  created_at: string;
  parent_message_id: number | null;
  attachments?: Attachment[];
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
  // id → name lookup for the "Other projects" group so the dropdown shows
  // human labels instead of `— proj 42`. Fetched once when the user logs in
  // and cached for the session; a project rename in metaproject won't reflect
  // until app restart, which is acceptable for a hint label.
  const [projectNames, setProjectNames] = useState<Record<number, string>>({});
  // Directory of active users — powers the composer's @-autocomplete. Loaded
  // once at login; small enough that caching in memory is fine.
  const [users, setUsers] = useState<Array<{ id: number; username: string }>>([]);
  // Per-channel unread counter. Bumps on channel_message events when the
  // message's channel isn't the currently-viewed one (or when the chat rail
  // is hidden entirely). Persisted so restarts don't lose the state.
  const [unreadByChannel, setUnreadByChannel] = usePersistedState<Record<string, number>>(
    'metaide.unreadByChannel',
    {},
    (v): v is Record<string, number> => typeof v === 'object' && v !== null && !Array.isArray(v),
  );
  const listRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    const s = await api.invoke('metaproject:status', undefined as never);
    setStatus(s);
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  // Hydrate project-name lookup once we're logged in — cheap single call,
  // reused everywhere a channel needs to name its parent project.
  useEffect(() => {
    if (!status?.loggedIn) return;
    (async () => {
      try {
        const { projects } = await api.invoke('metaproject:list-projects', undefined as never);
        const map: Record<number, string> = {};
        for (const p of projects) map[p.id] = p.name;
        setProjectNames(map);
      } catch { /* names remain empty; fallback shows "proj N" */ }
      try {
        const { users } = await api.invoke('metaproject:list-users', undefined as never);
        setUsers(users);
      } catch { /* mentions still work by typing usernames verbatim */ }
    })();
  }, [status?.loggedIn]);

  // Load channels once we're logged in. Uses the workspace-scoped endpoint
  // so the sidebar shows EVERY channel the user is in across every project
  // — regardless of whether the currently-selected local project has a
  // metaproject link. When the local project IS linked, prefer opening a
  // channel from that project first so the initial view feels contextual.
  const [refreshCounter, setRefreshCounter] = useState(0);
  useEffect(() => {
    if (!status?.loggedIn) return;
    setLoadingChannels(true);
    (async () => {
      try {
        const { channels } = await api.invoke('metaproject:list-all-channels', { scope: 'all' });
        setChannels(channels);
        if (channels.length > 0 && !activeChannel) {
          // Prefer a channel matching the selected project's metaproject id;
          // fall back to the first global channel, then anything.
          const preferred =
            (numericMpId != null && channels.find((c) => c.project_id === numericMpId)) ||
            channels.find((c) => c.project_id == null) ||
            channels[0];
          if (preferred) setActiveChannel(preferred);
        }
        // Auto-switch when the user picks a different project while the
        // chat pane is open: jump to that project's first channel so chat
        // context follows the selection.
        if (channels.length > 0 && activeChannel && numericMpId != null && activeChannel.project_id !== numericMpId) {
          const nextForProject = channels.find((c) => c.project_id === numericMpId);
          if (nextForProject) setActiveChannel(nextForProject);
        }
        // Subscribe to EVERY channel the user is in so per-channel unread
        // counters can bump for background rooms — not just the one that's
        // currently visible in the pane. Cheap: join is a socket emit.
        for (const c of channels) {
          try { await api.invoke('metaproject:join-channel', { channelId: c.id }); }
          catch { /* per-channel join failure isn't fatal */ }
        }
      } catch (e) {
        setError(String(e).replace(/^Error:\s*/, ''));
      } finally {
        setLoadingChannels(false);
      }
    })();
  }, [status?.loggedIn, numericMpId, activeChannel, refreshCounter]);

  // Whenever the active channel changes: load history + join room.
  useEffect(() => {
    if (!activeChannel) { setMessages([]); return; }
    setError(null);
    setLoadingMessages(true);
    (async () => {
      try {
        // The server's messages endpoint always requires a project_id in the
        // path. For a project-scoped channel use its own project_id; for a
        // global channel, borrow the current local project's link, and if
        // that's not set either, borrow any project_id off another channel
        // in the user's list (resolve_channel accepts any org-mate).
        const anyProjectId = activeChannel.project_id
          ?? numericMpId
          ?? channels.find((c) => c.project_id != null)?.project_id
          ?? undefined;
        if (anyProjectId == null) throw new Error('cannot fetch messages: no accessible project_id for this channel');
        const { messages } = await api.invoke('metaproject:list-messages', { channelId: activeChannel.id, limit: 50, projectId: anyProjectId });
        setMessages(messages);
        await api.invoke('metaproject:join-channel', { channelId: activeChannel.id });
      } catch (e) {
        setError(String(e).replace(/^Error:\s*/, ''));
      } finally {
        setLoadingMessages(false);
      }
    })();
  }, [activeChannel, numericMpId]);

  // Clear the unread dot for the channel the user just opened. Runs whenever
  // activeChannel changes, including the initial open after channel load.
  useEffect(() => {
    if (!activeChannel) return;
    setUnreadByChannel((prev) => {
      const key = String(activeChannel.id);
      if (!prev[key]) return prev;
      // Rebuild without the cleared key (dynamic delete trips eslint).
      const next: Record<string, number> = {};
      for (const [k, v] of Object.entries(prev)) if (k !== key) next[k] = v;
      return next;
    });
  }, [activeChannel, setUnreadByChannel]);

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
      if (event === 'channel_message') {
        const p = payload as { channel_id: number; message: Msg };
        // Live-append when the message is for the currently-viewed channel.
        if (activeChannel && p.channel_id === activeChannel.id) {
          setMessages((prev) => [...prev, p.message]);
        } else {
          // Different channel → bump that channel's unread counter so a dot
          // appears in the sidebar. Cleared when the user opens that channel.
          setUnreadByChannel((prev) => ({ ...prev, [String(p.channel_id)]: (prev[String(p.channel_id)] ?? 0) + 1 }));
        }
        // Fire an OS notification if the current user is @mentioned or the
        // app window is unfocused — regardless of which channel it hit.
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

  // Only shown when the SELECTED local project isn't linked to a metaproject
  // project. Chat still works below (global + other-project channels), but a
  // banner at the top lets the user link this project or create a new one so
  // the sidebar's "This project" section starts appearing.
  const linkBanner = numericMpId == null ? (
    <LinkOrCreateBanner
      localProjectId={projectId}
      onLinked={() => setRefreshCounter((n) => n + 1)}
    />
  ) : null;

  return (
    <div className="h-full flex flex-col min-h-0">
      {linkBanner}
      <div className={`flex-1 min-h-0 ${compact ? 'flex flex-col' : 'flex'}`}>
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
          {(() => {
            const grouped = groupChannels(channels, numericMpId);
            return (
              <>
                {grouped.thisProject.length > 0 && (
                  <ChannelGroup label="This project" channels={grouped.thisProject} activeId={activeChannel?.id ?? null} onPick={setActiveChannel} unread={unreadByChannel} />
                )}
                {grouped.global.length > 0 && (
                  <ChannelGroup label="Global" channels={grouped.global} activeId={activeChannel?.id ?? null} onPick={setActiveChannel} unread={unreadByChannel} />
                )}
                {grouped.other.length > 0 && (
                  <ChannelGroup label="Other projects" channels={grouped.other} activeId={activeChannel?.id ?? null} onPick={setActiveChannel} unread={unreadByChannel} projectNames={projectNames} />
                )}
              </>
            );
          })()}
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
            {(() => {
              const grouped = groupChannels(channels, numericMpId);
              return (
                <>
                  {grouped.thisProject.length > 0 && (
                    <optgroup label="This project">
                      {grouped.thisProject.map((c) => {
                        const u = unreadByChannel[String(c.id)] ?? 0;
                        return (
                          <option key={c.id} value={c.id}>
                            {c.is_private ? '🔒 ' : '# '}{c.name}{u > 0 ? ` (${u})` : ''}
                          </option>
                        );
                      })}
                    </optgroup>
                  )}
                  {grouped.global.length > 0 && (
                    <optgroup label="Global">
                      {grouped.global.map((c) => {
                        const u = unreadByChannel[String(c.id)] ?? 0;
                        return (
                          <option key={c.id} value={c.id}>
                            {c.is_private ? '🔒 ' : '🌐 '}{c.name}{u > 0 ? ` (${u})` : ''}
                          </option>
                        );
                      })}
                    </optgroup>
                  )}
                  {grouped.other.length > 0 && (
                    <optgroup label="Other projects">
                      {grouped.other.map((c) => {
                        const parent = c.project_id != null ? (projectNames[c.project_id] ?? `proj ${c.project_id}`) : '';
                        const u = unreadByChannel[String(c.id)] ?? 0;
                        return (
                          <option key={c.id} value={c.id}>
                            {c.is_private ? '🔒 ' : '# '}{c.name}{parent ? ` — ${parent}` : ''}{u > 0 ? ` (${u})` : ''}
                          </option>
                        );
                      })}
                    </optgroup>
                  )}
                </>
              );
            })()}
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
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-2 bg-[--chat-surface]">
          {error && <div className="mx-3 mb-2 px-3 py-1.5 rounded-md text-xs bg-[--danger]/10 text-[--danger] border border-[--danger]/30">{error}</div>}
          {loadingMessages && messages.length === 0 && !error && (
            <div className="flex items-center justify-center gap-2 text-[--text-muted] text-sm p-6">
              <span className="mp-spinner" aria-hidden />
              <span>Loading messages…</span>
            </div>
          )}
          <MessageList
            messages={messages}
            myUserId={status.userId}
            channelId={activeChannel?.id ?? null}
            projectIdForAttachments={
              activeChannel?.project_id
              ?? numericMpId
              ?? channels.find((c) => c.project_id != null)?.project_id
              ?? null
            }
          />
          {!loadingMessages && messages.length === 0 && !error && (
            <div className="h-full min-h-[120px] flex flex-col items-center justify-center gap-2 text-center text-[--text-muted] px-6">
              <div className="w-10 h-10 rounded-full bg-[--panel-strong] border border-[--border] flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <div className="text-sm font-medium text-[--text]">
                {activeChannel ? `#${activeChannel.name} is quiet` : 'No channel selected'}
              </div>
              <div className="text-xs opacity-70">
                {activeChannel ? 'Send the first message to get the room going.' : (compact ? 'Pick a channel above.' : 'Pick a channel on the left.')}
              </div>
            </div>
          )}
        </div>
        <div className="p-2 border-t border-[--border] bg-[--panel]/40">
          <MentionComposer
            value={composer}
            onChange={setComposer}
            onSubmit={() => void send()}
            disabled={!activeChannel}
            placeholder={activeChannel ? `Message #${activeChannel.name} — ⌘/Enter to send` : 'Pick a channel first'}
            users={users}
          />
        </div>
      </div>
        {/* Preserve unused parameter to avoid lint noise. */}
        <input type="hidden" value={projectId} readOnly />
      </div>
    </div>
  );
}

interface MentionCandidate { key: string; label: string; hint?: string }

/**
 * Composer with @-autocomplete. Detects an in-flight @word at the caret,
 * shows a popover of matching users + the special `@channel` / `@all`
 * broadcast targets (metaproject's chat_service resolves both), and
 * inserts `@handle ` on pick. Falls back to the plain textarea when no
 * @word is active so ordinary typing is unaffected.
 */
function MentionComposer({
  value, onChange, onSubmit,
  disabled, placeholder, users,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  placeholder: string;
  users: Array<{ id: number; username: string }>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);

  // Broadcast targets — chat_service treats these specially and pings every
  // active member of the channel, so they belong at the top of the picker.
  const broadcast: MentionCandidate[] = [
    { key: 'channel', label: '@channel', hint: 'notify everyone in this channel' },
    { key: 'all',     label: '@all',     hint: 'notify everyone in this channel' },
  ];

  // Extract the @word the caret currently sits inside, if any. "@" without
  // any preceding non-space char (or start of line) starts a new mention.
  const mention = extractMention(value, caret);
  const q = mention ? mention.query.toLowerCase() : '';
  const filtered = useMemo<MentionCandidate[]>(() => {
    if (!mention) return [];
    const uMatches = users
      .filter((u) => u.username.toLowerCase().startsWith(q))
      .slice(0, 8)
      .map((u) => ({ key: u.username, label: `@${u.username}` }));
    const bMatches = broadcast.filter((b) => b.key.startsWith(q));
    return [...bMatches, ...uMatches];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, q, !!mention]);

  // Reset selection when the candidate list changes shape.
  useEffect(() => { setSelected(0); }, [filtered.length, q]);

  function insert(cand: MentionCandidate) {
    if (!mention) return;
    const before = value.slice(0, mention.start);
    const after  = value.slice(mention.end);
    const replacement = `@${cand.key} `;
    const next = before + replacement + after;
    onChange(next);
    // Move caret past the inserted mention on next tick.
    const newCaret = (before + replacement).length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.selectionStart = el.selectionEnd = newCaret;
      el.focus();
    });
  }

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? 0);
        }}
        onKeyDown={(e) => {
          if (filtered.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => Math.min(filtered.length - 1, i + 1)); return; }
            if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected((i) => Math.max(0, i - 1)); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(filtered[selected]!); return; }
            if (e.key === 'Escape')    { e.preventDefault(); setCaret(-1); return; }
          }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); }
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        disabled={disabled}
        placeholder={placeholder}
        rows={2}
        className="w-full resize-none bg-[--panel-strong] border border-[--border] rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
      />
      {filtered.length > 0 && mention && (
        <div className="absolute bottom-full left-0 mb-1 w-64 max-h-56 overflow-y-auto rounded-md border border-[--border] bg-[--panel-strong] shadow-xl z-10">
          {filtered.map((c, i) => (
            <button
              key={c.key}
              onMouseDown={(e) => { e.preventDefault(); insert(c); }}
              onMouseEnter={() => setSelected(i)}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
                i === selected ? 'bg-[color:var(--accent)]/25' : 'hover:bg-[--panel]'
              }`}
            >
              <span className="font-medium">{c.label}</span>
              {c.hint && <span className="text-[10px] text-[--text-muted] ml-auto">{c.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Find the @word that surrounds the caret, if any. Returns `{ start, end,
 * query }` where `start` points at the `@` and `query` is the chars after
 * it. Returns null when the caret isn't inside an @word — e.g. after a
 * space, at the very start of an alphanumeric run, or on an already-
 * completed `@name` followed by other chars.
 */
function extractMention(text: string, caret: number): { start: number; end: number; query: string } | null {
  if (caret < 0 || caret > text.length) return null;
  // Walk back from caret until we hit whitespace / start / non-mention char.
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1]!;
    if (ch === '@') {
      // Ensure the @ is at start or after whitespace/punctuation.
      const prev = i >= 2 ? text[i - 2]! : ' ';
      if (!/[\s(\[{,;:!?]/.test(prev)) return null;
      const query = text.slice(i, caret);
      if (!/^[A-Za-z0-9._-]*$/.test(query)) return null;
      // Walk forward to find the end of the @word for replacement.
      let j = caret;
      while (j < text.length && /[A-Za-z0-9._-]/.test(text[j]!)) j++;
      return { start: i - 1, end: j, query };
    }
    if (!/[A-Za-z0-9._-]/.test(ch)) return null;
    i--;
  }
  return null;
}

/** Partition channels into the three groups the sidebar renders. */
function groupChannels(channels: Channel[], currentMpId: number | null): { thisProject: Channel[]; global: Channel[]; other: Channel[] } {
  const thisProject: Channel[] = [];
  const global: Channel[] = [];
  const other: Channel[] = [];
  for (const c of channels) {
    if (c.project_id == null) global.push(c);
    else if (currentMpId != null && c.project_id === currentMpId) thisProject.push(c);
    else other.push(c);
  }
  return { thisProject, global, other };
}

function ChannelGroup({ label, channels, activeId, onPick, projectNames, unread }: {
  label: string;
  channels: Channel[];
  activeId: number | null;
  onPick: (c: Channel) => void;
  /** Optional: id → name lookup so "Other projects" rows can show the parent name. */
  projectNames?: Record<number, string>;
  /** channelId (string key) → unread count; renders a small pill on rows with unread. */
  unread?: Record<string, number>;
}) {
  return (
    <div className="mt-2">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold">{label}</div>
      {channels.map((c) => {
        const parent = projectNames && c.project_id != null ? projectNames[c.project_id] : undefined;
        const u = unread?.[String(c.id)] ?? 0;
        const isActive = activeId === c.id;
        return (
          <button
            key={c.id}
            onClick={() => onPick(c)}
            className={`w-full text-left px-3 py-1 rounded-md flex items-center gap-1.5 mx-1 ${
              isActive ? 'bg-[color:var(--accent)] text-white' : (u > 0 ? 'font-semibold text-[--text] hover:bg-[--panel-strong]' : 'hover:bg-[--panel-strong]')
            }`}
            title={parent ? `${parent} · #${c.name}${u ? ` · ${u} unread` : ''}` : `#${c.name}${u ? ` · ${u} unread` : ''}`}
          >
            <span className="opacity-70">{c.is_private ? '🔒' : c.project_id == null ? '🌐' : '#'}</span>
            <span className="truncate flex-1">{c.name}</span>
            {parent && <span className="text-[10px] text-[--text-muted] opacity-70 truncate max-w-[80px]">{parent}</span>}
            {u > 0 && !isActive && (
              <span className="ml-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold flex items-center justify-center leading-none">
                {u > 99 ? '99+' : u}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function LinkOrCreateBanner({ localProjectId, onLinked }: { localProjectId: number; onLinked: () => void }) {
  const [mode, setMode] = useState<'idle' | 'pick' | 'new'>('idle');
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<MpProject[]>([]);
  const [filter, setFilter] = useState('');
  const [newName, setNewName] = useState('');

  async function openPicker() {
    setBusy(true);
    try {
      const { projects } = await api.invoke('metaproject:list-projects', undefined as never);
      setProjects(projects);
      setMode('pick');
    } catch (e) {
      toast('Failed to list projects', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally { setBusy(false); }
  }

  async function linkTo(mpId: number) {
    setBusy(true);
    try {
      await api.invoke('metaproject:link-local-project', { projectId: localProjectId, metaprojectProjectId: mpId });
      toast('Linked to metaproject', { kind: 'success' });
      setMode('idle');
      onLinked();
    } catch (e) {
      toast('Link failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally { setBusy(false); }
  }

  async function createAndLink() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const { project } = await api.invoke('metaproject:create-project', { name });
      await api.invoke('metaproject:link-local-project', { projectId: localProjectId, metaprojectProjectId: project.id });
      toast(`Created and linked "${name}"`, { kind: 'success' });
      setMode('idle');
      setNewName('');
      onLinked();
    } catch (e) {
      toast('Create failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally { setBusy(false); }
  }

  const filtered = filter.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()) || (p.identifier ?? '').toLowerCase().includes(filter.toLowerCase()))
    : projects;

  return (
    <div className="shrink-0 border-b border-[--border] bg-[--panel]/60 backdrop-blur-md">
      <div className="px-3 py-2.5">
        {mode === 'idle' && (
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-md bg-[color:var(--accent)]/15 border border-[color:var(--accent)]/30 flex items-center justify-center shrink-0">
              <LinkPlugIcon />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-[--text] leading-snug">
                Link this folder to a project
              </div>
              <div className="text-[11px] text-[--text-muted] leading-snug mt-0.5">
                Pick an existing metaproject to attach team chat to this folder, or spin up a new one — takes one click.
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={openPicker}
                  disabled={busy}
                  className="text-xs font-medium px-3 py-1.5 rounded-md pressable bg-[color:var(--accent)] text-white hover:brightness-110 disabled:opacity-50"
                >
                  {busy ? 'Loading…' : 'Link existing'}
                </button>
                <button
                  onClick={() => setMode('new')}
                  disabled={busy}
                  className="text-xs font-medium px-3 py-1.5 rounded-md border border-[--border] hover:bg-[--panel-strong] text-[--text] disabled:opacity-50"
                >
                  Create new
                </button>
              </div>
            </div>
          </div>
        )}

        {mode === 'pick' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="text-[13px] font-semibold flex-1">Pick a project to link</div>
              <button className="text-[11px] text-[--text-muted] hover:text-[--text] px-1.5 py-0.5" onClick={() => setMode('idle')}>Cancel</button>
            </div>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              autoFocus
              className="w-full bg-[--panel-strong] border border-[--border] rounded-md px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-[--accent]/60"
            />
            {filtered.length === 0 && (
              <div className="text-[11px] text-[--text-muted] py-2 text-center">
                {projects.length === 0 ? 'No projects available.' : 'No matches — try a different filter.'}
              </div>
            )}
            {filtered.length > 0 && (
              <div className="max-h-52 overflow-y-auto space-y-0.5 -mx-1 px-1">
                {filtered.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => void linkTo(p.id)}
                    disabled={busy}
                    className="group w-full text-left px-2.5 py-2 rounded-md hover:bg-[color:var(--accent)]/15 flex items-center gap-2 border border-transparent hover:border-[color:var(--accent)]/40 disabled:opacity-50"
                  >
                    <div className="w-6 h-6 rounded-md bg-[--panel-strong] border border-[--border] flex items-center justify-center text-[10px] font-semibold text-[--text-muted] shrink-0">
                      {p.name.slice(0, 1).toUpperCase()}
                    </div>
                    <span className="flex-1 truncate text-xs font-medium text-[--text]">{p.name}</span>
                    {p.identifier && <span className="text-[10px] font-mono text-[--text-muted] opacity-70">{p.identifier}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {mode === 'new' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="text-[13px] font-semibold flex-1">Create a new project</div>
              <button className="text-[11px] text-[--text-muted] hover:text-[--text] px-1.5 py-0.5" onClick={() => { setMode('idle'); setNewName(''); }}>Cancel</button>
            </div>
            <input
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) void createAndLink(); }}
              placeholder="Project name (e.g. lawreader)"
              className="w-full bg-[--panel-strong] border border-[--border] rounded-md px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-[--accent]/60"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={createAndLink}
                disabled={busy || !newName.trim()}
                className="flex-1 text-xs font-medium pressable bg-[color:var(--accent)] text-white rounded-md py-1.5 hover:brightness-110 disabled:opacity-50"
              >
                {busy ? 'Creating…' : 'Create + link'}
              </button>
            </div>
            <div className="text-[10px] text-[--text-muted]">
              Creates a Kanban project on the metaproject board and writes <code className="font-mono opacity-80">project_id</code> to this folder&apos;s <code className="font-mono opacity-80">.metaproject.yaml</code>.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LinkPlugIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[color:var(--accent)]">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
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
      <div className="w-[360px] space-y-4 bg-[--panel-strong] border border-[--border] rounded-xl p-6 shadow-xl">
        <div className="text-center space-y-1.5">
          <div className="mx-auto w-10 h-10 rounded-md bg-[color:var(--accent)]/15 border border-[color:var(--accent)]/30 flex items-center justify-center">
            <ChatBubbleIcon />
          </div>
          <div className="text-base font-semibold text-[--text]">Sign in to chat</div>
          <div className="text-xs text-[--text-muted] leading-snug">
            Same credentials as your metaproject board.
          </div>
        </div>
        <div className="space-y-2">
          <label className="block text-[10px] uppercase tracking-wider font-semibold text-[--text-muted]">Email or username</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="you@example.com"
            autoFocus
            className="w-full bg-[--panel] border border-[--border] rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
            data-testid="mp-login-username"
          />
        </div>
        <div className="space-y-2">
          <label className="block text-[10px] uppercase tracking-wider font-semibold text-[--text-muted]">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="••••••••"
            className="w-full bg-[--panel] border border-[--border] rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
            data-testid="mp-login-password"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-[--text-muted] select-none cursor-pointer">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="accent-[color:var(--accent)]"
            data-testid="mp-login-remember"
          />
          <span>Remember me on this Mac <span className="opacity-60">(stored in Keychain)</span></span>
        </label>
        {err && (
          <div className="text-xs text-[--danger] bg-[--danger]/10 border border-[--danger]/30 rounded-md px-2 py-1.5">
            {err}
          </div>
        )}
        <button
          onClick={submit}
          disabled={busy || !username || !password}
          className="w-full pressable bg-[color:var(--accent)] text-white rounded-md py-2 text-sm font-medium hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm"
          data-testid="mp-login-submit"
        >
          {busy && <span className="mp-spinner" aria-hidden />}
          <span>{busy ? 'Signing in…' : 'Sign in'}</span>
        </button>
        <button
          onClick={forget}
          className="block mx-auto text-[10px] text-[--text-muted] hover:text-[--text]"
          type="button"
        >
          Forget saved password
        </button>
      </div>
    </div>
  );
}

function ChatBubbleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[color:var(--accent)]">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
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
function MessageList({ messages, myUserId, channelId, projectIdForAttachments }: { messages: Msg[]; myUserId: number | null; channelId: number | null; projectIdForAttachments: number | null }) {
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
    rows.push(<MessageRow key={m.id} m={m} grouped={!!sameAuthorClose} mine={myUserId != null && m.user_id === myUserId} channelId={channelId} projectIdForAttachments={projectIdForAttachments} />);
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

function MessageRow({ m, grouped, mine, channelId, projectIdForAttachments }: { m: Msg; grouped: boolean; mine: boolean; channelId: number | null; projectIdForAttachments: number | null }) {
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
          <>
            <div className={`text-[13px] leading-snug whitespace-pre-wrap break-words ${m.deleted ? 'italic text-[--text-muted]' : ''}`}>
              {renderMessage(m.message)}
            </div>
            {m.attachments && m.attachments.length > 0 && (
              <div className="mt-1.5 flex flex-col gap-1">
                {m.attachments.map((a) => (
                  <AttachmentRow
                    key={a.id}
                    attachment={a}
                    projectId={m.project_id ?? projectIdForAttachments}
                  />
                ))}
              </div>
            )}
          </>
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
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Renders one chat-message attachment as a compact card with two actions:
 *   • Download — writes bytes to the OS Downloads folder (avoiding overwrites)
 *   • Reveal in Finder — only shown after a successful download so the row
 *     has something to point at. Repeated downloads re-use the last-saved
 *     path unless the user closes/reopens the pane.
 * Global-channel attachments still need a project_id in the URL; the parent
 * (MessageList) computes a fallback from any accessible project.
 */
function AttachmentRow({ attachment, projectId }: { attachment: Attachment; projectId: number | null }) {
  const [busy, setBusy] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  async function download() {
    if (projectId == null) {
      toast('No project context — cannot download', { kind: 'warning' });
      return;
    }
    setBusy(true);
    try {
      const { path } = await api.invoke('metaproject:download-attachment', {
        projectId, attachmentId: attachment.id, filename: attachment.filename,
      });
      setSavedPath(path);
      toast(`Downloaded ${attachment.filename}`, { kind: 'success', detail: path });
    } catch (e) {
      toast('Download failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally { setBusy(false); }
  }
  async function reveal() {
    if (!savedPath) return;
    try { await api.invoke('app:reveal-in-folder', { path: savedPath }); }
    catch (e) { toast('Could not open folder', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') }); }
  }
  return (
    <div className="inline-flex max-w-full items-center gap-2 bg-[--panel-strong] border border-[--border] rounded-md px-2.5 py-1.5">
      <div className="w-7 h-7 rounded-md bg-[--panel] border border-[--border] flex items-center justify-center text-[--text-muted] shrink-0">
        <FileIcon />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium truncate" title={attachment.filename}>{attachment.filename}</div>
        <div className="text-[10px] text-[--text-muted]">
          {formatBytes(attachment.file_size)}
          {attachment.mime_type && <> · {attachment.mime_type}</>}
        </div>
      </div>
      <button
        onClick={download}
        disabled={busy}
        title={savedPath ? `Re-download to Downloads` : 'Download to Downloads'}
        className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
      >
        {busy ? <span className="mp-spinner text-[10px]" aria-hidden /> : <DownloadIcon />}
      </button>
      {savedPath && (
        <button
          onClick={reveal}
          title="Show in Finder"
          className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel]"
        >
          <FolderOpenIcon />
        </button>
      )}
    </div>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
function FolderOpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

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
