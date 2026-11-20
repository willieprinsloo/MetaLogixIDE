/**
 * Group chats (pure; GroupChatService wires it). A group belongs to one project; the user picks its
 * members. Their message starts a conversation in parallel ROUNDS: every member gets it at once
 * (round 1); when all have answered, each gets the others' answers (round 2), and so on. It ends by
 * itself after maxRounds rounds since the user's last message, when every member answers PASS, or
 * when fewer than two members are left; or at once when the user stops it. Only `say` starts
 * anything, and a restart never resumes a conversation.
 *
 * Every call that moves a conversation returns DELIVERIES: [{ member, round, text }]. The service
 * runs each as one member turn and passes the member's reply (or failure) back to answer().
 * `round` is a number unique within the group, so a late answer is ignored.
 *
 * Ported from BotOffice `shared/dashboard/groups.js`; behaviour unchanged.
 */
import { randomUUID } from 'node:crypto';
import type { Answer, Group, LogEntry, MemberId } from '@shared/group-chat';

export type { Answer, Group, LogEntry, LogKind, MemberId } from '@shared/group-chat';
export interface Delivery { member: MemberId; round: number; text: string }
export interface GroupsOptions {
  now?: () => number;
  /** The saved list (newest first), mutated in place so the caller can persist it. */
  list?: Group[];
  /** How members are named to each other, e.g. "Main (Claude)". */
  nameOf?: (m: MemberId) => string;
  /** Members that can't touch files (Ollama) get no "say which files" line. */
  isChatOnly?: (m: MemberId) => boolean;
  /** The user's display name in round messages and the log. */
  userName?: () => string;
}

