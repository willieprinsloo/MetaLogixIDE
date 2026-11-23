/**
 * Runs group chats: owns the round state machine (groups.ts), the member records, and one turn
 * queue per member, and saves everything through GroupsRepo.
 *
 * - Each delivery from groups.ts becomes one turn on its member. A member runs at most one group
 *   turn at a time; a Claude tab shared by two groups has ONE queue (keyed by its Claude session).
 * - Every way a turn ends answers its round: a reply, an engine failure, Stop, removal, the tab
 *   closing, or the fail-safe (no answer in `turnMs`, default 30 minutes; it only ever ends things).
 * - Only `say` starts a conversation. `dispose` (app quit) stops every turn without answering, so
 *   nothing new starts; the next start finds those groups running and marks them stopped.
 */
import { randomUUID } from 'node:crypto';
import { ENGINE_LABEL, type EngineStatus, type GroupView, type HeadlessEngine, type MemberInfo, type TurnPhase } from '@shared/group-chat';
import type { MemberRecord, StoredGroup } from '@main/repos/groups-repo';
import { createGroups, type Delivery, type Group, type Groups } from './groups';
import type { MemberTurn, TurnOutcome } from './members';
import type { TurnResult } from './engines/types';

type Shell = { projectId: number; shellIndex: number };
type ClaudeRecord = Extract<MemberRecord, { kind: 'claude-tab' }>;
type HeadlessRecord = Extract<MemberRecord, { kind: 'headless' }>;
type HeadlessTurn = MemberTurn & { result(): TurnResult | null };

export interface GroupChatDeps {
  repo: { loadAll(): StoredGroup[]; save(s: StoredGroup): void; remove(id: string): void };
  userName: () => string;
  projectName: (projectId: number) => string;
  projectPath: (projectId: number) => string;
  /**
   * A headless Claude turn in `cwd` on the member's own copy of its tab's conversation (forked from
   * the tab on the first turn). Nothing is typed into the tab, so /clear, a closed tab or a restart
   * don't matter.
   */
  claudeTurn: (member: ClaudeRecord, cwd: string) => HeadlessTurn;
  /** A turn that runs this member's engine in `cwd`. */
  headlessTurn: (member: HeadlessRecord, cwd: string) => HeadlessTurn;
  /** The latest Claude session id seen in this shell's hooks, or null. */
  claudeSessionOf: (shell: Shell) => string | null;
  /** Live shells in the project that are running Claude. */
  liveClaudeShells: (projectId: number) => Array<Shell & { title: string }>;
  onChange: (projectId: number) => void;
  /** Which headless engines can run right now (for the Add-member picker). */
  engines?: () => Promise<Record<HeadlessEngine, EngineStatus>>;
  turnMs?: number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
}

export const GROUP_TURN_MS = 30 * 60 * 1000;
const OLLAMA_HISTORY = 40;

interface QueueItem { groupId: string; member: string; round: number; text: string }
interface Running { item: QueueItem; turn: MemberTurn; cancelFailSafe: () => void }

export class GroupChatService {
  private readonly groups: Groups;
  private readonly records = new Map<string, Record<string, MemberRecord>>();
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly running = new Map<string, Running>();
  private readonly turnMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private disposed = false;

  constructor(private readonly deps: GroupChatDeps) {
    this.turnMs = deps.turnMs ?? GROUP_TURN_MS;
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    const stored = deps.repo.loadAll();
    for (const s of stored) this.records.set(s.group.id, s.members);
    const wasRunning = stored.filter((s) => s.group.status === 'running').map((s) => s.group.id);
    this.groups = createGroups({
      list: stored.map((s) => s.group),
      now: deps.now,
      userName: deps.userName,
      nameOf: (m) => this.nameOf(m),
      isChatOnly: (m) => { const r = this.record(m); return r?.kind === 'headless' && r.engine === 'ollama'; },
    });
    for (const id of wasRunning) this.save(id); // a restart never resumes a conversation
  }

  // ---------- queries ----------

  list(projectId: number): GroupView[] {
    return this.groups.view().filter((g) => g.projectId === projectId).map((g) => this.view(g));
  }

