/** Account-scoped Chat context, live and historical messages, and mutation dispatch. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api } from '@renderer/api';
import { toast } from '@renderer/hooks/useToasts';
import type { IpcContract } from '@shared/ipc-contract';
import type { MetaprojectRemoteProject, MetaprojectSessionSnapshot } from '@shared/metaproject-contract';
import { useMetaprojectSession } from './session';

export type SignedIn = Extract<MetaprojectSessionSnapshot, { phase: 'signed-in' }>;
export type Channel = IpcContract['metaproject:list-all-channels']['response']['channels'][number];
export type Message = IpcContract['metaproject:list-messages']['response']['messages'][number] & { deleted?: boolean };
export type Attachment = NonNullable<Message['attachments']>[number];
export type ChatScope = Pick<IpcContract['metaproject:list-messages']['request'], 'epoch' | 'channelId' | 'projectId'>;
export type ChatSendScope = { kind: 'project'; target: ChatScope }
  | { kind: 'global'; target: Pick<ChatScope, 'epoch' | 'channelId'> };

/** Discards operation feedback after this consumer leaves its account or view. */
export function useCurrentChat() {
  const { current, snapshot } = useMetaprojectSession();
  const epoch = snapshot?.epoch ?? -1;
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, [epoch]);
  const isCurrent = () => { const now = current(); return live.current && now?.phase === 'signed-in' && now.epoch === epoch; };
  return { epoch, isCurrent };
}

type Mutation = 'send-message' | 'send-global-message' | 'edit-message' | 'delete-message';
const mutationFailure: Record<Mutation, string> = {
  'send-message': 'Could not send the message. Try again.',
  'send-global-message': 'Could not send the message. Try again.',
  'edit-message': 'Could not edit the message.',
  'delete-message': 'Could not delete the message.',
};

/** Waits for a REST acknowledgement or global socket submission; failure never resends the write. */
export async function mutateChat<K extends Mutation>(action: K, input: IpcContract[`metaproject:${K}`]['request'], current: () => boolean): Promise<boolean> {
  if (!current()) return false;
  try { await api.invoke(`metaproject:${action}`, input); return current(); }
  catch { if (current()) toast(mutationFailure[action], { kind: 'error' }); return false; }
}

/** Restores only the failed draft, never overwriting newer user input. */
export function useChatComposer(scope: ChatSendScope | undefined, refresh: () => void) {
  const { isCurrent } = useCurrentChat();
  const [value, setValue] = useState('');
  const version = useRef(0);
  const change = (text: string) => { version.current += 1; setValue(text); };
  const send = async () => {
    const message = value.trim();
    if (!message || !scope || !isCurrent()) return;
    const sent = ++version.current;
    setValue('');
    if (await sendChat(scope, message, isCurrent, refresh)) return;
    if (isCurrent() && version.current === sent) setValue(value);
  };
  return { value, change, send };
}

async function sendChat(scope: ChatSendScope, message: string, current: () => boolean, refresh: () => void) {
  if (scope.kind === 'global') return mutateChat('send-global-message', { ...scope.target, message }, current);
  const saved = await mutateChat('send-message', { ...scope.target, message }, current);
  if (saved) refresh();
  return saved;
}

/** Preserves a newer edit if another edit is acknowledged or a live update arrives. */
export function useMessageEdit(message: Message, scope: ChatScope | undefined, refresh: () => void) {
  const { isCurrent } = useCurrentChat();
  const [draft, setDraft] = useState<string | null>(null);
  const version = useRef(0);
  const pending = useRef(false);
  const change = (text: string | null) => { version.current += 1; setDraft(text); };
  const save = async () => {
    const text = draft?.trim();
    if (!text || !scope || pending.current || message.deleted) return;
    if (text === message.message) { change(null); return; }
    const submitted = version.current;
    pending.current = true;
    const saved = await mutateChat('edit-message', { ...scope, messageId: message.id, message: text }, isCurrent);
    pending.current = false;
    if (!saved) return;
    if (version.current === submitted) change(null);
    refresh();
  };
  const remove = async () => {
    if (!scope || pending.current || !isCurrent() || !window.confirm('Delete this message?')) return;
    pending.current = true;
    const saved = await mutateChat('delete-message', { ...scope, messageId: message.id }, isCurrent);
    pending.current = false;
    if (saved) refresh();
  };
  return { draft: message.deleted ? null : draft, change, save, remove };
}

