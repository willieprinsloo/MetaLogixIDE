import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MetaprojectAssignment, MetaprojectSessionSnapshot } from '@shared/metaproject-contract';
import { AccountStatus, useMetaprojectSession, useSignInIntent } from '@renderer/metaproject/session';
import { AssignmentPanel } from '@renderer/metaproject/AssignmentPanel';
import { mpButton, persistenceCopy } from '@renderer/metaproject/messages';
import type { Load } from '@renderer/metaproject/useAssignment';
import { SHORTCUT_COPY } from '@renderer/shortcut-copy';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import {
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  EmptyChannelIcon,
  FileIcon,
  FolderOpenIcon,
} from './chat-icons';

interface Channel { id: number; project_id: number | null; name: string; is_private: boolean }
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
  assignment: Load<MetaprojectAssignment>;
  compact?: boolean;
  onDismiss?: () => void;
}

type SignedIn = Extract<MetaprojectSessionSnapshot, { phase: 'signed-in' }>;

/** Keeps only the current account's Chat data mounted. An unlinked folder can still use global rooms. */
export function ChatTab({ projectId, assignment, compact = false, onDismiss }: Props) {
  const { snapshot } = useMetaprojectSession();
  const signIn = useSignInIntent(projectId);
  const [deferredProject, setDeferredProject] = useState<number | null>(null);
  const linked = assignment.kind === 'loaded' && assignment.value.kind === 'linked' ? assignment.value : null;
  if (snapshot?.phase !== 'signed-in' || deferredProject === projectId) return <div className="space-y-3 p-3 text-sm">
    {snapshot?.phase === 'signed-in' ? <button className={mpButton} onClick={() => setDeferredProject(null)}>Open Chat</button> :
      <AccountStatus onSignIn={() => signIn('Open Chat', () => setDeferredProject(null), () => setDeferredProject(projectId))} />}
    {onDismiss && <button className={mpButton} onClick={onDismiss}>Close Chat</button>}
  </div>;
  return <ActiveChat key={`${snapshot.epoch}:${projectId}:${linked?.revision ?? ''}`} status={snapshot} projectId={projectId} numericMpId={linked?.remoteId ?? null} compact={compact} />;
}

function useCurrentChat() {
  const { current, snapshot } = useMetaprojectSession();
  const epoch = snapshot?.epoch ?? -1;
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, [epoch]);
  const isCurrent = () => { const now = current(); return live.current && now?.phase === 'signed-in' && now.epoch === epoch; };
  return { epoch, isCurrent };
}

interface ActiveProps { status: SignedIn; projectId: number; numericMpId: number | null; compact: boolean }

