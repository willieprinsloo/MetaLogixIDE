// Main-process responsiveness under heavy PTY output and git polling.
// Authored by the e2e agent for bugfix/main-process-stall-under-agent-load.
import { test, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DIFF_COPY, DIFF_TESTIDS } from '../../src/renderer/diff-tab-copy';
import { launch, openProject, projectId, sendLine, waitForShell, type Api, type Harness } from './helpers/claude-harness';
import { newShellTab } from './helpers/focus';
import { commitAll, initRepo, porcelain } from './helpers/git-repo';
import { terminalProbes } from './helpers/terminal-probe';

/**
 * Main-process responsiveness (docs/plan/main-process-stall-under-agent-load.md).
 *
 * Symptom: under heavy agent load the OS marks the app "Not Responding",
 * which it does when the Electron main thread stops turning its event loop.
 * These tests load the main process the way agents do — several shells
 * streaming many small chunks, a dirty repository polled by the git UI with
 * git itself slow — and measure whether the main event loop keeps turning.
 *
 * Why this home can observe the behaviour: the suite drives the built
 * Electron app with nothing stubbed — real `PtyManager` and node-pty, real
 * `pty:data` IPC to a real renderer, real `git` against a real repository.
 * The two test-side interventions are environment, not app code: the flood
 * is a real child process writing to a real PTY, and in the git test `git`
 * on the app's PATH is a shim that sleeps, then execs the real git (models
 * git slowed by agents contending for CPU and disk, deterministically).
 *
 * How latency is measured. A timer-drift probe runs *inside* the main
 * process (`app.evaluate`): a 10 ms `setInterval` records how late each tick
 * fires. A timer can only fire when the event loop turns, so the largest
 * drift is the longest stretch the main thread was busy — exactly what the
 * OS watches. A renderer→main `invoke` ping (the path every UI action takes)
 * is measured alongside it with a looser bound, since its round trip also
 * includes renderer time.
 *
 * Thresholds, and why:
 * - MAX_LAG_MS = 250. macOS shows the spinning cursor and "Not Responding"
 *   after the main thread misses events for about 2 s; GNOME's check-alive
 *   default is 5 s. 250 ms is 8× under the tighter of those, yet 3× above the
 *   worst healthy pause we expect on a loaded CI runner (a major GC in main
 *   is tens of ms). The git shim sleeps 800 ms (3.2× the bound), so a single
 *   synchronous git call on the main thread breaches it.
 * - P99_LAG_MS = 100. Catches sustained congestion (many 50–100 ms turns)
 *   that a single max can miss, while a healthy 10 ms timer under load sits
 *   in the low tens.
 * - IPC_MAX_MS = 1000. A user-visible bound on the full round trip; it
 *   includes renderer scheduling, so it is deliberately loose. The timer
 *   probe is the precise instrument.
 *
 * Positive controls: the probe must report a deliberate 600 ms main-thread
 * block before it is trusted; the output detector must flag a seeded gap,
 * duplicate and cross-shell line, and accept a valid stream split mid-line;
 * every flood must deliver all its bytes and its final marker, and last
 * several seconds; the slowed git must be the one the app actually runs.
 */

const PROJ = 'respproj';

const TICK_MS = 10;
const MAX_LAG_MS = 250;
const P99_LAG_MS = 100;
const IPC_MAX_MS = 1000;
const IPC_EVERY_MS = 50;
/** The probe control blocks main this long and must see at least BLOCK_SEEN_MS of it. */
const BLOCK_MS = 600;
const BLOCK_SEEN_MS = 500;