function useChatProjects(epoch: number, retry: number) {
  const { current, chatGeneration } = useMetaprojectSession();
  const [projects, setProjects] = useState<MetaprojectRemoteProject[]>();
  const [projectError, setProjectError] = useState(false);
  const [users, setUsers] = useState<IpcContract['metaproject:list-users']['response']['users']>([]);
  useEffect(() => {
    let live = true;
    const valid = () => live && current()?.epoch === epoch;
    const failed = () => { if (valid()) { setProjects([]); setProjectError(true); } };
    void api.invoke('metaproject:assignment-list', { epoch }).then((result) => {
      if (!valid()) return;
      if (!result.ok || result.value.epoch !== epoch) { failed(); return; }
      setProjects(result.value.projects); setProjectError(false);
    }).catch(failed);
    void api.invoke('metaproject:list-users', { epoch }).then((result) => { if (valid()) setUsers(result.users); }).catch(() => { /* Text entry still works. */ });
    return () => { live = false; };
  }, [current, epoch, retry, chatGeneration]);
  return { projects, projectError, users };
}

function useChannels(epoch: number, assignedId: number | null, retry: number) {
  const { current } = useMetaprojectSession();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<Channel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    const valid = () => live && current()?.epoch === epoch;
    setLoading(true); setError(false);
    void api.invoke('metaproject:list-all-channels', { scope: 'all', epoch }).then(({ channels: next }) => {
      if (!valid()) return;
      setChannels(next);
      setActive((prior) => next.find((c) => c.id === prior?.id) ?? next.find((c) => assignedId !== null && c.project_id === assignedId) ?? next.find((c) => c.project_id === null) ?? next[0] ?? null);
    }).catch(() => { if (valid()) setError(true); }).finally(() => { if (valid()) setLoading(false); });
    return () => { live = false; };
  }, [current, epoch, assignedId, retry]);
  return { channels, active, setActive, loading, error };
}

function useJoinChannels(channels: Channel[], { connected, epoch }: SignedIn, retry: number) {
  const [error, setError] = useState(false);
  const [settled, setSettled] = useState<Record<number, number>>({});
  const sequence = useRef(0);
  const { current, chatGeneration } = useMetaprojectSession();
  useLayoutEffect(() => {
    let live = true;
    setError(false);
    if (!connected) return;
    const attempt = ++sequence.current;
    const valid = () => {
      const now = current();
      return live && now?.phase === 'signed-in' && now.epoch === epoch && now.connected;
    };
    for (const { id: channelId } of channels) {
      void api.invoke('metaproject:join-channel', { epoch, channelId }).then(() => {
        if (valid()) setSettled((prior) => ({ ...prior, [channelId]: attempt }));
      }).catch(() => {
        if (!valid()) return;
        setError(true);
        setSettled((prior) => prior[channelId] === undefined ? { ...prior, [channelId]: attempt } : prior);
      });
    }
    return () => { live = false; };
  }, [channels, connected, epoch, current, retry, chatGeneration]);
  return { error, settled };
}

function scopeId(channel: Channel | null, assignedId: number | null, projects: MetaprojectRemoteProject[] | undefined) {
  if (!channel || !projects?.length) return undefined;
  if (channel.project_id !== null) return projects.find(({ id }) => id === channel.project_id)?.id;
  return projects.find(({ id }) => id === assignedId)?.id ?? projects[0]?.id;
}

type RoomContext = {
  channelId: number | undefined;
  scope: ChatScope | undefined;
  sendScope: ChatSendScope | undefined;
  messageKey: string | undefined;
};

