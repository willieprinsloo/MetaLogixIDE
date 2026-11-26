/**
 * Frame sampling for motion assertions (split-shell-cards spec, Amendment 2,
 * AC42–AC58). A requestAnimationFrame loop in the page records, for each
 * named target, its box, computed clip-path / transform / opacity and inline
 * opacity, once per frame, so assertions read what was laid out each frame
 * instead of how the animation was requested.
 *
 * A target is a CSS selector, optionally followed by `^` characters: each
 * `^` walks one `parentElement` up from the first match (e.g.
 * `[data-testid="split-right"]^^` is split-right's grandparent). `count`
 * is the number of matches of the bare selector, so a frame with two right
 * panes shows `count: 2`.
 *
 * Timestamps are `performance.timeOrigin` + the rAF frame timestamp, i.e.
 * wall-clock milliseconds comparable with `Date.now()` in the main process.
 */

import type { ElectronApplication, Page } from '@playwright/test';

export interface TargetSample {
  present: boolean;
  count: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Computed padding-left + padding-right (to get a row's content width). */
  padX: number;
  clip: string;
  transform: string;
  opacity: number;
  /** The element's inline `style.opacity`, '' when unset. */
  inlineOpacity: string;
  /** Its `aria-pressed` and `data-testid` attributes (null when absent). */
  pressed: string | null;
  testid: string | null;
}

export interface Frame {
  /** Wall-clock ms (performance.timeOrigin + now). */
  t: number;
  s: Record<string, TargetSample>;
}

const ABSENT: TargetSample = {
  present: false, count: 0, x: 0, y: 0, w: 0, h: 0, padX: 0, clip: 'none', transform: 'none', opacity: 0, inlineOpacity: '', pressed: null, testid: null,
};

/**
 * Starts sampling `targets` every animation frame for `ms` milliseconds.
 * Replaces any sampling still running. Collect with `collectFrames`.
 */
export async function startFrames(win: Page, targets: Record<string, string>, ms: number): Promise<void> {
  await win.evaluate(({ targets, ms, absent }) => {
    type W = { __e2eFrames?: { frames: unknown[]; done: boolean; stop: boolean } };
    const w = window as unknown as W;
    if (w.__e2eFrames) w.__e2eFrames.stop = true;
    const run = { frames: [] as unknown[], done: false, stop: false };
    w.__e2eFrames = run;
    const resolve = (spec: string): { el: Element | null; count: number } => {
      const m = /^([\s\S]*?)(\^*)$/.exec(spec)!;
      const all = document.querySelectorAll(m[1]!);
      let el: Element | null = all[0] ?? null;
      for (let i = 0; i < m[2]!.length && el; i++) el = el.parentElement;
      return { el, count: all.length };
    };
    const now = () => performance.timeOrigin + performance.now();
    const end = now() + ms;
    // `ts` is the frame's start time, shared by every rAF callback of that frame (motion's included), so it
    // dates a sample by its frame rather than by when this callback happened to run.
    const tick = (ts: number) => {
      if (run.stop) { run.done = true; return; }
      const s: Record<string, unknown> = {};
      for (const [name, spec] of Object.entries(targets)) {
        const { el, count } = resolve(spec);
        if (!el) { s[name] = { ...absent, count }; continue; }
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        s[name] = {
          present: true,
          count,
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          padX: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
          clip: cs.clipPath,
          transform: cs.transform,
          opacity: parseFloat(cs.opacity),
          inlineOpacity: (el as HTMLElement).style?.opacity ?? '',
          pressed: el.getAttribute('aria-pressed'),
          testid: el.getAttribute('data-testid'),
        };
      }
      run.frames.push({ t: performance.timeOrigin + ts, s });
      if (run.frames.length === 2) baseline();
      if (now() < end) requestAnimationFrame(tick);
      else run.done = true;
    };
    // Resolve only once two frames are recorded, so the trigger that follows always has a baseline frame before it.
    let baseline = () => {};
    const ready = new Promise<void>((r) => { baseline = r; });
    requestAnimationFrame(tick);
    return ready;
  }, { targets, ms, absent: ABSENT });
}

/** Waits for the running sampling to finish and returns its frames. */
export async function collectFrames(win: Page): Promise<Frame[]> {
  await win.waitForFunction(() => (window as unknown as { __e2eFrames?: { done: boolean } }).__e2eFrames?.done === true,
    undefined, { timeout: 15000 });
  return win.evaluate(() => (window as unknown as { __e2eFrames: { frames: Frame[] } }).__e2eFrames.frames);
}

/** Samples `targets` for `ms` while `trigger` runs, and returns the frames. */
export async function sampleDuring(
  win: Page, targets: Record<string, string>, ms: number, trigger: () => Promise<void>,
): Promise<Frame[]> {
  await startFrames(win, targets, ms);
  await trigger();
  return collectFrames(win);
}

/** The width of a target's content box in a frame (border box minus horizontal padding). */
export function contentWidth(s: TargetSample): number {
  return s.w - s.padX;
}

/** A compact, one-line-per-frame log of chosen fields (runs of identical frames collapsed), for failure messages and the report. */
export function frameLog(frames: Frame[], fields: Array<[string, keyof TargetSample]>): string {
  const t0 = frames[0]?.t ?? 0;
  const out: string[] = [];
  let prev = '';
  let run = 0;
  for (const f of frames) {
    const cols = fields.map(([name, k]) => {
      const v = f.s[name]?.[k];
      return `${name}.${k}=${typeof v === 'number' ? Math.round(v * 100) / 100 : String(v)}`;
    }).join(' ');
    if (cols === prev) { run++; continue; }
    if (run) out.push(`  … same ×${run}`);
    run = 0;
    prev = cols;
    out.push(`${Math.round(f.t - t0)}ms ${cols}`);
  }
  if (run) out.push(`  … same ×${run}`);
  return out.join('\n');
}

/**
 * Records every insertion of an element matching `selector` (or containing
 * one) from now on, via a MutationObserver — catches an element that exists
 * for less than one frame. Read with `insertions`.
 */
export async function recordInsertions(win: Page, key: string, selector: string): Promise<void> {
  await win.evaluate(({ key, selector }) => {
    type W = { __e2eInsertions?: Record<string, { list: string[]; obs: MutationObserver }> };
    const w = window as unknown as W;
    w.__e2eInsertions ??= {};
    w.__e2eInsertions[key]?.obs.disconnect();
    const list: string[] = [];
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          const hits = n.matches(selector) ? [n] : [...n.querySelectorAll(selector)];
          for (const h of hits) list.push(h.outerHTML.slice(0, 160));
        }
        if (r.type === 'attributes' && r.target instanceof Element && r.target.matches(selector)) {
          list.push(r.target.outerHTML.slice(0, 160));
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
    w.__e2eInsertions[key] = { list, obs };
  }, { key, selector });
}

/** Elements matching the recorded selector that were inserted (or gained a matching attribute) since `recordInsertions`. */
export async function insertions(win: Page, key: string): Promise<string[]> {
  return win.evaluate((key) => {
    const w = window as unknown as { __e2eInsertions?: Record<string, { list: string[] }> };
    return [...(w.__e2eInsertions?.[key]?.list ?? [])];
  }, key);
}

/**
 * Wraps every registered `ipcMain.handle` handler in the main process so
 * each invoke is logged with its channel, request and wall-clock time.
 * Read with `ipcLog`. Handlers registered after this call are not wrapped.
 */
export async function recordIpc(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown;
    const g = globalThis as unknown as { __e2eIpc?: Array<{ ch: string; req: unknown; t: number }>; __e2eIpcWrapped?: boolean };
    g.__e2eIpc = [];
    if (g.__e2eIpcWrapped) return;
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })._invokeHandlers;
    if (!handlers) throw new Error('recordIpc: ipcMain._invokeHandlers missing (Electron internals changed?)');
    for (const [ch, fn] of [...handlers.entries()]) {
      handlers.set(ch, (event, ...args) => {
        g.__e2eIpc!.push({ ch, req: args[0], t: Date.now() });
        return fn(event, ...args);
      });
    }
    g.__e2eIpcWrapped = true;
  });
}