/** Lines each flooding shell writes, one `write(2)` per line, paced evenly over FLOOD_MS. */
const FLOOD_LINES = 30_000;
const FLOOD_MS = 5_000;
const FLOOD_PAD = '.'.repeat(24);
/** `SEQ:<tag>:<6 digits>:<pad>` plus `\n` (the PTY adds `\r`). */
const FLOOD_LINE_BYTES = 'SEQ:a:000000:'.length + FLOOD_PAD.length + 1;
const seqLine = (tag: string, n: number): string => `SEQ:${tag}:${String(n).padStart(6, '0')}:${FLOOD_PAD}`;
const doneLine = (tag: string): string => `FLOOD-DONE:${tag}:${FLOOD_LINES}`;

/** Untracked files seeded for the git test, and the git shim's delay per call. */
const UNTRACKED = 2000;
const GIT_DELAY_S = 0.8;

let h: Harness | undefined;
let scratch: string | undefined;

test.afterEach(async () => {
  await h?.app.close();
  h?.cleanup();
  h = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/* ═══════════════════════════════ main event-loop probe ═══════════════════════════════ */

interface LagStats { samples: number; elapsedMs: number; maxMs: number; p95Ms: number; p99Ms: number }
interface LagProbe { tick: number; last: number; started: number; lags: number[]; timer: ReturnType<typeof setInterval> }

/** Starts (or restarts) the timer-drift probe inside the main process. */
async function startLagProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate((_electron, tick: number) => {
    const g = globalThis as unknown as { __lagProbe?: LagProbe };
    if (g.__lagProbe) clearInterval(g.__lagProbe.timer);
    const now = performance.now();
    const probe: LagProbe = {
      tick, last: now, started: now, lags: [],
      timer: setInterval(() => {
        const t = performance.now();
        probe.lags.push(Math.max(0, t - probe.last - tick));
        probe.last = t;
      }, tick),
    };
    g.__lagProbe = probe;
  }, TICK_MS);
}

/** Stops the probe and summarises it. The gap since the last tick counts too, so a block just before the stop is not lost. */
async function stopLagProbe(app: ElectronApplication): Promise<LagStats> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __lagProbe?: LagProbe };
    const probe = g.__lagProbe;
    if (!probe) throw new Error('lag probe was never started');
    clearInterval(probe.timer);
    g.__lagProbe = undefined;
    const now = performance.now();
    const sorted = [...probe.lags, Math.max(0, now - probe.last - probe.tick)].sort((a, b) => a - b);
    const q = (f: number): number => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] ?? 0;
    return { samples: sorted.length, elapsedMs: now - probe.started, maxMs: sorted[sorted.length - 1] ?? 0, p95Ms: q(0.95), p99Ms: q(0.99) };
  });
}

/** Positive control: a deliberate synchronous block of the main thread must show up in the probe, or a low reading proves nothing. */
async function expectProbeDetectsBlock(app: ElectronApplication): Promise<void> {
  await startLagProbe(app);
  await app.evaluate((_electron, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* hold the main thread, as a synchronous child process would */ }
  }, BLOCK_MS);
  const control = await stopLagProbe(app);
  expect(control.maxMs, `control: the probe sees a ${BLOCK_MS} ms main-thread block`).toBeGreaterThanOrEqual(BLOCK_SEEN_MS);
}

interface PingStats { samples: number; maxMs: number; p95Ms: number }
interface PingState { rtts: number[]; stop: boolean; inFlightSince: number | null }

/** Starts a renderer loop that times a cheap `invoke` round trip every IPC_EVERY_MS. */
async function startIpcPing(win: Page): Promise<void> {
  await win.evaluate((every: number) => {
    const w = window as unknown as { api: Api; __ping?: PingState };
    if (w.__ping) w.__ping.stop = true;
    const ping: PingState = { rtts: [], stop: false, inFlightSince: null };
    w.__ping = ping;
    void (async () => {
      while (!ping.stop) {
        const t = performance.now();
        ping.inFlightSince = t;
        await w.api.invoke('app:get-version', undefined);
        ping.inFlightSince = null;
        ping.rtts.push(performance.now() - t);
        await new Promise((resolve) => setTimeout(resolve, every));
      }
    })();
  }, IPC_EVERY_MS);
}