function roomContext(channel: Channel | null, projectId: number | undefined, epoch: number): RoomContext {
  if (!channel) return { channelId: undefined, scope: undefined, sendScope: undefined, messageKey: undefined };
  const channelId = channel.id;
  const scope = projectId === undefined ? undefined : { epoch, channelId, projectId };
  if (channel.project_id === null) return { channelId, scope, sendScope: { kind: 'global', target: { epoch, channelId } }, messageKey: `${channelId}:${projectId ?? 'live'}` };
  const sendScope = scope && { kind: 'project' as const, target: scope };
  return { channelId, scope, sendScope, messageKey: scope && `${channelId}:${projectId}` };
}

/** Resolves accessible channel and project context independently of the local folder ID. */
export function useChatState(status: SignedIn, assignedId: number | null) {
  const [retry, bump] = useState(0);
  const { projects, projectError, users } = useChatProjects(status.epoch, retry);
  const channels = useChannels(status.epoch, assignedId, retry);
  const join = useJoinChannels(channels.channels, status, retry);
  const room = roomContext(channels.active, scopeId(channels.active, assignedId, projects), status.epoch);
  const joinAttempt = room.channelId === undefined ? undefined : join.settled[room.channelId];
  const projectNames = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));
  return { ...channels, ...room, projectError, joinError: join.error, users, projectNames, retry, reload: () => bump((n) => n + 1),
    historyAttempt: joinAttempt ?? (status.connected ? undefined : 0),
    unavailable: !!channels.active && projects !== undefined && !room.scope };
}

const id = z.number().int().positive();
const wireMessage = z.object({ id, channel_id: id, project_id: id.nullish(), user_id: id, user_name: z.string().optional(),
  user: z.object({ id, username: z.string(), display_name: z.string().optional(), avatar_url: z.string().nullish() }).nullish(),
  message: z.string(), created_at: z.string(), parent_message_id: id.nullable(), is_deleted: z.boolean().optional(),
  attachments: z.array(z.object({ id, filename: z.string(), file_size: z.number(), mime_type: z.string().nullish() })).optional(),
});
const messagePayload = z.object({ channel_id: id, message: wireMessage });
const deletePayload = z.object({ channel_id: id, message_id: id });
type Change = { kind: 'new' | 'edit'; channelId: number; message: Message } | { kind: 'delete'; channelId: number; id: number };

function toMessage(wire: Omit<Message, 'user'> & { user?: Message['user'] | null }): Message {
  return wire.is_deleted ? { ...wire, user: wire.user ?? undefined, message: '[message deleted]', deleted: true, attachments: [] }
    : { ...wire, user: wire.user ?? undefined };
}

function parseChange(event: string, payload: unknown): Change | undefined {
  if (event === 'channel_message_deleted') {
    const parsed = deletePayload.safeParse(payload);
    if (parsed.success) return { kind: 'delete', channelId: parsed.data.channel_id, id: parsed.data.message_id };
  }
  if (event === 'channel_message' || event === 'channel_message_edited') {
    const parsed = messagePayload.safeParse(payload);
    if (parsed.success && parsed.data.channel_id === parsed.data.message.channel_id) return {
      kind: event === 'channel_message' ? 'new' : 'edit', channelId: parsed.data.channel_id, message: toMessage(parsed.data.message),
    };
  }
}

function applyChange(entries: Message[], change: Change): Message[] {
  if (change.kind === 'delete') return entries.map((m) => m.id === change.id ? toMessage({ ...m, is_deleted: true }) : m);
  if (change.kind === 'edit') return entries.map((m) => m.id === change.message.id && !m.deleted ? { ...m, ...change.message } : m);
  return entries.some((m) => m.id === change.message.id) ? entries : [...entries, change.message];
}

type MessageEvent = (message: Message, actor: string) => Notification | undefined;
type Read = { changes: Change[] };
type History = { key: string; messages: Message[]; loading?: boolean; error?: boolean };
const emptyMessages: Message[] = [];