export const DEFAULT_ROUNDS = 4;
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 10;
const MAX_QUOTE = 4000;      // one reply, quoted in the next round's message
const MAX_MESSAGE = 16000;   // a whole round message
const MAX_LOG = 200;         // entries kept per group
export const PASS_RE = /^\s*pass\s*[.!]?\s*$/i;
const RESTARTED = 'Stopped: the app restarted';

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function createGroups({
  now = Date.now,
  list = [],
  nameOf = (m) => m,
  isChatOnly = () => false,
  userName = () => 'You',
}: GroupsOptions = {}) {
  const all = list;
  const iso = () => new Date(now()).toISOString();
  const log = (g: Group, entry: Omit<LogEntry, 'at'>) => {
    g.log.push({ at: iso(), ...entry });
    if (g.log.length > MAX_LOG) g.log.splice(0, g.log.length - MAX_LOG);
    g.updatedAt = iso();
  };
  const end = (g: Group, why: string) => {
    Object.assign(g, { status: 'idle', round: null, held: [] });
    log(g, { kind: 'end', text: why });
  };
  for (const g of all) {
    if (g?.status !== 'running') continue;
    Object.assign(g, { status: 'stopped', round: null, held: [], joined: [] });
    log(g, { kind: 'end', text: RESTARTED });
  }
  const get = (id: string): Group | null => all.find((g) => g.id === id) ?? null;

  function create({ projectId, projectName, members = [], name }: { projectId: number; projectName: string; members?: MemberId[]; name?: string }): Group {
    const n = all.filter((g) => g.projectId === projectId).length + 1;
    const g: Group = {
      id: randomUUID(), projectId, projectName, name: String(name || `Group chat ${n}`).slice(0, 60),
      members: [...new Set(members)], maxRounds: DEFAULT_ROUNDS, status: 'idle',
      round: null, k: 0, seq: 0, held: [], joined: [], log: [], createdAt: iso(), updatedAt: iso(),
    };
    all.unshift(g);
    return g;
  }

  function line(e: LogEntry): string {
    if (e.kind === 'you' || e.kind === 'start') return `${userName()}: ${cut(e.text, MAX_QUOTE)}`;
    if (e.kind === 'fail') return `${nameOf(e.from!)} couldn’t answer: ${e.text}`;
    return `${nameOf(e.from!)}: ${cut(e.text, MAX_QUOTE)}`;
  }
  // the conversation since the user's message that started it (for a member who joins mid-way)
  function story(g: Group): string[] {
    let from = 0;
    for (let i = g.log.length - 1; i >= 0; i--) if (g.log[i]!.kind === 'start') { from = i; break; }
    return g.log.slice(from).filter((e) => ['start', 'you', 'reply', 'fail'].includes(e.kind)).map(line);
  }

  function message(g: Group, m: MemberId, lines: string[]): string {
    const head = `[Group chat "${g.name}" in ${g.projectName} · round ${g.k} of ${g.maxRounds} · members: ${g.members.map(nameOf).join(', ')}]`;
    const tail = isChatOnly(m)
      ? 'Reply to the group. If you have nothing to add, reply with just PASS.'
      : 'Reply to the group. Others work in this same folder at the same time: say which files you’ll change before changing them. If you have nothing to add, reply with just PASS.';
    const body = lines.length ? lines.join('\n') : '(the others had nothing to add)';
    const room = MAX_MESSAGE - head.length - tail.length - 40;
    return `${head}\nSince your last message:\n${cut(body, room)}\n${tail}`;
  }

  // start round k for every member: what each hears is the user's held words, then the others' answers
  function startRound(g: Group, k: number, prev: Record<MemberId, Answer> | null): Delivery[] {
    g.seq += 1;
    g.k = k;
    const held = g.held.map((text) => `${userName()}: ${cut(text, MAX_QUOTE)}`);
    g.held = [];
    const joined = new Set(g.joined);
    g.joined = [];
    const out = g.members.map((m) => {
      const lines = joined.has(m) ? story(g) : [...held, ...Object.entries(prev ?? {})
        .filter(([who, a]) => who !== m && g.members.includes(who) && !a.pass)
        .map(([who, a]) => (a.failed ? `${nameOf(who)} couldn’t answer: ${a.failed}` : `${nameOf(who)}: ${cut(a.text ?? '', MAX_QUOTE)}`))];
      return { member: m, round: g.seq, text: message(g, m, lines) };
    });
    g.round = { n: g.seq, waiting: [...g.members], answers: {} };
    log(g, { kind: 'round', text: `Round ${k} of ${g.maxRounds}`, round: g.seq });
    return out;
  }

  function finishRound(g: Group): Delivery[] {
    const { answers } = g.round!;
    const held = g.held.length > 0;
    const members = g.members;
    if (members.length < 2 && !held) { end(g, 'Ended: only one member left'); return []; }
    if (!held && members.length && members.every((m) => answers[m]?.pass)) { end(g, 'Ended: everyone had nothing to add'); return []; }
    if (!held && g.k >= g.maxRounds) { end(g, `Ended after ${g.maxRounds} rounds`); return []; }
    return startRound(g, held ? 1 : g.k + 1, answers);
  }

  function say(id: string, text: string): Delivery[] {
    const g = get(id);
    if (!g || !g.members.length) return [];
    const t = String(text || '').trim();
    if (!t) return [];
    log(g, { kind: g.status === 'running' ? 'you' : 'start', text: t });
    if (g.status === 'running') { g.held.push(t); return []; }
    g.status = 'running';
    g.held = [t];
    g.joined = [];
    return startRound(g, 1, null);
  }

  function answer(id: string, m: MemberId, round: number, result: { text: string } | { failed: string }): Delivery[] {
    const g = get(id);
    if (!g || g.status !== 'running' || !g.round || g.round.n !== round || !g.round.waiting.includes(m)) return [];
    g.round.waiting = g.round.waiting.filter((x) => x !== m);
    if ('failed' in result) {
      g.round.answers[m] = { failed: String(result.failed).slice(0, 200) };
      log(g, { kind: 'fail', from: m, text: g.round.answers[m]!.failed!, round });
    } else {
      const text = String(result.text || '');
      g.round.answers[m] = { text, pass: PASS_RE.test(text) };
      log(g, { kind: 'reply', from: m, text, round });
    }
    return g.round.waiting.length ? [] : finishRound(g);
  }

  function addMember(id: string, m: MemberId): Delivery[] {
    const g = get(id);
    if (!g || g.members.includes(m)) return [];
    g.members.push(m);
    if (g.status === 'running') g.joined.push(m);
    log(g, { kind: 'member', from: m, text: `${nameOf(m)} joined` });
    return [];
  }

  function removeMember(id: string, m: MemberId): Delivery[] {
    const g = get(id);
    if (!g || !g.members.includes(m)) return [];
    g.members = g.members.filter((x) => x !== m);
    g.joined = g.joined.filter((x) => x !== m);
    log(g, { kind: 'member', from: m, text: `${nameOf(m)} left` });
    if (g.status !== 'running' || !g.round) return [];
    g.round.waiting = g.round.waiting.filter((x) => x !== m);
    delete g.round.answers[m];
    if (!g.members.length) { end(g, 'Ended: no members left'); return []; }
    return g.round.waiting.length ? [] : finishRound(g);
  }

  function stop(id: string, who: string = userName()): { stoppedMembers: MemberId[] } {
    const g = get(id);
    if (!g || g.status !== 'running') return { stoppedMembers: [] };
    const stoppedMembers = g.round ? [...g.round.waiting] : [];
    Object.assign(g, { status: 'stopped', round: null, held: [], joined: [] });
    log(g, { kind: 'end', text: `Stopped by ${who}` });
    return { stoppedMembers };
  }

  function remove(id: string): boolean {
    const i = all.findIndex((g) => g.id === id);
    if (i < 0 || all[i]!.status === 'running') return false;
    all.splice(i, 1);
    return true;
  }

  const rename = (id: string, name: string): Group | null => {
    const g = get(id);
    if (g && String(name || '').trim()) g.name = String(name).trim().slice(0, 60);
    return g;
  };
  const setMaxRounds = (id: string, n: number): Group | null => {
    const g = get(id);
    if (g && Number.isFinite(Number(n))) g.maxRounds = Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, Math.round(Number(n))));
    return g;
  };
  const waitingOn = (m: MemberId): Array<{ id: string; round: number }> =>
    all.filter((g) => g.status === 'running' && g.round?.waiting.includes(m)).map((g) => ({ id: g.id, round: g.round!.n }));
  const view = (): Group[] => all;

  return { create, get, view, rename, setMaxRounds, addMember, removeMember, say, answer, stop, remove, waitingOn };
}

export type Groups = ReturnType<typeof createGroups>;