/** Stops the ping loop; a request still in flight counts with its age so far. */
async function stopIpcPing(win: Page): Promise<PingStats> {
  return win.evaluate(() => {
    const w = window as unknown as { __ping?: PingState };
    const ping = w.__ping;
    if (!ping) throw new Error('ipc ping was never started');
    ping.stop = true;
    const rtts = [...ping.rtts];
    if (ping.inFlightSince !== null) rtts.push(performance.now() - ping.inFlightSince);
    const sorted = rtts.sort((a, b) => a - b);
    return {
      samples: sorted.length,
      maxMs: sorted[sorted.length - 1] ?? 0,
      p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0,
    };
  });
}

function report(testInfo: TestInfo, type: string, lag: LagStats, ping: PingStats): void {
  const description = `main lag max ${lag.maxMs.toFixed(1)} ms, p99 ${lag.p99Ms.toFixed(1)} ms, p95 ${lag.p95Ms.toFixed(1)} ms over ${lag.samples} ticks / ${lag.elapsedMs.toFixed(0)} ms; ` +
    `ipc rtt max ${ping.maxMs.toFixed(1)} ms, p95 ${ping.p95Ms.toFixed(1)} ms over ${ping.samples} pings`;
  testInfo.annotations.push({ type, description });
  console.log(`[${type}] ${description}`);
}

function expectResponsive(lag: LagStats, ping: PingStats): void {
  expect(lag.maxMs, `longest main-thread stall stays under ${MAX_LAG_MS} ms`).toBeLessThanOrEqual(MAX_LAG_MS);
  expect(lag.p99Ms, `p99 main-thread stall stays under ${P99_LAG_MS} ms`).toBeLessThanOrEqual(P99_LAG_MS);
  expect(ping.maxMs, `renderer→main invoke round trip stays under ${IPC_MAX_MS} ms`).toBeLessThanOrEqual(IPC_MAX_MS);
}

/* ═══════════════════════════════ flood: shells, script, output recorder ═══════════════════════════════ */

interface Flood { tag: string; shellIndex: number; visible: boolean }

/** A node script that writes FLOOD_LINES numbered lines, one write per line, paced over FLOOD_MS, then the final marker. */
function writeFloodScript(dir: string): string {
  const path = join(dir, 'flood.mjs');
  writeFileSync(path, [
    "import { writeSync } from 'node:fs';",
    'const [tag, linesArg, msArg] = process.argv.slice(2);',
    'const lines = Number(linesArg);',
    'const ms = Number(msArg);',
    `const pad = '${FLOOD_PAD}';`,
    'const pause = new Int32Array(new SharedArrayBuffer(4));',
    'const sleep = (t) => { if (t > 0) Atomics.wait(pause, 0, 0, t); };',
    // fd 1 is the PTY slave; writeSync is one write(2) per call. Never touch
    // process.stdout, which could switch the fd to non-blocking.
    'const put = (s) => { for (;;) { try { writeSync(1, s); return; } catch (e) { if (e.code !== "EAGAIN") throw e; sleep(1); } } };',
    'const t0 = performance.now();',
    'for (let i = 1; i <= lines; i++) {',
    '  sleep(t0 + (i * ms) / lines - performance.now());',
    "  put(`SEQ:${tag}:${String(i).padStart(6, '0')}:${pad}\\n`);",
    '}',
    'put(`FLOOD-DONE:${tag}:${lines}\\n`);',
  ].join('\n') + '\n');
  return path;
}

/** The command line typed into a shell. It contains neither `SEQ:` nor `FLOOD-DONE:`, so its echo can never satisfy an assertion. */
function floodCommand(script: string, tag: string): string {
  return `'${process.execPath}' '${script}' ${tag} ${FLOOD_LINES} ${FLOOD_MS}`;
}

