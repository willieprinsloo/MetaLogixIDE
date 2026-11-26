import { describe, expect, it } from 'vitest';
import { ActivityTracker, NoticeRouter } from '../../../../src/main/notifications/notice-router';
import type { Notice } from '../../../../src/shared/p2p-contract';

const notice = (body = 'hi'): Notice => ({ kind: 'needs-input', projectId: 1, shellIndex: 0, projectName: 'api', body });

function setup(localIdle: number | null = null) {
  const clock = { now: 1_000_000, localIdle };
  const router = new NoticeRouter({ localIdleMs: () => clock.localIdle, now: () => clock.now });
  return { clock, router };
}

/** Reads what a stream delivers without blocking the test on a parked next(). */
function reader(stream: AsyncIterable<Notice>) {
  const got: Notice[] = [];
  let ended = false;
  const it = stream[Symbol.asyncIterator]();
  void (async () => { for (;;) { const r = await it.next(); if (r.done) { ended = true; return; } got.push(r.value); } })();
  return { got, ended: () => ended, close: () => it.return!() };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ActivityTracker', () => {
  it('has never been used until input arrives while focused', () => {
    const a = new ActivityTracker();
    expect(a.idleMs(5000)).toBeNull();
    a.sample(false, 0, 5000); // typing in another application is not use of the IDE
    expect(a.idleMs(5000)).toBeNull();
    a.sample(true, 2000, 5000);
    expect(a.idleMs(5000)).toBe(2000);
    expect(a.idleMs(9000)).toBe(6000);
  });
  it('keeps the latest moment of use: an unfocused or older sample never moves it back', () => {
    const a = new ActivityTracker();
    a.sample(true, 0, 10_000);
    a.sample(true, 8000, 12_000); // focused but idle since before the last sample
    a.sample(false, 0, 13_000);
    expect(a.idleMs(13_000)).toBe(3000);
    a.sample(true, Number.NaN, 14_000);
    a.sample(true, -5, 14_000);
    expect(a.idleMs(14_000)).toBe(4000);
  });
});

describe('NoticeRouter', () => {
  it('keeps the notice here when no paired machine asked for notices', () => {
    const { router } = setup();
    expect(router.route(notice())).toBe(false);
    router.register().setIdle(0); // reported activity but opened no stream
    expect(router.route(notice())).toBe(false);
  });

  it('keeps it here when the subscribed machine never reported being used', async () => {
    const { router } = setup();
    const r = reader(router.register().stream());
    expect(router.route(notice())).toBe(false);
    await tick();
    expect(r.got).toEqual([]);
  });

  it('sends it to the paired machine used more recently than this one, and not here', async () => {
    const { router } = setup(3 * 60 * 60 * 1000); // this machine: untouched for three hours
    const peer = router.register();
    const r = reader(peer.stream());
    peer.setIdle(4000);
    expect(router.route(notice('one'))).toBe(true);
    await tick();
    expect(r.got).toEqual([notice('one')]);
  });

  it('keeps it here when this machine was used more recently, or equally recently', async () => {
    const { router, clock } = setup(1000);
    const peer = router.register();
    const r = reader(peer.stream());
    peer.setIdle(5000);
    expect(router.route(notice())).toBe(false);
    peer.setIdle(1000); // a tie stays local
    expect(router.route(notice())).toBe(false);
    clock.localIdle = 1001;
    expect(router.route(notice())).toBe(true);
    await tick();
    expect(r.got).toHaveLength(1);
  });

  it('follows the user: whichever machine was used last gets the next notice', async () => {
    const { router, clock } = setup(null);
    const laptop = router.register();
    const tower = router.register();
    const l = reader(laptop.stream());
    const t = reader(tower.stream());
    laptop.setIdle(0);
    tower.setIdle(60_000);
    router.route(notice('a'));
    clock.now += 30_000; // the laptop report ages; the tower is used now
    tower.setIdle(0);
    router.route(notice('b'));
    clock.localIdle = 0; // back at this machine
    expect(router.route(notice('c'))).toBe(false);
    await tick();
    expect(l.got.map((n) => n.body)).toEqual(['a']);
    expect(t.got.map((n) => n.body)).toEqual(['b']);
  });

  it('measures a peer report on this machine\'s clock from when it arrived', () => {
    const { router, clock } = setup(null);
    const peer = router.register();
    reader(peer.stream());
    peer.setIdle(10_000);
    clock.now += 50_000;
    // The peer was last used 60 s ago by now: 10 s before its report, which arrived 50 s ago.
    clock.localIdle = 61_000; // this machine: a second earlier than the peer
    expect(router.route(notice())).toBe(true);
    clock.localIdle = 60_000; // the same moment: stays here
    expect(router.route(notice())).toBe(false);
    clock.localIdle = 59_000; // a second later than the peer
    expect(router.route(notice())).toBe(false);
  });

  it('treats a report that is not a sane age as never used', () => {
    const { router } = setup(null);
    const peer = router.register();
    reader(peer.stream());
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 400 * 24 * 60 * 60 * 1000]) {
      peer.setIdle(bad);
      expect(router.route(notice())).toBe(false);
    }
    peer.setIdle(0);
    expect(router.route(notice())).toBe(true);
    peer.setIdle(null);
    expect(router.route(notice())).toBe(false);
  });

  it('queues for a reader that is not waiting, in order, dropping the oldest beyond the cap', async () => {
    const { router } = setup(null);
    const peer = router.register();
    const stream = peer.stream();
    peer.setIdle(0);
    for (let i = 0; i < 40; i++) router.route(notice(String(i)));
    const r = reader(stream);
    await tick();
    expect(r.got).toHaveLength(32);
    expect(r.got[0]!.body).toBe('8');
    expect(r.got.at(-1)!.body).toBe('39');
  });

  it('stops sending once the stream is closed or the link is disposed, ending parked readers', async () => {
    const { router } = setup(null);
    const peer = router.register();
    peer.setIdle(0);
    const a = reader(peer.stream());
    await tick();
    await a.close();
    await tick();
    expect(a.ended()).toBe(true);
    expect(router.route(notice())).toBe(false);

    const b = reader(peer.stream());
    await tick();
    peer.dispose();
    await tick();
    expect(b.ended()).toBe(true);
    expect(router.route(notice())).toBe(false);
  });

  it('delivers to every open stream of the chosen link', async () => {
    const { router } = setup(null);
    const peer = router.register();
    peer.setIdle(0);
    const a = reader(peer.stream());
    const b = reader(peer.stream());
    await tick();
    router.route(notice('x'));
    await tick();
    expect([a.got.length, b.got.length]).toEqual([1, 1]);
  });
});
