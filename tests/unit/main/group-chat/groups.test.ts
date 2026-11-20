// Group chats: the user's message starts parallel rounds; every member hears the others; it ends by
// itself (rounds, everyone PASS, too few members) or when they stop it. Nothing else starts a round.
// Ported from BotOffice shared/dashboard/test/groups.test.js.
import { describe, it, expect } from 'vitest';
import { createGroups, type Delivery } from '@main/group-chat/groups';

let t = Date.parse('2026-11-18T08:00:00Z');
const now = () => (t += 1000);
const nameOf = (m: string) => ({ boss: 'Folder review (Claude)', gpt: 'Review (GPT)', llama: 'Notes (Ollama)' } as Record<string, string>)[m] || m;
const userName = () => 'Martin';
const make = () => {
  const G = createGroups({ now, nameOf, userName, isChatOnly: (m) => m === 'llama' });
  const g = G.create({ projectId: 1, projectName: 'shop', members: ['boss', 'gpt'] });
  return { G, g };
};
const members = (ds: Delivery[]) => ds.map((d) => d.member).sort();
const to = (ds: Delivery[], m: string) => ds.find((d) => d.member === m)!;

describe('createGroups', () => {
  it('say on an idle group sends round 1 to every member', () => {
    const { G, g } = make();
    const ds = G.say(g.id, 'review the Flask login');
    expect(members(ds)).toEqual(['boss', 'gpt']);
    expect(ds.every((d) => d.round === ds[0]!.round)).toBe(true);
    expect(ds[0]!.text).toMatch(/round 1 of 4/);
    expect(ds[0]!.text).toMatch(/Martin: review the Flask login/);
    expect(ds[0]!.text).toMatch(/Folder review \(Claude\), Review \(GPT\)/);
    expect(ds[0]!.text).toMatch(/in shop ·/);
    expect(G.get(g.id)!.status).toBe('running');
    expect(g.name).toBe('Group chat 1');
  });

  it('round 2 carries the others’ answers, not your own', () => {
    const { G, g } = make();
    const [r1] = G.say(g.id, 'go');
    expect(G.answer(g.id, 'boss', r1!.round, { text: 'I will check auth.py' })).toEqual([]);
    const ds = G.answer(g.id, 'gpt', r1!.round, { text: 'Looks like a missing CSRF token' });
    expect(to(ds, 'boss').text).toMatch(/round 2 of 4/);
    expect(to(ds, 'boss').text).toMatch(/Review \(GPT\): Looks like a missing CSRF token/);
    expect(to(ds, 'boss').text).not.toMatch(/I will check auth.py/);
    expect(to(ds, 'gpt').text).toMatch(/Folder review \(Claude\): I will check auth.py/);
    expect(to(ds, 'boss').round).toBeGreaterThan(r1!.round);
  });

  it('everyone PASS ends it', () => {
    const { G, g } = make();
    const [r1] = G.say(g.id, 'go');
    G.answer(g.id, 'boss', r1!.round, { text: 'pass' });
    expect(G.answer(g.id, 'gpt', r1!.round, { text: ' PASS. ' })).toEqual([]);
    const x = G.get(g.id)!;
    expect(x.status).toBe('idle');
    expect(x.log.at(-1)!.kind).toBe('end');
    expect(x.log.at(-1)!.text).toMatch(/nothing to add/);
  });

  it('it ends after maxRounds, and maxRounds is clamped to 1–10', () => {
    const { G, g } = make();
    G.setMaxRounds(g.id, 2);
    let ds = G.say(g.id, 'go');
    for (let i = 0; i < 2; i++) {
      const r = ds[0]!.round;
      G.answer(g.id, 'boss', r, { text: `boss ${i}` });
      ds = G.answer(g.id, 'gpt', r, { text: `gpt ${i}` });
    }
    expect(ds).toEqual([]);
    expect(G.get(g.id)!.status).toBe('idle');
    expect(G.get(g.id)!.log.at(-1)!.text).toMatch(/2 rounds/);
    G.setMaxRounds(g.id, 99);
    expect(G.get(g.id)!.maxRounds).toBe(10);
    G.setMaxRounds(g.id, 0);
    expect(G.get(g.id)!.maxRounds).toBe(1);
  });

  it('a failed member doesn’t hold the round', () => {
    const { G, g } = make();
    const [r1] = G.say(g.id, 'go');
    G.answer(g.id, 'boss', r1!.round, { text: 'on it' });
    const ds = G.answer(g.id, 'gpt', r1!.round, { failed: 'turn failed: timeout' });
    expect(ds).toHaveLength(2);
    expect(G.get(g.id)!.log.some((e) => e.kind === 'fail' && e.from === 'gpt' && /timeout/.test(e.text))).toBe(true);
    expect(to(ds, 'boss').text).toMatch(/Review \(GPT\) couldn’t answer/);
  });

  it('late answers start nothing', () => {
    const { G, g } = make();
    const [r1] = G.say(g.id, 'go');
    G.answer(g.id, 'boss', r1!.round, { text: 'a' });
    const r2 = G.answer(g.id, 'gpt', r1!.round, { text: 'b' })[0]!.round;
    expect(G.answer(g.id, 'boss', r1!.round, { text: 'old round' })).toEqual([]);
    expect(G.answer(g.id, 'stranger', r2, { text: 'not a member' })).toEqual([]);
    G.stop(g.id, 'Martin');
    expect(G.answer(g.id, 'boss', r2, { text: 'after stop' })).toEqual([]);
    expect(G.get(g.id)!.status).toBe('stopped');
    expect(G.get(g.id)!.log.some((e) => e.text === 'after stop' || e.text === 'old round')).toBe(false);
  });

  it('a message mid-conversation is held for the next round, and the count starts again', () => {
    const { G, g } = make();
    G.setMaxRounds(g.id, 2);
    const [r1] = G.say(g.id, 'go');
    expect(G.say(g.id, 'also check the logout')).toEqual([]);
    G.answer(g.id, 'boss', r1!.round, { text: 'a' });
    const ds = G.answer(g.id, 'gpt', r1!.round, { text: 'b' });
    expect(ds[0]!.text).toMatch(/Martin: also check the logout/);
    expect(ds[0]!.text).toMatch(/round 1 of 2/);
  });

  it('stop ends it now and names who was still working', () => {
    const { G, g } = make();
    const [r1] = G.say(g.id, 'go');
    G.answer(g.id, 'boss', r1!.round, { text: 'done' });
    expect(G.stop(g.id, 'Martin').stoppedMembers).toEqual(['gpt']);
    expect(G.waitingOn('gpt')).toEqual([]);
    expect(G.get(g.id)!.log.at(-1)!.text).toMatch(/Stopped by Martin/);
    expect(G.remove(g.id)).toBe(true);
    expect(G.get(g.id)).toBeNull();
  });

  it('stop defaults to the user’s name', () => {
    const { G, g } = make();
    G.say(g.id, 'go');
    G.stop(g.id);
    expect(G.get(g.id)!.log.at(-1)!.text).toBe('Stopped by Martin');
  });

  it('a running group can’t be deleted; waitingOn says who owes an answer', () => {
    const { G, g } = make();
    const [r1] = G.say(g.id, 'go');
    expect(G.waitingOn('gpt')).toEqual([{ id: g.id, round: r1!.round }]);
    expect(G.remove(g.id)).toBe(false);
  });

  it('removing the last-but-one member ends it', () => {
    const { G, g } = make();
    G.say(g.id, 'go');
    expect(G.removeMember(g.id, 'gpt')).toEqual([]);
    expect(G.get(g.id)!.members).toEqual(['boss']);
    const r = G.waitingOn('boss')[0]!.round;
    expect(G.answer(g.id, 'boss', r, { text: 'ok' })).toEqual([]);
    expect(G.get(g.id)!.status).toBe('idle');
    expect(G.get(g.id)!.log.at(-1)!.text).toMatch(/one member/);
  });

  it('adding a member mid-conversation brings it in next round with the story so far', () => {
    const { G, g } = make();
    const [r1] = G.say(g.id, 'plan the invoices page');
    G.addMember(g.id, 'llama');
    G.answer(g.id, 'boss', r1!.round, { text: 'boss idea' });
    const ds = G.answer(g.id, 'gpt', r1!.round, { text: 'gpt idea' });
    expect(members(ds)).toEqual(['boss', 'gpt', 'llama']);
    const toLlama = to(ds, 'llama').text;
    expect(toLlama).toMatch(/Martin: plan the invoices page/);
    expect(toLlama).toMatch(/boss idea/);
    expect(toLlama).toMatch(/gpt idea/);
  });

  it('chat-only members get no files sentence', () => {
    const G = createGroups({ now, nameOf, userName, isChatOnly: (m) => m === 'llama' });
    const g = G.create({ projectId: 1, projectName: 'shop', members: ['boss', 'llama'] });
    const ds = G.say(g.id, 'go');
    expect(to(ds, 'boss').text).toMatch(/which files you’ll change/);
    expect(to(ds, 'llama').text).not.toMatch(/files/);
    expect(ds[0]!.text).toMatch(/reply with just PASS/);
  });

  it('a list loaded with a running group comes back stopped', () => {
    const A = createGroups({ now, nameOf });
    const g = A.create({ projectId: 1, projectName: 'p', members: ['boss', 'gpt'] });
    A.say(g.id, 'go');
    const B = createGroups({ now, nameOf, list: JSON.parse(JSON.stringify(A.view())) });
    const x = B.get(g.id)!;
    expect(x.status).toBe('stopped');
    expect(x.log.at(-1)!.text).toBe('Stopped: the app restarted');
    expect(B.waitingOn('gpt')).toEqual([]);
  });

  it('long replies are cut in the next round’s message', () => {
    const { G, g } = make();
    const [r1] = G.say(g.id, 'go');
    G.answer(g.id, 'boss', r1!.round, { text: 'x'.repeat(20000) });
    const ds = G.answer(g.id, 'gpt', r1!.round, { text: 'short' });
    expect(to(ds, 'gpt').text.length).toBeLessThan(16500);
  });

  it('labels the user with userName(), defaulting to "You"', () => {
    const G = createGroups({ userName: () => 'Martin' });
    const grp = G.create({ projectId: 1, projectName: 'demo', members: ['a', 'b'] });
    expect(G.say(grp.id, 'hello')[0]!.text).toContain('\nMartin: hello\n');
    const D = createGroups();
    const d = D.create({ projectId: 1, projectName: 'demo', members: ['a', 'b'] });
    expect(D.say(d.id, 'hi')[0]!.text).toContain('\nYou: hi\n');
  });
});