async function launchPlain(win: Page, projId: number): Promise<number> {
  return win.evaluate(async (id: number) => {
    const api = (window as unknown as { api: Api }).api;
    return (await api.invoke('shells:launch-plain', { projectId: id }) as unknown as { shellIndex: number }).shellIndex;
  }, projId);
}

async function snapshot(win: Page, projId: number, shellIndex: number): Promise<string> {
  return win.evaluate(async (args: { projectId: number; shellIndex: number }) => {
    const api = (window as unknown as { api: Api }).api;
    return (await api.invoke('shells:snapshot', args) as unknown as { output: string }).output;
  }, { projectId: projId, shellIndex });
}

/**
 * Launches PROJ, opens it (shell 0 is mock-claude), then starts two plain
 * shells in the background and a third as the visible Shell tab — three
 * flooding shells plus the agent shell, under the default alive cap of 5.
 */
async function setupFloods(): Promise<{ win: Page; app: ElectronApplication; id: number; script: string; floods: Flood[] }> {
  h = await launch([PROJ]);
  const { win, app } = h;
  await openProject(win, PROJ);
  const id = await projectId(win, PROJ);
  const floods: Flood[] = [
    { tag: 'b', shellIndex: await launchPlain(win, id), visible: false },
    { tag: 'c', shellIndex: await launchPlain(win, id), visible: false },
  ];
  floods.unshift({ tag: 'a', shellIndex: await newShellTab(win, PROJ), visible: true });
  for (const f of floods) await waitForShell(win, id, f.shellIndex, '$');
  return { win, app, id, script: writeFloodScript(h.isolatedHome), floods };
}

interface ShellRecord { tag: string; total: number; next: number; carry: string; done: boolean; events: number; bytes: number; maxEvent: number; bad: string | null }
interface FloodRecorder { shells: Record<string, ShellRecord>; shapeBad: string | null; feed: (key: string, data: string) => void; off: () => void }
type ApiWithOn = Api & { on: (channel: string, cb: (payload: unknown) => void) => () => void };

/**
 * Subscribes to `pty:data` in the renderer and checks every byte each shell
 * delivers, incrementally: lines must be `SEQ:<that shell's tag>:<n>` for
 * n = 1, 2, 3, … with no gap, duplicate or reorder, then exactly the final
 * marker. Also checks every event keeps the `{ projectId, shellIndex, data }`
 * shape. `specs` maps `"<projectId>:<shellIndex>"` to a tag; `feed` lets the
 * control drive the same checker with crafted input.
 */
async function installFloodRecorder(win: Page, specs: Array<{ key: string; tag: string }>): Promise<void> {
  await win.evaluate(({ specs: list, total }) => {
    const w = window as unknown as { api: ApiWithOn; __flood?: FloodRecorder };
    w.__flood?.off();
    const shells: Record<string, ShellRecord> = {};
    for (const s of list) shells[s.key] = { tag: s.tag, total, next: 1, carry: '', done: false, events: 0, bytes: 0, maxEvent: 0, bad: null };
    const seq = /^SEQ:([a-z]+):(\d{6}):\.{24}$/;
    const feed = (key: string, data: string): void => {
      const s = shells[key];
      if (!s) return;
      s.events += 1;
      s.bytes += data.length;
      s.maxEvent = Math.max(s.maxEvent, data.length);
      const parts = (s.carry + data).split('\n');
      s.carry = parts.pop() ?? '';
      for (const raw of parts) {
        if (s.bad) return;
        const line = raw.replace(/\r$/, '');
        if (line.includes('FLOOD-DONE:')) {
          if (line !== `FLOOD-DONE:${s.tag}:${s.total}`) s.bad = `malformed or foreign final marker: ${JSON.stringify(line)}`;
          else if (s.next !== s.total + 1) s.bad = `final marker after ${s.next - 1} of ${s.total} lines`;
          else s.done = true;
          continue;
        }
        if (!line.includes('SEQ:')) continue;
        const m = seq.exec(line);
        if (!m) { s.bad = `malformed line: ${JSON.stringify(line.slice(0, 120))}`; continue; }
        if (m[1] !== s.tag) { s.bad = `line from shell ${String(m[1])} arrived on shell ${s.tag}`; continue; }
        if (s.done) { s.bad = `line ${String(m[2])} after the final marker`; continue; }
        const n = Number(m[2]);
        if (n !== s.next) { s.bad = `expected line ${s.next}, got ${n}`; continue; }
        s.next += 1;
      }
    };
    let shapeBad: string | null = null;
    const off = w.api.on('pty:data', (payload) => {
      const ev = payload as { projectId?: unknown; shellIndex?: unknown; data?: unknown; replayPosition?: unknown };
      const keys = Object.keys(ev).sort().join(',');
      if (keys !== 'data,projectId,replayPosition,shellIndex' || typeof ev.data !== 'string'
        || typeof ev.projectId !== 'number' || typeof ev.shellIndex !== 'number'
        || typeof ev.replayPosition !== 'number' || !Number.isSafeInteger(ev.replayPosition) || ev.replayPosition <= 0) {
        shapeBad ??= `unexpected pty:data payload: keys=${keys}`;
        return;
      }
      feed(`${ev.projectId}:${ev.shellIndex}`, ev.data);
    });
    w.__flood = {
      shells,
      get shapeBad() { return shapeBad; },
      feed,
      off,
    };
  }, { specs, total: FLOOD_LINES });
}