function ActiveChat({ status, projectId, numericMpId, compact }: ActiveProps) {
  const { current } = useMetaprojectSession();
  const { epoch, actor, connected } = status;
  const { isCurrent } = useCurrentChat();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [history, setHistory] = useState<{ channelId: number; messages: Msg[] }>();
  const messages = history?.channelId === activeChannel?.id ? history?.messages ?? [] : [];
  const [composer, setComposer] = useState('');
  const [channelError, setChannelError] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [projectNames, setProjectNames] = useState<Record<number, string>>({});
  const [projectContextId, setProjectContextId] = useState<number>();
  const notifications = useRef(new Set<Notification>());
  const [users, setUsers] = useState<Array<{ id: number; username: string }>>([]);
  const [unreadByChannel, setUnreadByChannel] = useState<Record<string, number>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const [retry, retryRead] = useState(0);
  const historyProjectId = activeChannel?.project_id ?? projectContextId ?? channels.find((c) => c.project_id != null)?.project_id ?? undefined;

  useEffect(() => {
    let live = true;
    const valid = () => live && current()?.epoch === epoch;
    void api.invoke('metaproject:assignment-list', { epoch }).then((result) => {
      if (!valid() || !result.ok || result.value.epoch !== epoch) return;
      const projects = result.value.projects;
      setProjectNames(Object.fromEntries(projects.map((p) => [p.id, p.name])));
      setProjectContextId(projects.find((p) => p.id === numericMpId)?.id ?? projects[0]?.id);
    }).catch(() => { /* Optional labels fall back to project IDs. */ });
    void api.invoke('metaproject:list-users', { epoch }).then(({ users }) => { if (valid()) setUsers(users); })
      .catch(() => { /* Usernames can still be entered in the composer. */ });
    return () => { live = false; };
  }, [current, epoch, numericMpId]);

  useEffect(() => {
    let live = true;
    const valid = () => live && current()?.epoch === epoch;
    setLoadingChannels(true); setChannelError(false);
    void api.invoke('metaproject:list-all-channels', { scope: 'all', epoch }).then(({ channels: next }) => {
      if (!valid()) return;
      setChannels(next);
      setActiveChannel((prior) => next.find((c) => c.id === prior?.id) ?? next.find((c) => numericMpId !== null && c.project_id === numericMpId) ?? next.find((c) => c.project_id === null) ?? next[0] ?? null);
    }).catch(() => { if (valid()) setChannelError(true); }).finally(() => { if (valid()) setLoadingChannels(false); });
    return () => { live = false; };
  }, [current, epoch, numericMpId, retry]);

  useEffect(() => {
    if (!connected) return;
    for (const c of channels) void api.invoke('metaproject:join-channel', { epoch, channelId: c.id }).catch(() => undefined);
  }, [channels, connected, epoch]);

  useEffect(() => {
    const channelId = activeChannel?.id;
    if (channelId === undefined || historyProjectId === undefined) return;
    let live = true;
    const valid = () => live && current()?.epoch === epoch;
    setHistoryError(false); setLoadingMessages(true);
    void api.invoke('metaproject:list-messages', { channelId, limit: 50, projectId: historyProjectId, epoch }).then(({ messages: next }) => {
      if (!valid()) return;
      setHistory((prior) => {
        const liveMessages = prior?.channelId === channelId ? prior.messages : [];
        const ids = new Set(next.map((m) => m.id));
        return { channelId, messages: [...next, ...liveMessages.filter((m) => !ids.has(m.id))] };
      });
    }).catch(() => { if (valid()) setHistoryError(true); }).finally(() => { if (valid()) setLoadingMessages(false); });
    return () => { live = false; };
  }, [activeChannel?.id, historyProjectId, current, epoch, retry]);

  useEffect(() => {
    if (activeChannel) setUnreadByChannel((prev) => ({ ...prev, [String(activeChannel.id)]: 0 }));
  }, [activeChannel]);

  useLayoutEffect(() => api.on('metaproject:chat-event', ({ epoch: incoming, event, payload }) => {
    const now = current();
    if (incoming !== epoch || now?.phase !== 'signed-in' || now.epoch !== epoch || !payload || typeof payload !== 'object') return;
    const p = payload as { channel_id?: number; message?: Msg; message_id?: number };
    const channelId = p.channel_id;
    if (channelId === undefined) return;
    const message = p.message;
    if (event === 'channel_message' && message) {
      if (activeChannel?.id === channelId) setHistory((prior) => {
        const entries = prior?.channelId === channelId ? prior.messages : [];
        return { channelId, messages: entries.some((m) => m.id === message.id) ? entries : [...entries, message] };
      });
      else setUnreadByChannel((previous) => ({ ...previous, [channelId]: (previous[channelId] ?? 0) + 1 }));
      const notice = maybeNotify(message, actor.username);
      if (notice) {
        const active = notifications.current;
        active.add(notice);
        notice.onclose = () => { active.delete(notice); };
      }
    }
    if (activeChannel?.id !== channelId || (event !== 'channel_message_edited' && event !== 'channel_message_deleted')) return;
    setHistory((prior) => prior?.channelId === channelId ? { channelId, messages: prior.messages.map((m) => {
      if (event === 'channel_message_edited' && message?.id === m.id) return { ...m, ...message };
      if (event === 'channel_message_deleted' && p.message_id === m.id) return { ...m, message: '[message deleted]', deleted: true };
      return m;
    }) } : prior);
  }), [activeChannel?.id, actor.username, current, epoch]);

  useLayoutEffect(() => {
    const active = notifications.current;
    return () => { for (const notice of active) notice.close(); active.clear(); };
  }, []);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [history]);

  async function send() {
    const msg = composer.trim();
    if (!msg || !activeChannel || !isCurrent()) return;
    setComposer('');
    try { await api.invoke('metaproject:send-message', { epoch, channelId: activeChannel.id, message: msg }); }
    catch {
      if (!isCurrent()) return;
      setComposer((draft) => draft || msg);
      toast('Could not send the message. Try again.', { kind: 'error' });
    }
  }

  const error = channelError || historyError;
  const linkBanner = numericMpId === null && projectId > 0 ? <AssignmentPanel projectId={projectId} compact /> : null;
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
          {!loadingChannels && !channelError && channels.length === 0 && <div className="px-3 py-2 text-[--text-muted]">No channels yet.</div>}
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
            aria-label="Chat channel"
            value={activeChannel?.id ?? ''}
            onChange={(e) => {
              const c = channels.find((ch) => ch.id === Number(e.target.value));
              if (c) setActiveChannel(c);
            }}
            disabled={channels.length === 0 || loadingChannels}
            className="flex-1 bg-[--panel-strong] border border-[--border] rounded-md px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[--accent]/60"
          >
            {loadingChannels && channels.length === 0 && <option>Loading…</option>}
            {!loadingChannels && !channelError && channels.length === 0 && <option>No channels</option>}
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
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500 live-dot' : 'bg-amber-400'}`} />
            {connected ? 'connected' : 'reconnecting…'}
          </span>
          <span className="opacity-60">·</span>
          <span>{actor.display_name || actor.username}</span>
          <span className="opacity-60">·</span>
          <span className="font-mono">{activeChannel ? `#${activeChannel.name}` : 'no channel'}</span>
        </div>
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-2 bg-[--chat-surface]">
          {status.warning && <p className="px-3 py-1.5 text-xs" role="alert">{persistenceCopy[status.warning]}</p>}
          {error && <div role="alert" className="mx-3 mb-2 px-3 py-1.5 rounded-md text-xs bg-[--danger]/10 text-[--danger] border border-[--danger]/30">
            {channelError ? 'Could not load chat channels.' : 'Could not load messages.'} <button className={mpButton} onClick={() => retryRead((n) => n + 1)}>Retry Chat</button>
          </div>}
          {loadingMessages && messages.length === 0 && !error && (
            <div className="flex items-center justify-center gap-2 text-[--text-muted] text-sm p-6">
              <span className="mp-spinner" aria-hidden />
              <span>Loading messages…</span>
            </div>
          )}
          <MessageList
            key={activeChannel?.id}
            messages={messages}
            myUserId={actor.id}
            channelId={activeChannel?.id ?? null}
            projectIdForAttachments={historyProjectId ?? null}
          />
          {!loadingMessages && messages.length === 0 && !error && (
            <div className="h-full min-h-[120px] flex flex-col items-center justify-center gap-2 text-center text-[--text-muted] px-6">
              <div className="w-10 h-10 rounded-full bg-[--panel-strong] border border-[--border] flex items-center justify-center">
                <EmptyChannelIcon />
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
            placeholder={activeChannel ? SHORTCUT_COPY.chatPlaceholder(activeChannel.name) : 'Pick a channel first'}
            users={users}
          />
        </div>
      </div>
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
              isActive ? 'bg-[color:var(--accent)] text-[--accent-text]' : (u > 0 ? 'font-semibold text-[--text] hover:bg-[--panel-strong]' : 'hover:bg-[--panel-strong]')
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
  const { epoch, isCurrent } = useCurrentChat();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.message);
  useEffect(() => { setDraft(m.message); }, [m.message]);
  const dt = new Date(m.created_at);
  const t = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const name = authorLabel(m);
  const color = userColor(m.user_id);

  async function saveEdit() {
    const next = draft.trim();
    if (!next || next === m.message || channelId == null || !isCurrent()) { setEditing(false); return; }
    try {
      await api.invoke('metaproject:edit-message', { epoch, channelId, messageId: m.id, message: next });
      if (isCurrent()) setEditing(false);
      // Server broadcasts channel_message_edited; the parent state updates
      // via that path, so no optimistic write here.
    } catch {
      if (isCurrent()) toast('Could not edit the message.', { kind: 'error' });
    }
  }
  async function del() {
    if (channelId == null) return;
    if (!window.confirm('Delete this message?') || !isCurrent()) return;
    try {
      await api.invoke('metaproject:delete-message', { epoch, channelId, messageId: m.id });
    } catch {
      if (isCurrent()) toast('Could not delete the message.', { kind: 'error' });
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
              <span>{SHORTCUT_COPY.chatEditHint}</span>
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
            <EditIcon />
          </button>
          <button
            onClick={del}
            title="Delete"
            className="w-5 h-5 flex items-center justify-center rounded text-[--text-muted] hover:text-[--danger] hover:bg-[--panel]"
          >
            <DeleteIcon />
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
  const { epoch, isCurrent } = useCurrentChat();
  const [busy, setBusy] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  async function download() {
    if (!isCurrent()) return;
    if (projectId == null) {
      toast('No project context — cannot download', { kind: 'warning' });
      return;
    }
    setBusy(true);
    try {
      const { path } = await api.invoke('metaproject:download-attachment', {
        epoch, projectId, attachmentId: attachment.id, filename: attachment.filename,
      });
      if (!isCurrent()) return;
      setSavedPath(path);
      toast('Attachment downloaded', { kind: 'success' });
    } catch {
      if (isCurrent()) toast('Could not download the attachment.', { kind: 'error' });
    } finally { if (isCurrent()) setBusy(false); }
  }
  async function reveal() {
    if (!savedPath || !isCurrent()) return;
    try { await api.invoke('app:reveal-in-folder', { path: savedPath }); }
    catch { if (isCurrent()) toast('Could not open the downloads folder.', { kind: 'error' }); }
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

function renderMessage(text: string): React.ReactNode {
  const parts = text.split(/(@[A-Za-z0-9._-]+)/g);
  return parts.map((p, i) =>
    p.startsWith('@')
      ? <span key={i} className="rounded px-1 bg-[color:var(--accent)]/20 text-[color:var(--accent)] font-medium">{p}</span>
      : <span key={i}>{p}</span>,
  );
}

function maybeNotify(m: Msg, me: string | null) {
  const mentioned = me && m.message.match(/@[A-Za-z0-9._-]+/g)?.some((token) => token.slice(1).toLowerCase() === me.toLowerCase());
  const unfocused = !document.hasFocus();
  if (!mentioned && !unfocused) return;
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      return new Notification(mentioned ? `@${me}` : (m.user_name ?? 'metaproject'), { body: m.message });
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  } catch { /* ignore */ }
}