  joinableClaudeTabs(projectId: number, groupId?: string): Array<Shell & { title: string; joinable: boolean; why?: string }> {
    const inGroup = new Set(Object.values(groupId ? this.records.get(groupId) ?? {} : {})
      .filter((r): r is ClaudeRecord => r.kind === 'claude-tab').map((r) => r.claudeSessionId));
    return this.deps.liveClaudeShells(projectId).map(({ projectId: p, shellIndex, title }) => {
      const sid = this.deps.claudeSessionOf({ projectId: p, shellIndex });
      const base = { projectId: p, shellIndex, title };
      if (!sid) return { ...base, joinable: false, why: 'send it a message first' };
      if (inGroup.has(sid)) return { ...base, joinable: false, why: 'already in this group' };
      return { ...base, joinable: true };
    });
  }

  engineStatus(): Promise<Record<HeadlessEngine, EngineStatus>> {
    const why = 'engine checks aren’t available';
    return this.deps.engines?.() ?? Promise.resolve({ codex: { ready: false, why }, gemini: { ready: false, why }, ollama: { ready: false, why } });
  }

  /** Tabs the keep-alive cap must not evict: none, as group members run on their own copies. */
  protectedShells(): Shell[] {
    return [];
  }

  // ---------- changes ----------

  create(projectId: number, o: { name?: string; claudeShell?: Shell }): GroupView {
    const g = this.groups.create({ projectId, projectName: this.deps.projectName(projectId), name: o.name });
    this.records.set(g.id, {});
    if (o.claudeShell) {
      try { this.addClaudeRecord(g, o.claudeShell); } catch { /* a tab that can't join yet just isn't added */ }
    }
    return this.changed(g);
  }

  update(id: string, o: { name?: string; maxRounds?: number }): GroupView {
    const g = this.must(id);
    if (o.name != null) this.groups.rename(id, o.name);
    if (o.maxRounds != null) this.groups.setMaxRounds(id, o.maxRounds);
    return this.changed(g);
  }

  addClaudeTab(id: string, shell: Shell): GroupView {
    const g = this.must(id);
    this.addClaudeRecord(g, shell);
    return this.changed(g);
  }

  /**
   * Refreshes a Claude member from the project's Claude tab: its next turn forks that tab's current
   * conversation, so it catches up on what was said there since it joined. Only when exactly one
   * tab can be meant.
   */
  reconnectClaude(id: string, member: string): GroupView {
    const g = this.must(id);
    const rec = this.records.get(id)?.[member];
    if (!rec || rec.kind !== 'claude-tab') throw new Error('That member isn’t a Claude tab');
    const taken = new Set(Object.values(this.records.get(id)!)
      .filter((r): r is ClaudeRecord => r.kind === 'claude-tab' && r.id !== member).map((r) => r.claudeSessionId));
    const tabs = this.deps.liveClaudeShells(rec.projectId)
      .map((t) => ({ ...t, sid: this.deps.claudeSessionOf(t) }))
      .filter((t): t is typeof t & { sid: string } => t.sid !== null && !taken.has(t.sid));
    if (tabs.length === 0) throw new Error('No Claude tab can take over yet: open one in this project and send it a message first');
    if (tabs.length > 1) throw new Error('There is more than one Claude tab: remove this member and use + Add to pick one');
    rec.claudeSessionId = tabs[0]!.sid;
    rec.title = tabs[0]!.title;
    rec.groupSession = null;
    return this.changed(g);
  }

  addHeadless(id: string, o: { engine: HeadlessEngine; name: string; model?: string | null }): GroupView {
    const g = this.must(id);
    const name = String(o.name || '').trim().slice(0, 40) || ENGINE_LABEL[o.engine];
    const rec: HeadlessRecord = { id: randomUUID(), kind: 'headless', engine: o.engine, name, model: o.model?.trim() || null, engineSession: null, history: [] };
    this.records.get(id)![rec.id] = rec;
    this.enqueue(id, this.groups.addMember(id, rec.id));
    return this.changed(g);
  }