async function floodRecords(win: Page): Promise<{ shells: ShellRecord[]; shapeBad: string | null }> {
  return win.evaluate(() => {
    const w = window as unknown as { __flood?: FloodRecorder };
    const rec = w.__flood;
    if (!rec) throw new Error('flood recorder was never installed');
    // `carry` is at most one partial line, so returning it costs nothing.
    return { shells: Object.values(rec.shells), shapeBad: rec.shapeBad };
  });
}

/**
 * Positive control for the output checker: crafted streams with a gap, a
 * duplicate and a foreign shell's line must each be flagged, and a valid
 * stream split mid-line across events must be accepted. Run before the real
 * recorder is installed (installing resets it).
 */
async function expectRecorderDetectsCorruption(win: Page): Promise<void> {
  const keys = { gap: 'ctl:1', dup: 'ctl:2', mix: 'ctl:3', ok: 'ctl:4' };
  await installFloodRecorder(win, Object.entries(keys).map(([tag, key]) => ({ key, tag })));
  const valid = Array.from({ length: FLOOD_LINES }, (_, i) => `${seqLine('ok', i + 1)}\r\n`).join('') + `${doneLine('ok')}\r\n`;
  await win.evaluate(({ k, gap, dup, mix, valid: text }) => {
    const rec = (window as unknown as { __flood?: FloodRecorder }).__flood;
    if (!rec) throw new Error('flood recorder was never installed');
    rec.feed(k.gap, gap);
    rec.feed(k.dup, dup);
    rec.feed(k.mix, mix);
    // The valid stream arrives in uneven pieces that split lines and the \r\n pair.
    for (let i = 0; i < text.length; i += 4093) rec.feed(k.ok, text.slice(i, i + 4093));
  }, {
    k: keys,
    gap: `${seqLine('gap', 1)}\r\n${seqLine('gap', 3)}\r\n`,
    dup: `${seqLine('dup', 1)}\r\n${seqLine('dup', 1)}\r\n`,
    mix: `${seqLine('mix', 1)}\r\n${seqLine('zzz', 2)}\r\n`,
    valid,
  });
  const { shells } = await floodRecords(win);
  const byTag = new Map(shells.map((s) => [s.tag, s]));
  expect(byTag.get('gap')?.bad, 'control: a gap is flagged').toMatch(/expected line 2, got 3/);
  expect(byTag.get('dup')?.bad, 'control: a duplicate is flagged').toMatch(/expected line 2, got 1/);
  expect(byTag.get('mix')?.bad, 'control: a foreign shell\'s line is flagged').toMatch(/from shell zzz/);
  expect(byTag.get('ok')?.bad ?? null, 'control: a valid stream split mid-line is accepted').toBeNull();
  expect(byTag.get('ok')?.done, 'control: the valid stream reaches its final marker').toBe(true);
}