export interface IpcCall { ch: string; req: unknown; t: number }

/** Invokes logged since the last `recordIpc`. */
export async function ipcLog(app: ElectronApplication): Promise<IpcCall[]> {
  return app.evaluate(() => [...((globalThis as unknown as { __e2eIpc?: IpcCall[] }).__e2eIpc ?? [])]);
}

/** Starts recording the wall-clock time of every keydown (capture phase) in the page. Read with `keydownTimes`. */
export async function recordKeydowns(win: Page): Promise<void> {
  await win.evaluate(() => {
    const w = window as unknown as { __e2eKeys?: Array<{ key: string; t: number }>; __e2eKeysOn?: boolean };
    w.__e2eKeys = [];
    if (w.__e2eKeysOn) return;
    w.__e2eKeysOn = true;
    window.addEventListener('keydown', (e) => { w.__e2eKeys!.push({ key: e.key, t: performance.timeOrigin + performance.now() }); }, true);
  });
}

export async function keydownTimes(win: Page): Promise<Array<{ key: string; t: number }>> {
  return win.evaluate(() => [...((window as unknown as { __e2eKeys?: Array<{ key: string; t: number }> }).__e2eKeys ?? [])]);
}

/** Scale and translation of a computed `transform` ('none' → identity). */
export function transformParts(transform: string): { scaleX: number; scaleY: number; tx: number; ty: number } {
  if (!transform || transform === 'none') return { scaleX: 1, scaleY: 1, tx: 0, ty: 0 };
  const m = /matrix\(([^)]+)\)/.exec(transform);
  if (!m) throw new Error(`unparsed transform: ${transform}`);
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m[1]!.split(',').map(Number);
  return { scaleX: Math.hypot(a, b), scaleY: Math.hypot(c, d), tx: e, ty: f };
}