  removeMember(id: string, member: string): GroupView {
    const g = this.must(id);
    this.enqueue(id, this.groups.removeMember(id, member));
    this.dropQueued((it) => it.groupId === id && it.member === member);
    this.stopRunning((it) => it.groupId === id && it.member === member, 'removed from the group');
    this.records.set(id, Object.fromEntries(Object.entries(this.records.get(id)!).filter(([m]) => m !== member)));
    return this.changed(g);
  }

  say(id: string, text: string): GroupView {
    const g = this.must(id);
    if (!String(text ?? '').trim()) throw new Error('the message is empty');
    if (!g.members.length) throw new Error('add a member first');
    this.enqueue(id, this.groups.say(id, text));
    return this.changed(g);
  }

  stop(id: string): GroupView {
    const g = this.must(id);
    this.groups.stop(id);
    this.dropQueued((it) => it.groupId === id);
    this.stopRunning((it) => it.groupId === id, 'the group chat was stopped');
    return this.changed(g);
  }

  remove(id: string): void {
    const g = this.must(id);
    if (!this.groups.remove(id)) throw new Error('Stop the conversation first');
    this.records.delete(id);
    this.deps.repo.remove(id);
    this.deps.onChange(g.projectId);
  }

  /** A shell exited or was closed. Group members don't run in tabs, so nothing stops. */
  shellGone(_shell: Shell): void {
    /* kept for the install wiring; members run headless on their own copies */
  }

  /** App quit: stop every turn without answering (nothing new starts), and save. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.running.values()) { r.cancelFailSafe(); r.turn.stop('the app is closing'); }
    this.running.clear();
    this.queues.clear();
    for (const g of this.groups.view()) this.save(g.id);
  }

  // ---------- turns ----------

  private enqueue(groupId: string, deliveries: Delivery[]): void {
    for (const d of deliveries) {
      const rec = this.records.get(groupId)?.[d.member];
      if (!rec) { this.answer({ groupId, member: d.member, round: d.round, text: d.text }, { failed: 'it is no longer in the group' }); continue; }
      const key = this.keyOf(rec);
      const q = this.queues.get(key) ?? [];
      q.push({ groupId, member: d.member, round: d.round, text: d.text });
      this.queues.set(key, q);
      this.pump(key);
    }
  }

  private pump(key: string): void {
    while (!this.disposed && !this.running.has(key)) {
      const item = this.queues.get(key)?.shift();
      if (!item) return;
      if (!this.stillWanted(item)) continue;
      const rec = this.records.get(item.groupId)?.[item.member];
      if (!rec) continue;
      const cwd = this.deps.projectPath(this.must(item.groupId).projectId);
      const turn: MemberTurn = rec.kind === 'claude-tab' ? this.deps.claudeTurn(rec, cwd) : this.deps.headlessTurn(rec, cwd);
      const minutes = Math.max(1, Math.round(this.turnMs / 60000));
      const cancelFailSafe = this.setTimer(() => turn.stop(`no answer in ${minutes} minutes`), this.turnMs);
      this.running.set(key, { item, turn, cancelFailSafe });
      turn.start(item.text);
      void turn.done.then((out) => this.finished(key, item, rec, turn, out));
      this.notify(item.groupId);
      return;
    }
  }

  private finished(key: string, item: QueueItem, rec: MemberRecord, turn: MemberTurn, out: TurnOutcome): void {
    if (this.disposed) return;
    const r = this.running.get(key);
    if (r?.turn === turn) { r.cancelFailSafe(); this.running.delete(key); }
    const result = (turn as HeadlessTurn).result?.();
    // the group's own copy of the tab's conversation: later turns resume it
    if (rec.kind === 'claude-tab' && result?.engineSession) rec.groupSession = result.engineSession;
    if (rec.kind === 'headless') {
      if (result?.engineSession) rec.engineSession = result.engineSession;
      if (rec.engine === 'ollama' && 'text' in out) {
        rec.history.push({ role: 'user', content: item.text }, { role: 'assistant', content: out.text });
        if (rec.history.length > OLLAMA_HISTORY) rec.history.splice(0, rec.history.length - OLLAMA_HISTORY);
      }
    }
    this.answer(item, out);
    if (this.groups.get(item.groupId)) { this.save(item.groupId); this.deps.onChange(this.must(item.groupId).projectId); }
    this.pump(key);
  }

  /** Every way a turn ends goes through here, so its round always gets an answer. */
  private answer(item: QueueItem, out: TurnOutcome): void {
    const res = 'text' in out ? { text: out.text } : { failed: out.failed };
    this.enqueue(item.groupId, this.groups.answer(item.groupId, item.member, item.round, res));
  }