/** Types the flood command into every shell, then waits until the renderer has received every shell's final marker (or a violation). */
async function runFloods(win: Page, id: number, script: string, floods: Flood[]): Promise<number> {
  const t0 = Date.now();
  for (const f of floods) await sendLine(win, id, f.shellIndex, floodCommand(script, f.tag));
  await expect.poll(async () => {
    const { shells } = await floodRecords(win);
    return shells.every((s) => s.done || s.bad !== null);
  }, { timeout: 60_000, intervals: [250], message: 'every flooding shell delivers its final marker' }).toBe(true);
  return Date.now() - t0;
}

/** The visible Shell tab's xterm shows the flood's last numbered line directly above its final marker. */
async function expectVisibleTerminalEndsWith(win: Page, tag: string): Promise<void> {
  await expect.poll(async () => {
    const probes = await terminalProbes(win);
    for (const p of probes) {
      const lines = p.screen.split('\n');
      const at = lines.indexOf(doneLine(tag));
      if (at > 0) return lines[at - 1];
    }
    return `no visible terminal shows ${doneLine(tag)}`;
  }, { timeout: 20_000, message: `the visible terminal ends shell ${tag}'s flood in order` }).toBe(seqLine(tag, FLOOD_LINES));
}

/* ═══════════════════════════════ tests ═══════════════════════════════ */

test('main stays responsive while three shells stream many small chunks for several seconds', async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  const { win, app, id, script, floods } = await setupFloods();
  await expectProbeDetectsBlock(app);
  await installFloodRecorder(win, floods.map((f) => ({ key: `${id}:${f.shellIndex}`, tag: f.tag })));

  await startLagProbe(app);
  await startIpcPing(win);
  const floodMs = await runFloods(win, id, script, floods);
  const lag = await stopLagProbe(app);
  const ping = await stopIpcPing(win);
  report(testInfo, 'flood responsiveness', lag, ping);
  testInfo.annotations.push({ type: 'flood duration', description: `${floodMs} ms for ${floods.length} × ${FLOOD_LINES} lines paced over ${FLOOD_MS} ms` });

  // Positive controls: the load really ran, in full, for several seconds, while the probe was sampling.
  const { shells } = await floodRecords(win);
  for (const s of shells) {
    expect(s.bad, `shell ${s.tag} output is intact`).toBeNull();
    expect(s.done, `shell ${s.tag} delivered its final marker`).toBe(true);
    expect(s.bytes, `shell ${s.tag} streamed every line`).toBeGreaterThanOrEqual(FLOOD_LINES * FLOOD_LINE_BYTES);
  }
  expect(lag.elapsedMs, 'the probe sampled the whole multi-second flood').toBeGreaterThanOrEqual(FLOOD_MS * 0.9);
  await expectVisibleTerminalEndsWith(win, 'a');

  expectResponsive(lag, ping);
});

