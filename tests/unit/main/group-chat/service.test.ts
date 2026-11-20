import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroupChatService, type GroupChatDeps } from '@main/group-chat/service';
import type { MemberTurn, TurnOutcome, TurnPhase } from '@main/group-chat/members';
import type { TurnResult } from '@main/group-chat/engines/types';
import type { MemberRecord, StoredGroup } from '@main/repos/groups-repo';

type Shell = { projectId: number; shellIndex: number };
interface FakeTurn { member: MemberRecord; text: string; stopped: string | null; finish(o: TurnOutcome, r?: TurnResult): void }

function fakeTurn(member: MemberRecord, log: FakeTurn[]): MemberTurn & { result(): TurnResult | null } {
  let resolve!: (o: TurnOutcome) => void;
  const done = new Promise<TurnOutcome>((r) => { resolve = r; });
  let phase: TurnPhase = 'queued';
  let result: TurnResult | null = null;
  let settled = false;
  const entry: FakeTurn = {
    member, text: '', stopped: null,
    finish(o, r) { if (settled) return; settled = true; result = r ?? null; resolve(o); },
  };
  return {
    start(text) { entry.text = text; phase = 'running'; log.push(entry); },
    stop(reason) { entry.stopped = reason; entry.finish({ failed: reason }); },
    phase: () => phase,
    result: () => result,
    done,
  };
}

function setup(over: Partial<GroupChatDeps> = {}, saved: StoredGroup[] = []) {
  const turns: FakeTurn[] = [];
  const store = new Map<string, StoredGroup>(saved.map((s) => [s.group.id, structuredClone(s)]));
  const sessions = new Map<string, string>([['1:0', 'sess-A'], ['1:1', 'sess-B']]);
  const live: Array<Shell & { title: string }> = [{ projectId: 1, shellIndex: 0, title: 'Main' }, { projectId: 1, shellIndex: 1, title: 'Second' }];
  const changes: number[] = [];
  const deps: GroupChatDeps = {
    repo: {
      loadAll: () => [...store.values()].map((s) => structuredClone(s)),
      save: (s) => { store.set(s.group.id, structuredClone(s)); },
      remove: (id) => { store.delete(id); },
    },
    userName: () => 'Martin',
    projectName: () => 'shop',
    projectPath: () => '/work/shop',
    claudeTurn: (m) => fakeTurn(m, turns),
    headlessTurn: (m) => fakeTurn(m, turns),
    claudeSessionOf: (sh) => sessions.get(`${sh.projectId}:${sh.shellIndex}`) ?? null,
    liveClaudeShells: (projectId) => live.filter((s) => s.projectId === projectId),
    onChange: (p) => { changes.push(p); },
    turnMs: 30 * 60 * 1000,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    ...over,
  };
  const svc = new GroupChatService(deps);
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const answerAll = async (text = 'ok') => { for (const t of turns.filter((x) => x.stopped === null)) t.finish({ text }); await flush(); };
  return { svc, deps, turns, store, sessions, live, changes, flush, answerAll };
}