  private stillWanted(item: QueueItem): boolean {
    return this.groups.waitingOn(item.member).some((w) => w.id === item.groupId && w.round === item.round);
  }

  private dropQueued(match: (it: QueueItem) => boolean): void {
    for (const [key, q] of this.queues) this.queues.set(key, q.filter((it) => !match(it)));
  }

  private stopRunning(match: (it: QueueItem) => boolean, reason: string): void {
    for (const r of [...this.running.values()]) if (match(r.item)) r.turn.stop(reason);
  }

  // ---------- helpers ----------

  private addClaudeRecord(g: Group, shell: Shell): void {
    const sid = this.deps.claudeSessionOf(shell);
    if (!sid) throw new Error('This Claude tab can’t join yet: send it a message first');
    const recs = this.records.get(g.id)!;
    if (Object.values(recs).some((r) => r.kind === 'claude-tab' && r.claudeSessionId === sid)) return;
    const live = this.deps.liveClaudeShells(shell.projectId).find((s) => s.shellIndex === shell.shellIndex);
    const rec: ClaudeRecord = { id: randomUUID(), kind: 'claude-tab', projectId: shell.projectId, claudeSessionId: sid, title: live?.title || 'Claude', groupSession: null };
    recs[rec.id] = rec;
    this.enqueue(g.id, this.groups.addMember(g.id, rec.id));
  }

  /** One turn at a time per member (each Claude member has its own copy, so no sharing). */
  private keyOf(rec: MemberRecord): string {
    return `member:${rec.id}`;
  }

  private record(member: string): MemberRecord | null {
    for (const recs of this.records.values()) if (recs[member]) return recs[member]!;
    return null;
  }

  private nameOf(member: string): string {
    const r = this.record(member);
    if (!r) return member;
    return r.kind === 'claude-tab' ? `${r.title} (Claude)` : `${r.name} (${ENGINE_LABEL[r.engine]})`;
  }

  private phaseOf(groupId: string, member: string): TurnPhase | null {
    for (const r of this.running.values()) if (r.item.groupId === groupId && r.item.member === member) return r.turn.phase();
    for (const q of this.queues.values()) if (q.some((it) => it.groupId === groupId && it.member === member)) return 'queued';
    return null;
  }

  private view(g: Group): GroupView {
    const memberInfo: Record<string, MemberInfo> = {};
    for (const m of g.members) {
      const r = this.records.get(g.id)?.[m];
      if (!r) continue;
      memberInfo[m] = {
        name: this.nameOf(m),
        kind: r.kind,
        engine: r.kind === 'claude-tab' ? 'claude' : r.engine,
        model: r.kind === 'headless' ? r.model : null,
        available: true, // members run headless: an open tab isn't needed
        phase: this.phaseOf(g.id, m),
      };
    }
    return { ...g, memberInfo };
  }

  private must(id: string): Group {
    const g = this.groups.get(id);
    if (!g) throw new Error('That group chat no longer exists');
    return g;
  }

  private save(id: string): void {
    const g = this.groups.get(id);
    if (g) this.deps.repo.save({ group: g, members: this.records.get(id) ?? {} });
  }

  private notify(groupId: string): void {
    const g = this.groups.get(groupId);
    if (g) this.deps.onChange(g.projectId);
  }

  private changed(g: Group): GroupView {
    this.save(g.id);
    this.deps.onChange(g.projectId);
    return this.view(g);
  }
}