type HistoryRoom = Pick<ReturnType<typeof useChatState>, 'channelId' | 'scope' | 'messageKey' | 'historyAttempt' | 'retry'>;

function useHistoryRead({ channelId, scope, messageKey: key, historyAttempt, retry }: HistoryRoom, epoch: number) {
  const { current } = useMetaprojectSession();
  const projectId = scope?.projectId;
  const reading = useRef<Read | null>(null);
  const [history, setHistory] = useState<History>();
  const [refreshCount, increment] = useState(0);
  useLayoutEffect(() => {
    if (key === undefined || channelId === undefined || projectId === undefined || historyAttempt === undefined) return;
    const request: Read = { changes: [] };
    reading.current = request;
    const valid = () => reading.current === request && current()?.epoch === epoch;
    setHistory((prior) => ({ key, messages: prior?.key === key ? prior.messages : emptyMessages, loading: true }));
    void api.invoke('metaproject:list-messages', { channelId, projectId, epoch, limit: 50 }).then((result) => {
      if (valid()) setHistory({ key, messages: request.changes.reduce(applyChange, result.messages.map(toMessage)) });
    }).catch(() => {
      if (valid()) setHistory((prior) => ({ key, messages: prior?.key === key ? prior.messages : emptyMessages, error: true }));
    }).finally(() => {
      if (valid()) reading.current = null;
    });
    return () => { if (reading.current === request) reading.current = null; };
  }, [channelId, projectId, key, epoch, current, retry, historyAttempt, refreshCount]);
  return { reading, history, setHistory, refresh: () => increment((n) => n + 1) };
}

/** Reads scoped history after confirmed joins and displays actual live global messages without a project. */
export function useChatHistory(room: HistoryRoom, { epoch, actor }: SignedIn, notify: MessageEvent) {
  const { current } = useMetaprojectSession();
  const { channelId, messageKey: key } = room;
  const { reading, history, setHistory, refresh } = useHistoryRead(room, epoch);
  const { unread, received } = useUnreadNotifications(channelId, actor.username, notify);
  useLayoutEffect(() => api.on('metaproject:chat-event', ({ epoch: incoming, event, payload }) => {
    const now = current();
    if (incoming !== epoch || now?.phase !== 'signed-in' || now.epoch !== epoch) return;
    const change = parseChange(event, payload);
    if (!change) return;
    if (change.kind === 'new') received(change.message);
    if (key === undefined || channelId !== change.channelId) return;
    reading.current?.changes.push(change);
    setHistory((prior) => prior?.key === key ? { ...prior, messages: applyChange(prior.messages, change) }
      : { key, messages: applyChange(emptyMessages, change) });
  }), [channelId, key, current, epoch, received, reading, setHistory]);
  const visible = key !== undefined && history?.key === key ? history : undefined;
  return { messages: visible?.messages ?? emptyMessages, loading: visible?.loading ?? (!!room.scope && room.historyAttempt === undefined),
    error: visible?.error ?? false, unread, refresh };
}

function useUnreadNotifications(channelId: number | undefined, username: string, notify: MessageEvent) {
  const notifications = useRef(new Set<Notification>());
  const [unread, setUnread] = useState<Record<number, number>>({});
  useEffect(() => {
    if (channelId !== undefined) setUnread((prior) => ({ ...prior, [channelId]: 0 }));
  }, [channelId]);
  useLayoutEffect(() => {
    const active = notifications.current;
    return () => { for (const notice of active) notice.close(); active.clear(); };
  }, []);
  const received = useCallback((message: Message) => {
    const channel = message.channel_id;
    if (channel !== channelId) setUnread((prior) => ({ ...prior, [channel]: (prior[channel] ?? 0) + 1 }));
    const notice = notify(message, username);
    if (!notice) return;
    const active = notifications.current;
    active.add(notice);
    notice.onclose = () => { active.delete(notice); };
  }, [channelId, notify, username]);
  return { unread, received };
}