test('terminal output stays complete and in order when chunks are coalesced', async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  const { win, id, script, floods } = await setupFloods();
  await expectRecorderDetectsCorruption(win);
  await installFloodRecorder(win, floods.map((f) => ({ key: `${id}:${f.shellIndex}`, tag: f.tag })));

  await runFloods(win, id, script, floods);

  // Every byte the renderer received: each shell's lines 1…N exactly once, in order, then its marker; no foreign lines.
  const { shells, shapeBad } = await floodRecords(win);
  expect(shapeBad, 'every pty:data event carries its target, data, and desktop replay position').toBeNull();
  expect(shells.map((s) => s.tag).sort()).toEqual(floods.map((f) => f.tag).sort());
  for (const s of shells) {
    expect(s.bad, `shell ${s.tag}: no gap, duplicate, reorder or foreign line`).toBeNull();
    expect(s.next - 1, `shell ${s.tag}: every numbered line arrived`).toBe(FLOOD_LINES);
    expect(s.done, `shell ${s.tag}: the final marker arrived last`).toBe(true);
  }
  testInfo.annotations.push({
    type: 'pty:data events',
    description: shells.map((s) => `${s.tag}: ${s.events} events, largest ${s.maxEvent} chars`).join('; '),
  });

  // What the user sees: the visible terminal ends with line N then the marker.
  await expectVisibleTerminalEndsWith(win, 'a');
  // The main-process terminal mirror (what a remounting viewport replays) ends the same way for the background shells.
  for (const f of floods.filter((x) => !x.visible)) {
    const snap = await snapshot(win, id, f.shellIndex);
    const last = snap.lastIndexOf(seqLine(f.tag, FLOOD_LINES));
    const done = snap.lastIndexOf(doneLine(f.tag));
    expect(last, `shell ${f.tag} snapshot holds line ${FLOOD_LINES}`).toBeGreaterThanOrEqual(0);
    expect(done, `shell ${f.tag} snapshot holds the final marker after line ${FLOOD_LINES}`).toBeGreaterThan(last);
  }
});

/* ═══════════════════════════════ git: slow git, many untracked files ═══════════════════════════════ */

/**
 * A `git` shim that logs its arguments, sleeps GIT_DELAY_S, then execs the
 * real git. Self-checked here: it must resolve the real git, actually delay,
 * and pass output through, or the test could not tell a blocking call apart.
 */
function makeSlowGit(dir: string): { binDir: string; log: string } {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  if (!realGit.startsWith('/')) throw new Error(`main-responsive seed self-check failed: git is not on PATH as an absolute path (${realGit})`);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const log = join(dir, 'git-calls.log');
  const shim = join(binDir, 'git');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nsleep ${GIT_DELAY_S}\nexec '${realGit}' "$@"\n`);
  chmodSync(shim, 0o755);
  const t0 = Date.now();
  const out = execFileSync(shim, ['--version'], { encoding: 'utf8' });
  const took = Date.now() - t0;
  if (!/^git version /.test(out)) throw new Error(`main-responsive seed self-check failed: the git shim does not pass output through: ${out}`);
  if (took < GIT_DELAY_S * 1000 * 0.9) throw new Error(`main-responsive seed self-check failed: the git shim returned in ${took} ms, not ≥ ${GIT_DELAY_S * 1000} ms`);
  if (!readFileSync(log, 'utf8').includes('--version')) throw new Error('main-responsive seed self-check failed: the git shim does not log its calls');
  writeFileSync(log, '');
  return { binDir, log };
}

/**
 * Puts `binDir` first on the main process's own PATH. Setting it in the launch
 * env is not enough: at startup main replaces PATH with the login shell's
 * (`resolveLoginShellPath`), where macOS `path_helper` moves the system dirs
 * in front. Runs after `launch()`, which resolves only once the window is up,
 * i.e. after that startup step. The shim-call control below proves it took.
 */
async function prependMainPath(app: ElectronApplication, binDir: string): Promise<void> {
  const path = await app.evaluate((_electron, dir: string) => {
    process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
    return process.env.PATH;
  }, binDir);
  if (!path.startsWith(`${binDir}:`)) throw new Error(`main-responsive seed self-check failed: main PATH does not start with the git shim dir: ${path}`);
}

/** A real repository: one commit, then UNTRACKED untracked files across 40 folders. Self-checked against git's own porcelain. */
function seedUntracked(dir: string): void {
  initRepo(dir);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  commitAll(dir, 'baseline');
  for (let i = 0; i < UNTRACKED; i++) {
    const path = join(dir, 'many', `d${String(i % 40).padStart(2, '0')}`, `f${String(i).padStart(4, '0')}.txt`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${i}\n`);
  }
  const entries = porcelain(dir);
  if (entries.length !== UNTRACKED || entries.some((e) => e.xy !== '??')) {
    throw new Error(`main-responsive seed self-check failed: expected ${UNTRACKED} untracked entries, git printed ${entries.length}: ${JSON.stringify(entries.slice(0, 5))}`);
  }
}