/** A group with the Claude tab (shell 1:0) and a GPT member. */
function twoMembers(s: ReturnType<typeof setup>) {
  const g = s.svc.create(1, { claudeShell: { projectId: 1, shellIndex: 0 } });
  return s.svc.addHeadless(g.id, { engine: 'codex', name: 'Reviewer', model: null });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('GroupChatService', () => {
  it('say starts round 1 for every member and round 2 carries the others’ answers', async () => {
    const s = setup();
    const g = twoMembers(s);
    s.svc.say(g.id, 'review the login');
    await s.flush();
    expect(s.turns).toHaveLength(2);
    expect(s.turns.every((t) => /round 1 of 4/.test(t.text) && /Martin: review the login/.test(t.text))).toBe(true);
    s.turns[0]!.finish({ text: 'claude says hi' });
    s.turns[1]!.finish({ text: 'gpt says hi' });
    await s.flush();
    expect(s.turns).toHaveLength(4);
    const toGpt = s.turns.slice(2).find((t) => t.member.kind === 'headless')!;
    expect(toGpt.text).toMatch(/round 2 of 4/);
    expect(toGpt.text).toMatch(/Main \(Claude\): claude says hi/);
    expect(s.changes.length).toBeGreaterThan(0);
  });

  it('names members by title and engine, and Ollama members get no files line', async () => {
    const s = setup();
    const g = s.svc.create(1, { claudeShell: { projectId: 1, shellIndex: 0 } });
    const v = s.svc.addHeadless(g.id, { engine: 'ollama', name: 'Notes', model: 'llama3.2' });
    const ollama = Object.entries(v.memberInfo).find(([, i]) => i.engine === 'ollama')![1];
    expect(ollama).toMatchObject({ name: 'Notes (Ollama)', kind: 'headless', model: 'llama3.2', available: true });
    s.svc.say(g.id, 'go');
    await s.flush();
    expect(s.turns.find((t) => t.member.kind === 'headless')!.text).not.toMatch(/files/);
  });

  it('a member turn failing answers its round and the round completes', async () => {
    const s = setup();
    const g = twoMembers(s);
    s.svc.say(g.id, 'go');
    await s.flush();
    s.turns[0]!.finish({ text: 'fine' });
    s.turns[1]!.finish({ failed: 'Codex CLI isn’t signed in' });
    await s.flush();
    const v = s.svc.list(1)[0]!;
    expect(v.log.some((e) => e.kind === 'fail' && /signed in/.test(e.text))).toBe(true);
    expect(v.k).toBe(2);
  });

  it('a headless engine failure fails only that member', async () => {
    const s = setup();
    const g = twoMembers(s);
    s.svc.addHeadless(g.id, { engine: 'gemini', name: 'Gem', model: null });
    s.svc.say(g.id, 'go');
    await s.flush();
    s.turns.find((t) => t.member.kind === 'headless' && t.member.engine === 'gemini')!.finish({ failed: 'Gemini CLI isn’t installed' });
    await s.flush();
    expect(s.svc.list(1)[0]!.round!.waiting).toHaveLength(2);
  });

  it('stop fails running turns, drops queued ones, and nothing starts afterwards', async () => {
    const s = setup();
    const g = twoMembers(s);
    s.svc.say(g.id, 'go');
    await s.flush();
    const v = s.svc.stop(g.id);
    await s.flush();
    expect(v.status).toBe('stopped');
    expect(s.turns.every((t) => t.stopped === 'the group chat was stopped')).toBe(true);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(s.turns).toHaveLength(2);
  });

  it('two groups sharing one Claude tab run its turns one at a time', async () => {
    const s = setup();
    const a = twoMembers(s);
    const b = twoMembers(s);
    s.svc.say(a.id, 'first');
    s.svc.say(b.id, 'second');
    await s.flush();
    const claude = () => s.turns.filter((t) => t.member.kind === 'claude-tab');
    expect(claude()).toHaveLength(1);
    claude()[0]!.finish({ text: 'done first' });
    await s.flush();
    expect(claude()).toHaveLength(2);
    expect(claude()[1]!.text).toMatch(/second/);
  });

  it('the 30-minute fail-safe fails a silent member and stops its turn', async () => {
    const s = setup();
    const g = twoMembers(s);
    s.svc.say(g.id, 'go');
    await s.flush();
    s.turns[1]!.finish({ text: 'quick' });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(s.turns[0]!.stopped).toBe('no answer in 30 minutes');
    expect(s.svc.list(1)[0]!.log.some((e) => e.kind === 'fail' && /30 minutes/.test(e.text))).toBe(true);
  });

  it("shellGone fails the running Claude turn with 'its Claude tab was closed'", async () => {
    const s = setup();
    const g = twoMembers(s);
    s.svc.say(g.id, 'go');
    await s.flush();
    s.svc.shellGone({ projectId: 1, shellIndex: 0 });
    await s.flush();
    expect(s.turns.find((t) => t.member.kind === 'claude-tab')!.stopped).toBe('its Claude tab was closed');
  });

  it('addClaudeTab refuses a tab with no Claude session yet, and joinableClaudeTabs says why', () => {
    const s = setup();
    s.sessions.delete('1:1');
    const g = s.svc.create(1, {});
    expect(() => s.svc.addClaudeTab(g.id, { projectId: 1, shellIndex: 1 })).toThrow(/send it a message first/);
    expect(s.svc.joinableClaudeTabs(1)).toEqual([
      { projectId: 1, shellIndex: 0, title: 'Main', joinable: true },
      { projectId: 1, shellIndex: 1, title: 'Second', joinable: false, why: 'send it a message first' },
    ]);
  });

  it('a Claude tab already in the group is not joinable again', () => {
    const s = setup();
    const g = s.svc.create(1, { claudeShell: { projectId: 1, shellIndex: 0 } });
    expect(s.svc.joinableClaudeTabs(1, g.id)[0]).toMatchObject({ joinable: false, why: 'already in this group' });
  });

  it('a member whose session moved (after /clear) is unavailable and fails its round', async () => {
    const s = setup();
    const g = twoMembers(s);
    s.sessions.set('1:0', 'sess-NEW');
    const claudeId = Object.entries(s.svc.list(1)[0]!.memberInfo).find(([, i]) => i.engine === 'claude')![0];
    expect(s.svc.list(1)[0]!.memberInfo[claudeId]!.available).toBe(false);
    s.svc.say(g.id, 'go');
    await s.flush();
    expect(s.turns.filter((t) => t.member.kind === 'claude-tab')).toHaveLength(0);
    expect(s.svc.list(1)[0]!.log.some((e) => e.kind === 'fail' && e.from === claudeId && /isn’t open/.test(e.text))).toBe(true);
  });

  it('protectedShells lists member tabs only while the group is running', async () => {
    const s = setup();
    const g = twoMembers(s);
    expect(s.svc.protectedShells()).toEqual([]);
    s.svc.say(g.id, 'go');
    expect(s.svc.protectedShells()).toEqual([{ projectId: 1, shellIndex: 0 }]);
    s.svc.stop(g.id);
    expect(s.svc.protectedShells()).toEqual([]);
  });

  it('a headless reply stores its engine session for the next turn, and Ollama keeps history', async () => {
    const s = setup();
    const g = s.svc.create(1, { claudeShell: { projectId: 1, shellIndex: 0 } });
    s.svc.addHeadless(g.id, { engine: 'codex', name: 'GPT', model: null });
    s.svc.addHeadless(g.id, { engine: 'ollama', name: 'Notes', model: 'llama3.2' });
    s.svc.say(g.id, 'go');
    await s.flush();
    for (const t of s.turns) t.finish({ text: `${t.member.kind} reply` }, { ok: true, reply: `${t.member.kind} reply`, engineSession: t.member.kind === 'headless' && t.member.engine === 'codex' ? 'th-1' : undefined });
    await s.flush();
    const members = Object.values(s.store.get(g.id)!.members);
    const codex = members.find((m) => m.kind === 'headless' && m.engine === 'codex') as Extract<MemberRecord, { kind: 'headless' }>;
    const ollama = members.find((m) => m.kind === 'headless' && m.engine === 'ollama') as Extract<MemberRecord, { kind: 'headless' }>;
    expect(codex.engineSession).toBe('th-1');
    expect(ollama.history).toHaveLength(2);
    expect(ollama.history[1]).toEqual({ role: 'assistant', content: 'headless reply' });
  });

  it('removing a member mid-round lets the round finish without it', async () => {
    const s = setup();
    const g = twoMembers(s);
    const gptId = Object.entries(g.memberInfo).find(([, i]) => i.engine === 'codex')![0];
    s.svc.say(g.id, 'go');
    await s.flush();
    s.svc.removeMember(g.id, gptId);
    await s.flush();
    expect(s.turns.find((t) => t.member.kind === 'headless')!.stopped).toBe('removed from the group');
    expect(Object.keys(s.store.get(g.id)!.members)).toHaveLength(1);
  });

  it('delete refuses a running group', async () => {
    const s = setup();
    const g = twoMembers(s);
    s.svc.say(g.id, 'go');
    expect(() => s.svc.remove(g.id)).toThrow(/Stop the conversation first/);
    s.svc.stop(g.id);
    s.svc.remove(g.id);
    expect(s.svc.list(1)).toEqual([]);
    expect(s.store.size).toBe(0);
  });

  it('say refuses an empty message', () => {
    const s = setup();
    const g = twoMembers(s);
    expect(() => s.svc.say(g.id, '   ')).toThrow(/empty/);
  });

  it('dispose stops running turns without starting new ones, and the reloaded service shows them stopped', async () => {
    const s = setup();
    const g = twoMembers(s);
    s.svc.say(g.id, 'go');
    await s.flush();
    s.svc.dispose();
    await s.flush();
    expect(s.turns.every((t) => t.stopped !== null)).toBe(true);
    expect(s.turns).toHaveLength(2);
    const again = setup({}, [...s.store.values()]);
    const v = again.svc.list(1)[0]!;
    expect(v.status).toBe('stopped');
    expect(v.log.at(-1)!.text).toBe('Stopped: the app restarted');
    expect(again.store.get(g.id)!.group.status).toBe('stopped');
  });

  it('lists only the asked project’s groups', () => {
    const s = setup();
    twoMembers(s);
    expect(s.svc.list(1)).toHaveLength(1);
    expect(s.svc.list(2)).toEqual([]);
  });
});