/** Status calls the app made through the shim: app-wide `git:status` (no -z) and the Diff panel's `git:panel-status` (-z). */
function statusCalls(log: string): { appWide: number; panel: number } {
  const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => / status /.test(` ${l} `)) : [];
  return { appWide: lines.filter((l) => !/(^| )-z( |$)/.test(l)).length, panel: lines.filter((l) => /(^| )-z( |$)/.test(l)).length };
}

test('main stays responsive while git status polls a repo with many untracked files and git is slow; the git UI still reports status', async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  scratch = mkdtempSync(join(tmpdir(), 'metaide-slowgit-'));
  const { binDir, log } = makeSlowGit(scratch);
  h = await launch([PROJ]);
  const { win, app } = h;
  await prependMainPath(app, binDir);
  const dir = join(h.demoRoot, PROJ);
  seedUntracked(dir);
  await expectProbeDetectsBlock(app);

  await startLagProbe(app);
  await startIpcPing(win);
  const before = statusCalls(log);
  await openProject(win, PROJ);

  // The git UI reports the real status: the tab count and the activity-bar label carry the untracked count.
  const count = win.getByTestId(DIFF_TESTIDS.tabCount);
  await expect(count).toHaveText(new RegExp(`(^|\\D)${UNTRACKED}(\\D|$)`), { timeout: 15_000 });
  await expect(win.getByTestId('ab-git')).toHaveAttribute('aria-label', `Git — ${UNTRACKED} changed`);

  // The Diff tab polls git:panel-status too; it lists the files without an error.
  await win.getByTestId(DIFF_TESTIDS.tab).click();
  const panel = win.getByTestId(DIFF_TESTIDS.panel);
  await expect(panel).toBeVisible();
  await expect(panel.getByText(DIFF_COPY.loadingList, { exact: true })).toHaveCount(0, { timeout: 15_000 });
  await expect(panel.getByTestId(DIFF_TESTIDS.error)).toHaveCount(0);
  await expect(panel.locator(`[data-testid="${DIFF_TESTIDS.row}"][data-path="many/d00/f0000.txt"]`)).toBeVisible();

  // Polling stays live: a file created now shows up in both pollers' results.
  writeFileSync(join(dir, 'late.txt'), 'late\n');
  await expect(panel.locator(`[data-testid="${DIFF_TESTIDS.row}"][data-path="late.txt"]`)).toBeVisible({ timeout: 15_000 });
  await expect(count).toHaveText(new RegExp(`(^|\\D)${UNTRACKED + 1}(\\D|$)`), { timeout: 15_000 });

  // Positive control: both pollers ran repeatedly through the slowed git while the probe sampled.
  await expect.poll(() => {
    const now = statusCalls(log);
    return Math.min(now.appWide - before.appWide, now.panel - before.panel);
  }, { timeout: 30_000, message: 'the app ran git:status and git:panel-status at least twice each through the slowed git' })
    .toBeGreaterThanOrEqual(2);

  const lag = await stopLagProbe(app);
  const ping = await stopIpcPing(win);
  report(testInfo, 'git polling responsiveness', lag, ping);
  const calls = statusCalls(log);
  testInfo.annotations.push({
    type: 'slowed git status calls',
    description: `${calls.appWide - before.appWide} git:status + ${calls.panel - before.panel} git:panel-status, each ≥ ${GIT_DELAY_S * 1000} ms`,
  });

  expectResponsive(lag, ping);
});
